from datetime import datetime, timedelta
import json
import os
from types import SimpleNamespace as NS
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy import text

from app.database import SessionLocal
from app.models import Account, Category, Transaction, User
from app.services.categorization_context import CategorizationContext
from app.services.categorization_evaluation import evaluate_snapshot, evaluation_matcher, evaluation_targets, merchant_key, split_examples, summarize_predictions, paired_comparison, report_summary, transfer_metrics, transfer_strata
from app.services.categorization_snapshot import export_snapshot, read_snapshot


def snapshot():
    cat_id = str(uuid4())
    examples = []
    for index in range(20):
        examples.append(dict(id=str(uuid4()), category_id=cat_id, category_system_id=cat_id,
                             merchant=f"Shop {index % 4}", description=f"Produce {index % 4}", amount=-25,
                             account_id="checking", currency="EUR", transaction_type="debit",
                             booked_at=str(datetime(2026, 1, 1) + timedelta(days=index)),
                             created_at=str(datetime(2026, 1, 1) + timedelta(days=index)),
                             categorization_instructions="SECRET TARGET GUIDANCE",
                             verified_at="2026-10-25T00:00:00+00:00", provenance="trusted_snapshot"))
    return dict(version=1, user_id="user", snapshot_at="2026-10-25T00:00:00+00:00",
                categories=[dict(id=cat_id, name="Groceries", category_type="expense", description="Food shops")],
                accounts=[], examples=examples, transactions=[])


def test_holdout_targets_have_no_labels_or_guidance_and_no_merchant_leakage():
    data = snapshot()
    train, test = split_examples(data, split="merchant")
    assert {merchant_key(r) for r in train}.isdisjoint({merchant_key(r) for r in test})
    targets = evaluation_targets(test)
    assert "category_id" not in targets[0] and "category_system_id" not in targets[0]
    assert "SECRET TARGET GUIDANCE" not in json.dumps(targets)
    train, test = split_examples(data, split="temporal")
    assert max(r["booked_at"] for r in train) < min(r["booked_at"] for r in test)


def test_prepare_makes_no_model_or_embedding_calls():
    with patch("app.services.category_matcher.CategoryMatcher._get_openai_client", side_effect=AssertionError("Unexpected API call")):
        report = evaluate_snapshot(snapshot(), modes=("without_retrieval", "contextual", "semantic"))
    assert report["live_calls"] is False
    assert report["modes"]["without_retrieval"]["targets_with_evidence"] == 0
    assert report["modes"]["contextual"]["targets_with_evidence"] > 0
    assert report["cases"]
    assert report["cases"][0]["predictions"]["contextual"]["precedent_ids"]
    assert "cases" not in report_summary(report)
    assert not report["paired_comparisons"]


def test_metrics_separate_abstention_accuracy_and_uncalibrated_scores():
    test = snapshot()["examples"][:3]
    results = {0: (NS(id=test[0]["category_id"]), 90), 1: (NS(id="wrong"), 90)}
    report = summarize_predictions(test, results, [])
    assert report["correct"] == 1 and report["incorrect"] == 1 and report["abstained"] == 1
    assert report["coverage"] == pytest.approx(2/3)
    assert report["accuracy_assigned"] == .5
    assert report["score_ece"] == pytest.approx(.4)
    assert report["scores_are_calibrated"] is False


def test_ablation_keeps_precedents_and_suppresses_only_counterparts():
    data = snapshot()
    target = evaluation_targets(data["examples"][-1:])[0]
    data["transactions"] = [{**target, "id": "other-leg", "account_id": "savings", "amount": 25, "transaction_type": "credit"}]
    rendered = {}
    for mode in ("examples_only", "contextual"):
        matcher = evaluation_matcher(data, data["examples"][:10], mode=mode)
        rendered[mode] = [json.loads(line) for line in matcher._evidence_block(target).splitlines()]
    examples = lambda mode: [r for r in rendered[mode] if r["kind"] == "verified_precedent"]
    assert examples("examples_only") == examples("contextual") and examples("contextual")
    assert not any(r["kind"] == "possible_transfer_counterpart" for r in rendered["examples_only"])
    assert any(r["kind"] == "possible_transfer_counterpart" for r in rendered["contextual"])


