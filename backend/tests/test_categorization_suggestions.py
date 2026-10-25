from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace as NS
from unittest.mock import Mock
from uuid import uuid4

from fastapi import HTTPException
import pytest

from app.models import Account, Category, CategorizationSuggestion, Transaction, User
from app.services import categorization_suggestions as service


@pytest.fixture
def trial(db_session, monkeypatch):
    monkeypatch.setenv("CATEGORIZER_SUGGESTIONS_ENABLED", "true")
    uid, other = "trial-" + uuid4().hex, "other-" + uuid4().hex
    db_session.add_all([User(id=uid, email=uid + "@example.test"), User(id=other, email=other + "@example.test")])
    db_session.flush()
    account = Account(user_id=uid, name="Daily", account_type="checking", currency="AUD")
    categories = [Category(user_id=uid, name="Food", category_type="expense"),
                  Category(user_id=uid, name="Transfer", category_type="transfer"),
                  Category(user_id=other, name="Private", category_type="expense")]
    db_session.add_all([account, *categories]); db_session.flush()
    tx = Transaction(user_id=uid, account_id=account.id, amount=-25, currency="AUD", description="Shop",
                     booked_at=datetime(2026, 10, 25), transaction_type="debit", pending=False,
                     category_system_id=categories[0].id)
    db_session.add(tx); db_session.flush()
    matcher = NS(LLM_MODEL="qwen3:8b", _get_context_retriever=lambda: NS(), last_batch_failures=0, inference_trace=[], last_context={0: '{"kind":"evidence_summary"}'},
                 _get_openai_client=lambda: NS(), _load_categories=lambda: {c.name: c for c in categories[:2]})
    matcher.match_categories_batch_llm = Mock(return_value=({0: (categories[0], 95)}, 50, 0))
    monkeypatch.setattr(service, "CategoryMatcher", lambda *args, **kwargs: matcher)
    # Keep every service write inside the test's rollback transaction.
    monkeypatch.setattr(db_session, "commit", db_session.flush)
    return db_session, uid, other, tx, categories, matcher


def test_request_is_separate_from_labels_and_reuses_pending_suggestion(trial):
    db, uid, _, tx, cats, matcher = trial
    result = service.request_suggestion(db, uid, tx.id)
    assert result["status"] == "needs_review" and result["category_id"] == str(cats[0].id)
    assert "model_score" not in result and "confidence" not in result
    assert tx.category_id is None and tx.category_verified_at is None
    assert tx.category_system_id == cats[0].id
    assert service.request_suggestion(db, uid, tx.id)["id"] == result["id"]
    matcher.match_categories_batch_llm.assert_called_once()


@pytest.mark.parametrize("outcome,index", [("accepted", 0), ("corrected", 1), ("dismissed", None)])
def test_explicit_reviews_preserve_system_label_and_transfer_links(trial, outcome, index):
    db, uid, _, tx, cats, _ = trial
    suggestion = service.request_suggestion(db, uid, tx.id)
    category_id = cats[index].id if index is not None else None
    result = service.review_suggestion(db, uid, suggestion["id"], outcome=outcome, category_id=category_id, review_duration_ms=300)
    assert result["review_outcome"] == outcome
    assert tx.category_id == category_id and tx.category_system_id == cats[0].id
    assert bool(tx.category_verified_at) == (index is not None)
    assert tx.internal_transfer_id is None
    # A retry is idempotent, not an additional review.
    service.review_suggestion(db, uid, suggestion["id"], outcome=outcome, category_id=category_id)
    assert db.query(CategorizationSuggestion).filter_by(user_id=uid).count() == 1
    summary = service.trial_summary(db, uid)
    assert summary["outcomes"] == {outcome: 1} and summary["mean_review_duration_ms"] == 300


@pytest.mark.parametrize("change", ["manual_category", "amount", "pending"])
def test_stale_review_cannot_overwrite_an_edit(trial, change):
    db, uid, _, tx, cats, _ = trial
    suggestion = service.request_suggestion(db, uid, tx.id)
    if change == "manual_category": tx.category_id = cats[1].id
    elif change == "amount": tx.amount = Decimal("-99")
    else: tx.pending = True
    db.flush()
    with pytest.raises(HTTPException) as error:
        service.review_suggestion(db, uid, suggestion["id"], outcome="accepted", category_id=cats[0].id)
    assert error.value.status_code == 409
    assert tx.category_id != cats[0].id


