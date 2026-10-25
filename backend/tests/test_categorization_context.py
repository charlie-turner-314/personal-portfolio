"""Retrieval correctness, isolation, evidence availability and response validation."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from types import SimpleNamespace as NS
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from app.models import Account, Category, Transaction, User
from app.services.categorization_context import CategorizationContext, EmbeddingRanker, transaction_record
from app.services.category_matcher import CategoryMatcher


def category(id="food", name="Groceries", kind="expense"):
    return NS(id=id, name=name, category_type=kind, description="Food shops")


def example(id="past", label="food", **kwargs):
    return dict(id=id, category_id=label, description="ALDI groceries", merchant="ALDI",
                amount=-25, transaction_type="debit", currency="EUR", account_id="checking",
                updated_at=datetime(2026, 10, 20), **kwargs)


def target(**kwargs):
    return {**example(id="target"), **kwargs}


def test_retrieves_relevant_diverse_examples_excludes_target_and_batch():
    rows = [example(id="target"), example(id="other-target"), example(id="duplicate"),
            example(id="same-label"), example(id="contrast", label="shopping"),
            {**example(id="unrelated"), "merchant": "Shell", "description": "Diesel fuel"}]
    ctx = CategorizationContext(None, "user", [category(), category("shopping", "Shopping")], examples=rows)
    found = ctx.retrieve(target(), exclude_ids=["other-target"])
    ids = {r["id"] for r in found}
    assert "target" not in ids and "other-target" not in ids
    assert "contrast" in ids and "unrelated" not in ids
    assert len([r for r in found if r["category_id"] == "food"]) == 1


def test_availability_cutoff_uses_verification_not_booking_time():
    ctx = CategorizationContext(None, "user", [category()], examples=[
        {**example(), "booked_at": datetime(2020, 1, 1), "verified_at": datetime(2026, 10, 20)},
    ])
    assert not ctx.retrieve(target(), as_of=datetime(2026, 10, 19))
    assert ctx.retrieve(target(), as_of=datetime(2026, 10, 21, tzinfo=timezone.utc))


def test_same_account_and_recency_do_not_retrieve_irrelevant_examples():
    ctx = CategorizationContext(None, "user", [category()], examples=[example()])
    assert not ctx.retrieve(target(merchant="Shell", description="Diesel fuel"))


def test_filters_category_direction_and_removed_categories():
    rows = [{**example(label="salary"), "transaction_type": "credit", "amount": 25},
            example(id="removed", label="deleted"), example(id="transfer", label="transfer")]
    ctx = CategorizationContext(None, "user", [category("salary", "Salary", "income"), category("transfer", "Transfer", "transfer")], examples=rows)
    assert [r["id"] for r in ctx.retrieve(target())] == ["transfer"]


def test_render_preserves_positive_and_negative_labels_and_bounds_json():
    row = {**example(), "category_system_id": "shopping", "categorization_instructions": "Food for home"}
    ctx = CategorizationContext(None, "user", [category(), category("shopping", "Shopping")], examples=[row])
    text = ctx.render(target())
    record = next(row for line in text.splitlines() if (row := json.loads(line))["kind"] == "verified_precedent")
    assert record["accepted_category"] == "Groceries"
    assert record["rejected_category"] == "Shopping"
    assert record["guidance"] == "Food for home"
    assert len(text) <= ctx.MAX_RENDERED_CHARS


def test_semantic_retrieval_can_find_different_surface_words():
    class Semantic:
        def similarities(self, target, examples):
            return [0.9]
    ctx = CategorizationContext(None, "user", [category()], ranker=Semantic(), examples=[example()])
    assert ctx.retrieve(target(merchant="Neighbourhood produce", description="Vegetables and fruit"))


def test_embedding_failure_falls_back_and_does_not_log_metadata(caplog):
    client = MagicMock()
    client.embeddings.create.side_effect = RuntimeError("secret merchant metadata")
    ranker = EmbeddingRanker(lambda: client, "text-embedding-3-small")
    ctx = CategorizationContext(None, "user", [category()], ranker=ranker, examples=[example()])
    assert ctx.retrieve(target())
    assert ctx.retrieve(target())
    client.embeddings.create.assert_called_once()
    assert "secret merchant" not in caplog.text


def test_embedding_cache_indexes_out_of_order_provider_results():
    client = MagicMock()
    client.embeddings.create.return_value = NS(data=[NS(index=1, embedding=[1., 0.]), NS(index=0, embedding=[1., 0.])], usage=NS(total_tokens=12))
    ranker = EmbeddingRanker(lambda: client, "text-embedding-3-small")
    query = target(merchant="different", description="produce")
    assert ranker.similarities(query, [example()]) == [1.0]
    assert ranker.similarities(query, [example()]) == [1.0]
    assert ranker.tokens_used == 12
    client.embeddings.create.assert_called_once()


@pytest.fixture
def history(db_session):
    uid = "ctx-" + uuid4().hex
    db_session.add(User(id=uid, email=uid + "@example.com", name="Context test"))
    db_session.flush()
    accounts = [Account(user_id=uid, name=n, account_type="checking", currency="EUR") for n in ("Checking", "Savings")]
    cats = [Category(user_id=uid, name=n, category_type=k) for n, k in (("Groceries", "expense"), ("Salary", "income"), ("Transfer", "transfer"))]
    db_session.add_all(accounts + cats)
    db_session.flush()
    return uid, accounts, cats


def add_tx(db, uid, account, **kwargs):
    data = dict(user_id=uid, account_id=account.id, amount=Decimal("-25"), currency="EUR",
                description="ALDI groceries", merchant="ALDI", transaction_type="debit",
                booked_at=datetime(2026, 10, 20), pending=False)
    db.add(tx := Transaction(**{**data, **kwargs}))
    db.flush()
    return tx


def test_database_history_is_user_scoped_manual_only_including_confirmations(db_session, history):
    uid, accounts, cats = history
    manual = add_tx(db_session, uid, accounts[0], category_id=cats[0].id, category_system_id=cats[0].id, category_verified_at=datetime(2026, 10, 24))
    # Legacy imports copied AI predictions into both fields without review.
    add_tx(db_session, uid, accounts[0], category_id=cats[0].id, category_system_id=cats[0].id)
    add_tx(db_session, uid, accounts[0], category_system_id=cats[0].id)
    add_tx(db_session, uid, accounts[0], category_id=cats[0].id, pending=True)
    other = "ctx-other-" + uuid4().hex
    db_session.add(User(id=other, email=other + "@example.com"))
    db_session.flush()
    add_tx(db_session, other, accounts[0], category_id=cats[0].id)
    ctx = CategorizationContext(db_session, uid, cats)
    assert [row["id"] for row in ctx.examples()] == [manual.id]
    # Manual precedents no longer become unconditional exact-merchant overrides.
    matcher = CategoryMatcher(db_session, user_id=uid)
    assert matcher.user_overrides == []


def test_counterparts_require_other_account_currency_direction_and_time(db_session, history):
    uid, accounts, cats = history
    valid = add_tx(db_session, uid, accounts[1], amount=25, transaction_type="credit")
    add_tx(db_session, uid, accounts[0], amount=25, transaction_type="credit")
    add_tx(db_session, uid, accounts[1], amount=25, transaction_type="credit", currency="USD")
    add_tx(db_session, uid, accounts[1], amount=25, transaction_type="credit", booked_at=datetime(2026, 9, 1))
    add_tx(db_session, uid, accounts[1], amount=25, transaction_type="credit", pending=True)
    add_tx(db_session, uid, accounts[1], amount=25, transaction_type="credit", category_id=cats[1].id)
    add_tx(db_session, uid, accounts[1], amount=-25, transaction_type="debit")
    ctx = CategorizationContext(db_session, uid, cats)
    query = target(account_id=accounts[0].id, booked_at=datetime(2026, 10, 20))
    assert [r["id"] for r in ctx.counterparts(query)] == [valid.id]
    assert not ctx.counterparts({**query, "currency": None})
    assert not ctx.counterparts(query, as_of=datetime(2020, 1, 1))
    assert db_session.query(Transaction).filter_by(id=valid.id).one().internal_transfer_id is None


@pytest.mark.parametrize("reply", ["0|Salary|99", "99|Groceries|99", "0|Groceries|90\n0|Groceries|80", "0|Groceries|90\n0|UNKNOWN|0"])
def test_batch_rejects_wrong_type_unrequested_and_duplicate_indexes(reply):
    matcher = CategoryMatcher(MagicMock(), user_id="user", auto_load_from_db=False)
    matcher._category_cache = {"groceries": category(), "salary": category("salary", "Salary", "income")}
    matcher._account_cache = []
    matcher._context_retriever = CategorizationContext(None, "user", list(matcher._category_cache.values()), examples=[])
    client = MagicMock()
    client.chat.completions.create.return_value = NS(choices=[NS(message=NS(content=reply))], usage=NS(prompt_tokens=10, completion_tokens=5, total_tokens=15))
    matcher._openai_client = client
    results, tokens, _ = matcher.match_categories_batch_llm([{"index": 0, "description": "ALDI", "amount": -25}])
    assert not results
    assert tokens == 15


@pytest.mark.parametrize("reply,valid", [
    ("10|Groceries|90", True), ("INDEX 10|Groceries|90", True),
    ("index10|Groceries|90", True), ("INDEX|Groceries|90", False),
    ("INDEX 11|Groceries|90", False), ("row 10|Groceries|90", False),
    ("INDEX 10 11|Groceries|90", False),
    ("10|Groceries|90\nINDEX 10|Groceries|99", False),
])
def test_provider_index_prefix_keeps_requested_id_and_duplicate_guards(reply, valid):
    matcher = CategoryMatcher(MagicMock(), user_id="user", auto_load_from_db=False)
    matcher.context_enabled = False
    matcher._category_cache = {"groceries": category()}
    matcher._account_cache = []
    client = MagicMock()
    client.chat.completions.create.return_value = NS(choices=[NS(message=NS(content=reply))], usage=NS(prompt_tokens=10, completion_tokens=5, total_tokens=15))
    matcher._openai_client = client
    results, _, _ = matcher.match_categories_batch_llm([{"index": 10, "description": "ALDI", "amount": -25}])
    assert bool(results) == valid
    if valid: assert list(results) == [10]


@pytest.fixture(autouse=True)
def opt_in_context(monkeypatch):
    monkeypatch.setenv("CATEGORIZER_CONTEXT_ENABLED", "true")


def test_single_and_batch_prompts_share_targeted_evidence_and_descriptions():
    matcher = CategoryMatcher(MagicMock(), user_id="user", auto_load_from_db=False)
    cats = [category(), category("shopping", "Shopping")]
    matcher._category_cache = {cat.name.lower(): cat for cat in cats}
    matcher._account_cache = []
    matcher._context_retriever = CategorizationContext(None, "user", cats, examples=[{**example(), "category_system_id": "shopping"}, example(id="target")])
    one = matcher._single_prompt(target(), cats)
    many = matcher._batch_prompt([{**target(), "index": 0}], ["target"])
    for text in (one, many):
        assert "Food shops" in text and '"rejected_category":"Shopping"' in text
        assert '"transaction_id":"target"' not in text
    assert "uncalibrated" in many


@pytest.mark.parametrize("preselected", [False, True])
def test_import_distinguishes_automatic_labels_from_user_decisions(db_session, history, monkeypatch, preselected):
    from app.routes.transaction_import import import_transactions, TransactionImportItem, TransactionImportRequest
    import app.routes.categories as routes
    import app.routes.transaction_import as import_routes
    uid, accounts, cats = history
    monkeypatch.setattr(import_routes, "get_user_id", lambda requested_user_id: uid)
    seen = {}
    def classify(request, db, user_id):
        seen["input"] = request
        return NS(results=[NS(category_id=cats[0].id)], categorized_count=1, uncategorized_count=0,
                  total_transactions=1, deterministic_count=0, llm_count=1, total_tokens_used=20, total_cost_usd=0.001)
    monkeypatch.setattr(routes, "categorize_transactions_batch", classify)
    request = TransactionImportRequest(
        user_id=uid, sync_exchange_rates=False, update_functional_amounts=False,
        calculate_balances=False, detect_subscriptions=False,
        transactions=[TransactionImportItem(account_id=accounts[0].id, amount=-25,
            description="ALDI", merchant="ALDI", booked_at=datetime(2026, 10, 20), transaction_type="debit",
            currency="EUR", category_id=cats[0].id if preselected else None)],
    )
    response = import_transactions(request, db_session)
    assert response.success
    row = db_session.query(Transaction).filter_by(user_id=uid).one()
    if preselected:
        assert row.category_id == cats[0].id and row.category_verified_at is not None
        assert row.category_system_id is None and "input" not in seen
    else:
        assert row.category_system_id == cats[0].id
        assert row.category_id is None and row.category_verified_at is None
        captured = seen["input"].transactions[0]
        assert captured.account_id == accounts[0].id and captured.currency == "EUR"
        assert captured.booked_at == datetime(2026, 10, 20)
        assert seen["input"].user_overrides is None


def test_account_names_and_types_are_resolved_for_targets_and_evidence():
    accounts = [NS(id="checking", name="Daily spending", account_type="checking", currency="EUR"),
                NS(id="savings", name="House deposit", account_type="savings", currency="EUR")]
    matcher = CategoryMatcher(MagicMock(), user_id="user", auto_load_from_db=False)
    matcher._account_cache = accounts
    matcher._category_cache = {"groceries": category()}
    query = target(booked_at=datetime(2026, 10, 20))
    opposite = {**example(id="counterpart"), "account_id": "savings", "amount": 25,
                "transaction_type": "credit", "booked_at": datetime(2026, 10, 21)}
    matcher._context_retriever = CategorizationContext(None, "user", [category()], accounts=accounts, examples=[example()], transactions=[opposite])
    for prompt in (matcher._single_prompt(query, [category()]), matcher._batch_prompt([{**query, "index": 0}])):
        assert "Daily spending" in prompt and "House deposit" in prompt
        assert '"name":"House deposit"' in prompt
        assert '"type":"savings"' in prompt
        assert '"account"' in prompt


def test_later_counterparts_only_reconsider_unresolved_rows(db_session, history, monkeypatch):
    from tasks.post_import_pipeline import _batch_categorize_transactions
    uid, accounts, cats = history
    older = add_tx(db_session, uid, accounts[0])
    current = add_tx(db_session, uid, accounts[1], amount=25, transaction_type="credit", booked_at=datetime(2026, 10, 21))
    manual = add_tx(db_session, uid, accounts[0], category_id=cats[0].id)
    automatic = add_tx(db_session, uid, accounts[0], category_system_id=cats[0].id)
    hidden = add_tx(db_session, uid, accounts[0], include_in_analytics=False)
    pending = add_tx(db_session, uid, accounts[0], pending=True)
    add_tx(db_session, uid, accounts[0], currency="USD")
    add_tx(db_session, uid, accounts[1])
    ctx = CategorizationContext(db_session, uid, cats)
    assert ctx.reconsideration_ids([transaction_record(current)]) == [older.id]
    captured = []
    def classify(self, batch, **kwargs):
        captured.extend(batch)
        return {row["index"]: (cats[2], None) for row in batch}, 20, .001
    monkeypatch.setattr(CategoryMatcher, "_get_openai_client", lambda self: NS())
    monkeypatch.setattr(CategoryMatcher, "match_categories_batch_llm", classify)
    _batch_categorize_transactions(db_session, uid, [str(current.id)])
    assert {str(row["id"]) for row in captured} == {str(current.id), str(older.id)}
    assert older.category_system_id == cats[2].id
    assert current.category_system_id == cats[2].id
    assert manual.category_id == cats[0].id
    assert automatic.category_system_id == cats[0].id
    assert hidden.category_system_id is None and pending.category_system_id is None


@pytest.mark.parametrize("support", ["refund_word", "reviewed_precedent", "none", "other_account", "other_merchant"])
def test_refund_category_exceptions_need_explicit_context(support):
    matcher = CategoryMatcher(MagicMock(), user_id="user", auto_load_from_db=False)
    cats = [category(), category("salary", "Salary", "income")]
    matcher._category_cache = {cat.name.lower(): cat for cat in cats}
    matcher._account_cache = []
    incoming = target(amount=25, transaction_type="credit", description="ALDI refund" if support == "refund_word" else "ALDI")
    rows = [] if support in {"none", "refund_word"} else [
        {**example(id="reviewed-credit"), "amount": 15, "transaction_type": "credit",
         "account_id": "other" if support == "other_account" else "checking",
         "merchant": "Other shop" if support == "other_merchant" else "ALDI"},
    ]
    matcher._context_retriever = CategorizationContext(None, "user", cats, examples=rows)
    client = MagicMock()
    client.chat.completions.create.return_value = NS(choices=[NS(message=NS(content="0|Groceries|90"))], usage=NS(prompt_tokens=10, completion_tokens=5, total_tokens=15))
    matcher._openai_client = client
    result, _, _ = matcher.match_categories_batch_llm([{**incoming, "index": 0}])
    supported = support in {"refund_word", "reviewed_precedent"}
    assert (0 in result) is supported
    # The single path uses the same category permission policy.
    client.chat.completions.create.return_value.choices[0].message.content = "Groceries"
    single = matcher.match_category_llm(incoming["description"], incoming["merchant"], 25, cats,
                                        transaction_type="credit", context={"account_id": "checking"})
    assert (single is not None) is supported


def test_prompt_budget_preserves_precedents_alongside_verbose_counterparts():
    query = target(booked_at=datetime(2026, 10, 20))
    verbose = {key: "x" * 240 for key in ("description", "merchant", "creditor", "debtor")}
    candidates = [{**example(id=f"other-{index}"), **verbose, "account_id": "savings", "amount": 25,
                   "transaction_type": "credit", "booked_at": datetime(2026, 10, 21)} for index in range(4)]
    ctx = CategorizationContext(None, "user", [category()], examples=[example()], transactions=candidates)
    rendered = ctx.render(query)
    records = [json.loads(line) for line in rendered.splitlines()]
    summary = records[0]
    assert summary["precedents_shown"] == 1
    assert summary["counterparts_selected"] == 4
    assert summary["counterpart_limit_reached"] is True
    assert any(row["kind"] == "possible_transfer_counterpart" for row in records)
    assert len(rendered) <= ctx.MAX_RENDERED_CHARS