def test_transfer_challenge_uses_reviewed_strata_and_excludes_same_event_labels():
    data = snapshot()
    transfer_id = str(uuid4())
    data["categories"].append(dict(id=transfer_id, name="Transfers", category_type="transfer"))
    for index, row in enumerate(data["examples"]):
        row["amount"] = -(index + 100)
        if index < 4: row["category_id"] = transfer_id
        if index in (0, 1, 4, 5):
            raw = evaluation_targets([row])[0]
            data["transactions"].append({**raw, "id": str(uuid4()), "account_id": "savings", "amount": abs(row["amount"]), "transaction_type": "credit"})
    strata = transfer_strata(data)
    assert "nontransfer_with_counterpart" in strata.values()
    train, test = split_examples(data, split="transfer")
    assert train and test
    assert {str(r["id"]) for r in train}.isdisjoint({str(r["id"]) for r in test})
    assert (train, test) == split_examples(data, split="transfer")
    prepared = evaluate_snapshot(data, split="transfer", modes=("examples_only", "contextual"))
    assert prepared["challenge_strata"]["nontransfer_with_counterpart"] == 2
    assert "not a population" in prepared["selection"]
    positive = next(r for r in test if r["category_id"] == transfer_id)
    negative = next(r for r in test if r["category_id"] != transfer_id)
    metrics = transfer_metrics([positive, negative], {1: (NS(id=transfer_id), 99)}, data)
    assert metrics["false_positive"] == 1 and metrics["false_negative"] == 1
    assert metrics["abstained_positive"] == 1


def test_paired_comparison_tracks_regressions_and_clusters_merchants():
    test = snapshot()["examples"][:4]
    correct = NS(id=test[0]["category_id"])
    before = {0: (correct, 90), 1: (correct, 90)}
    after = {0: (correct, 90), 2: (correct, 90), 3: (correct, 90)}
    summary = paired_comparison(test, before, after)
    assert summary["fixed"] == 2 and summary["regressed"] == 1
    assert summary["accuracy_all_change"] == .25
    assert summary["merchant_groups"] == 4
    assert summary["accuracy_change_ci95"][0] <= .25 <= summary["accuracy_change_ci95"][1]
    assert summary == paired_comparison(test, before, after)


def test_snapshot_rejects_other_user_and_missing_provenance(tmp_path):
    path = tmp_path / "snapshot.json"
    data = snapshot()
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="user mismatch"):
        read_snapshot(path, "someone-else")
    data["examples"][0].pop("verified_at")
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="verification provenance"):
        read_snapshot(path, "user")


def test_existing_output_fails_before_reading_data_or_calling_models(tmp_path, monkeypatch):
    from scripts.evaluate_categorizer import main
    output = tmp_path / "existing.json"
    output.write_text("existing report")
    monkeypatch.setattr("sys.argv", ["evaluate_categorizer.py", "evaluate", str(tmp_path / "missing-snapshot.json"),
                                     "--output", str(output), "--run"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2
    assert output.read_text() == "existing report"


def test_export_is_read_only_private_and_trust_is_explicit(db_session, tmp_path):
    uid = "snapshot-" + uuid4().hex
    db_session.add(User(id=uid, email=uid + "@example.com"))
    db_session.flush()
    account = Account(user_id=uid, name="Checking", account_type="checking")
    cat = Category(user_id=uid, name="Groceries", category_type="expense")
    db_session.add_all([account, cat])
    db_session.flush()
    tx = Transaction(user_id=uid, account_id=account.id, amount=-25, description="ALDI", booked_at=datetime(2026, 10, 20),
                     category_id=cat.id, category_system_id=cat.id)
    db_session.add(tx)
    db_session.commit()  # Only the isolated test DB; export uses a fresh read-only session.
    path = tmp_path / "manual.json"
    with SessionLocal() as db:
        assert export_snapshot(db, uid, path)["examples"] == 0
        assert db.execute(text("SHOW transaction_read_only")).scalar() == "on"
    assert os.stat(path).st_mode & 0o777 == 0o600
    trusted = tmp_path / "trusted.json"
    with SessionLocal() as db:
        assert export_snapshot(db, uid, trusted, trust_current_labels=True)["examples"] == 1
    data = read_snapshot(trusted, uid)
    assert data["examples"][0]["provenance"] == "trusted_snapshot"
    assert "category_id" not in data["transactions"][0]
    # Runtime snapshot retrieval validates the current effective label.
    context = CategorizationContext(db_session, uid, [cat], snapshot_path=trusted)
    assert len(context.examples()) == 1
    # A routine bank refresh changes updated_at without changing what was reviewed.
    tx.updated_at = datetime(2030, 1, 1)
    db_session.flush()
    assert len(CategorizationContext(db_session, uid, [cat], snapshot_path=trusted).examples()) == 1
    original_description = tx.description
    tx.description = "A different purchase"
    db_session.flush()
    assert CategorizationContext(db_session, uid, [cat], snapshot_path=trusted).examples() == []
    tx.description = original_description
    db_session.flush()
    tx.category_system_id = None
    tx.category_id = None
    db_session.flush()
    context = CategorizationContext(db_session, uid, [cat], snapshot_path=trusted)
    assert context.examples() == []
    db_session.rollback()
    with SessionLocal() as db:
        with pytest.raises(FileExistsError):
            export_snapshot(db, uid, trusted, trust_current_labels=True)