def test_foreign_transactions_categories_and_reviews_are_rejected(trial):
    db, uid, other, tx, cats, _ = trial
    with pytest.raises(HTTPException) as error:
        service.request_suggestion(db, other, tx.id)
    assert error.value.status_code == 404
    suggestion = service.request_suggestion(db, uid, tx.id)
    for reviewer, category in ((other, cats[0]), (uid, cats[2])):
        with pytest.raises(HTTPException) as error:
            service.review_suggestion(db, reviewer, suggestion["id"], outcome="corrected", category_id=category.id)
        assert error.value.status_code == 404
    assert tx.category_id is None
    assert service.trial_summary(db, other)["requested"] == 0


def test_disabled_trial_and_model_failure_do_not_change_labels(trial, monkeypatch):
    db, uid, _, tx, _, matcher = trial
    monkeypatch.setenv("CATEGORIZER_SUGGESTIONS_ENABLED", "false")
    with pytest.raises(HTTPException) as error:
        service.request_suggestion(db, uid, tx.id)
    assert error.value.status_code == 404
    matcher.match_categories_batch_llm.assert_not_called()
    monkeypatch.setenv("CATEGORIZER_SUGGESTIONS_ENABLED", "true")
    matcher.last_batch_failures = 1
    with pytest.raises(HTTPException) as error:
        service.request_suggestion(db, uid, tx.id)
    assert error.value.status_code == 503
    assert db.query(CategorizationSuggestion).filter_by(user_id=uid).one().inference_status == "failed"
    assert tx.category_id is None


def test_change_during_inference_rejects_result(trial):
    db, uid, _, tx, cats, matcher = trial
    def classify(*args, **kwargs):
        tx.category_id = cats[1].id
        db.flush()
        return {0: (cats[0], 95)}, 50, 0
    matcher.match_categories_batch_llm.side_effect = classify
    with pytest.raises(HTTPException) as error:
        service.request_suggestion(db, uid, tx.id)
    assert error.value.status_code == 409
    assert db.query(CategorizationSuggestion).filter_by(user_id=uid).one().inference_status == "stale"


def test_abstention_can_be_corrected_but_not_accepted(trial):
    db, uid, _, tx, cats, matcher = trial
    matcher.match_categories_batch_llm.return_value = {}, 50, 0
    matcher.inference_trace = [{"parse_outcomes": {"0": "abstained"}}]
    suggestion = service.request_suggestion(db, uid, tx.id)
    assert suggestion["category_id"] is None
    with pytest.raises(HTTPException):
        service.review_suggestion(db, uid, suggestion["id"], outcome="accepted", category_id=cats[0].id)
    service.review_suggestion(db, uid, suggestion["id"], outcome="corrected", category_id=cats[0].id)
    assert tx.category_id == cats[0].id


def test_signed_http_flow_checks_auth_and_validates_review_body(trial, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.database import get_db
    from tests.internal_auth import build_internal_auth_headers
    db, uid, other, tx, cats, _ = trial
    monkeypatch.setenv("INTERNAL_AUTH_SECRET", "suggestion-test-only-key")
    app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(app)
        path = f"/api/categorization-suggestions/transactions/{tx.id}"
        assert client.post(path).status_code == 401
        assert client.post(path, headers=build_internal_auth_headers("POST", path, other)).status_code == 404
        response = client.post(path, headers=build_internal_auth_headers("POST", path, uid))
        assert response.status_code == 200
        review_path = f"/api/categorization-suggestions/{response.json()['id']}/review"
        headers = build_internal_auth_headers("POST", review_path, uid)
        assert client.post(review_path, headers=headers, json={"outcome": "accepted", "category_id": str(cats[0].id), "review_duration_ms": -1}).status_code == 422
        response = client.post(review_path, headers=headers, json={"outcome": "accepted", "category_id": str(cats[0].id), "review_duration_ms": 300})
        assert response.status_code == 200 and response.json()["status"] == "reviewed"
        assert tx.category_id == cats[0].id
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_real_retrieval_and_ollama_transport_are_used_by_trial(trial, monkeypatch):
    from app.services.category_matcher import CategoryMatcher
    db, uid, _, tx, cats, _ = trial
    db.add(Transaction(user_id=uid, account_id=tx.account_id, amount=-25, currency="AUD", description="Shop",
                       booked_at=datetime(2026, 10, 24), transaction_type="debit", pending=False,
                       category_id=cats[0].id, category_verified_at=datetime(2026, 10, 24)))
    db.flush()
    monkeypatch.setattr(service, "CategoryMatcher", CategoryMatcher)
    monkeypatch.setattr(CategoryMatcher, "LLM_MODEL", "qwen3:8b")
    monkeypatch.setenv("CATEGORIZER_PROVIDER", "ollama")
    response = Mock()
    response.json.return_value = {"done": True, "done_reason": "stop", "message": {"content": "0|Food|95"}, "prompt_eval_count": 100, "eval_count": 10}
    post = Mock(return_value=response)
    monkeypatch.setattr("app.services.ollama_categorizer.httpx.post", post)
    monkeypatch.setattr("app.services.ollama_categorizer.OllamaCategorizerClient.identity", lambda self, model: {"digest": "test-local-digest"})
    result = service.request_suggestion(db, uid, tx.id)
    assert result["category_name"] == "Food"
    assert any(row["kind"] == "verified_precedent" for row in result["evidence"])
    assert not any(row["kind"] == "possible_transfer_counterpart" for row in result["evidence"])
    row = db.query(CategorizationSuggestion).filter_by(id=result["id"]).one()
    assert row.provider == "ollama" and row.context_mode == "examples_only"
    assert post.call_args.kwargs["json"]["model"] == "qwen3:8b"
    assert tx.category_id is None


def test_confirmed_transfer_created_after_suggestion_blocks_review(trial):
    from app.models import InternalTransfer
    db, uid, _, tx, cats, matcher = trial
    suggestion = service.request_suggestion(db, uid, tx.id)
    pocket = Account(user_id=uid, name="Pocket", account_type="savings", currency="AUD")
    db.add(pocket); db.flush()
    db.add(InternalTransfer(user_id=uid, source_txn_id=tx.id, source_account_id=tx.account_id,
                            pocket_account_id=pocket.id, amount=25, currency="AUD"))
    db.flush()
    with pytest.raises(HTTPException) as error:
        service.review_suggestion(db, uid, suggestion["id"], outcome="accepted", category_id=cats[0].id)
    assert error.value.status_code == 409 and tx.category_id is None


def test_background_context_is_off_by_default(monkeypatch):
    from app.services.category_matcher import CategoryMatcher
    monkeypatch.delenv("CATEGORIZER_CONTEXT_ENABLED", raising=False)
    matcher = CategoryMatcher(Mock(), user_id="test", auto_load_from_db=False)
    assert not matcher.context_enabled


def test_snapshots_survive_input_and_taxonomy_edits_and_cache_tracks_configuration(trial):
    db, uid, _, tx, cats, matcher = trial
    result = service.request_suggestion(db, uid, tx.id)
    row = db.query(CategorizationSuggestion).filter_by(id=result['id']).one()
    assert row.record['target']['description'] == 'Shop'
    assert row.record['target']['account']['name'] == 'Daily'
    original_record = row.record
    cats[0].name = 'Renamed food'
    db.flush()
    second = service.request_suggestion(db, uid, tx.id)
    assert second['id'] != result['id']
    matcher.LLM_MODEL = 'another-local-model'
    third = service.request_suggestion(db, uid, tx.id)
    assert third['id'] != second['id']
    tx.description = 'Changed later'
    db.flush(); db.expire(row)
    assert row.record == original_record
    assert any(c['name'] == 'Food' for c in row.record['configuration']['taxonomy'])
    assert 'code_hashes' in row.record['configuration']


def test_shown_is_owner_scoped_idempotent_and_separate_from_requested(trial):
    db, uid, other, tx, _, _ = trial
    result = service.request_suggestion(db, uid, tx.id)
    row = db.query(CategorizationSuggestion).filter_by(id=result['id']).one()
    assert row.shown_at is None
    with pytest.raises(HTTPException) as exc:
        service.mark_shown(db, other, row.id)
    assert exc.value.status_code == 404
    service.mark_shown(db, uid, row.id)
    shown = row.shown_at
    service.mark_shown(db, uid, row.id)
    assert row.shown_at == shown and row.reviewed_at is None


def test_failed_parse_is_retained_but_not_cached_or_reviewable(trial):
    db, uid, _, tx, cats, matcher = trial
    matcher.match_categories_batch_llm.return_value = {}, 50, 0
    matcher.inference_trace = [{'messages': [{'role': 'user', 'content': 'test prompt'}],
                               'raw_output': 'not a valid category', 'parse_outcomes': {'0': 'invalid_or_missing'}}]
    with pytest.raises(HTTPException) as exc:
        service.request_suggestion(db, uid, tx.id)
    assert exc.value.status_code == 503
    failed = db.query(CategorizationSuggestion).filter_by(user_id=uid).one()
    assert failed.inference_status == 'invalid_output'
    assert failed.record['inference'][0]['raw_output'] == 'not a valid category'
    assert service.trial_summary(db, uid)['requested'] == 0
    with pytest.raises(HTTPException):
        service.review_suggestion(db, uid, failed.id, outcome='corrected', category_id=cats[0].id)
    matcher.match_categories_batch_llm.return_value = {0: (cats[0], 80)}, 50, 0
    result = service.request_suggestion(db, uid, tx.id)
    assert result['id'] != str(failed.id)


def test_database_feedback_captures_outside_panel_changes_and_keeps_snapshots(trial):
    from sqlalchemy import text
    db, uid, _, tx, cats, _ = trial
    result = service.request_suggestion(db, uid, tx.id)
    service.review_suggestion(db, uid, result['id'], outcome='accepted', category_id=cats[0].id)
    feedback = db.execute(text('SELECT source, suggestion_id, snapshot FROM categorization_feedback WHERE transaction_id = :id'), {'id': tx.id}).one()
    assert feedback.source == 'suggestion_review' and str(feedback.suggestion_id) == result['id']
    assert feedback.snapshot['previous_category_id'] is None
    assert feedback.snapshot['system_category_id'] == str(cats[0].id)
    # End the panel context as a real request's transaction would. Then simulate a
    # direct frontend SQL edit, not a call through the suggestion service.
    db.execute(text("SELECT set_config('app.categorization_suggestion_id', '', true)"))
    db.execute(text('UPDATE transactions SET category_id = :category WHERE id = :id'), {'id': tx.id, 'category': cats[1].id})
    rows = db.execute(text('SELECT source, snapshot FROM categorization_feedback WHERE transaction_id = :id ORDER BY created_at, id'), {'id': tx.id}).all()
    assert len(rows) == 2
    correction = next(r for r in rows if r.source == 'manual_assignment')
    assert correction.snapshot['previous_category_id'] == str(cats[0].id)
    assert correction.snapshot['category_id'] == str(cats[1].id)
    cats[0].name = 'Renamed'; tx.description = 'Later change'; db.flush()
    assert feedback.snapshot['target']['description'] == 'Shop'
    assert any(c['name'] == 'Food' for c in feedback.snapshot['categories'])
    # System-only predictions are not misrepresented as manual feedback.
    db.execute(text('UPDATE transactions SET category_system_id = :category WHERE id = :id'), {'id': tx.id, 'category': cats[1].id})
    assert db.execute(text('SELECT count(*) FROM categorization_feedback WHERE transaction_id = :id'), {'id': tx.id}).scalar() == 2


def test_interrupted_worker_leaves_an_incomplete_attempt(trial):
    db, uid, _, tx, _, matcher = trial
    matcher.match_categories_batch_llm.side_effect = SystemExit("synthetic worker interruption")
    with pytest.raises(SystemExit):
        service.request_suggestion(db, uid, tx.id)
    attempt = db.query(CategorizationSuggestion).filter_by(user_id=uid).one()
    assert attempt.inference_status == "generating"
    assert attempt.record["target"]["description"] == "Shop"
    assert service.trial_summary(db, uid)["requested"] == 0
