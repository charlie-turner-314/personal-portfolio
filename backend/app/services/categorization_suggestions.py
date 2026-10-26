"""Explicit, opt-in reviews with a durable prospective evaluation record."""
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import os
import time

from fastapi import HTTPException
from sqlalchemy import or_, func, text

from app.services.financial_access import account_access, category_access, category_definition_for_actor, category_selection_hidden
from app.models import Account, Category, CategorizationSuggestion, InternalTransfer, Transaction
from app.services.categorization_context import precedent_fingerprint, transaction_record
from app.services.category_matcher import CategoryMatcher
from app.services.categorization_provenance import configuration, digest, serializable, target_snapshot


def trial_enabled():
    return os.getenv("CATEGORIZER_SUGGESTIONS_ENABLED", "false").lower() == "true"


def require_trial():
    if not trial_enabled():
        raise HTTPException(404, "Categorisation suggestions are not enabled")


def fingerprint(transaction):
    row = transaction_record(transaction)
    values = (*precedent_fingerprint(row), str(transaction.category_id), str(transaction.category_system_id),
              bool(transaction.pending), str(transaction.internal_transfer_id), bool(transaction.account.is_active))
    return hashlib.sha256(json.dumps(values, default=lambda value: format(value.normalize(), "f") if isinstance(value, Decimal) else str(value)).encode()).hexdigest()


def owned_transaction(db, user_id, transaction_id, *, lock=False):
    query = db.query(Transaction).join(Account, Transaction.account_id == Account.id).filter(
        Transaction.id == transaction_id, account_access(Transaction.account_id, user_id))
    if lock:
        query = query.with_for_update(of=Transaction).populate_existing()
    transaction = query.first()
    if not transaction:
        raise HTTPException(404, "Transaction not found")
    if lock:
        db.expire(transaction, ["account"])
    return transaction


def ensure_eligible(db, user_id, transaction):
    linked = db.query(InternalTransfer.id).filter(InternalTransfer.user_id == user_id,
        or_(InternalTransfer.source_txn_id == transaction.id, InternalTransfer.mirror_txn_id == transaction.id)).first()
    if transaction.category_id or transaction.pending or transaction.internal_transfer_id or linked or not transaction.account.is_active:
        raise HTTPException(409, "Suggestions require an active, completed transaction without a manual category or confirmed transfer")


def present(db, suggestion):
    owned_transaction(db, suggestion.user_id, suggestion.transaction_id)
    category = db.query(Category).filter(Category.id == suggestion.suggested_category_id,
                                        category_access(suggestion.user_id)).first() if suggestion.suggested_category_id else None
    return {"id": str(suggestion.id), "transaction_id": str(suggestion.transaction_id),
            "category_id": str(category.id) if category else None, "category_name": category.name if category else None,
            "category_type": category.category_type if category else None,
            "status": "reviewed" if suggestion.reviewed_at else "needs_review", "evidence": suggestion.evidence,
            "review_outcome": suggestion.review_outcome}


def request_suggestion(db, user_id, transaction_id):
    require_trial()
    transaction = owned_transaction(db, user_id, transaction_id)
    ensure_eligible(db, user_id, transaction)
    context_mode = os.getenv("CATEGORIZER_SUGGESTION_CONTEXT", "examples_only")
    if context_mode not in {"examples_only", "contextual"}:
        raise HTTPException(503, "Invalid suggestion context configuration")
    signature = fingerprint(transaction)
    matcher = CategoryMatcher(db, user_id=user_id, manual_ai=True)
    matcher.context_enabled = True
    matcher.capture_inference = True
    matcher._category_cache = {name: category for name, category in matcher._load_categories().items()
                               if not category.hide_from_selection}
    matcher._get_context_retriever().include_counterparts = context_mode == "contextual"
    started = time.monotonic()
    record = {"schema_version": 1, "target": target_snapshot(transaction)}
    suggestion = CategorizationSuggestion(
        user_id=user_id, transaction_id=transaction.id, target_fingerprint=signature,
        provider=os.getenv("CATEGORIZER_PROVIDER", "openai"), model=matcher.LLM_MODEL,
        context_mode=context_mode, evidence=[], generation_ms=0, record=record, inference_status="failed")
    try:
        client = matcher._get_openai_client()
        if not client:
            raise ValueError("Provider unavailable")
        config = configuration(matcher, client, matcher._category_cache, context_mode)
        suggestion.provider, suggestion.model = config["provider"], config["model"]
        suggestion.config_fingerprint = digest(config)
        record["configuration"] = config
        existing = db.query(CategorizationSuggestion).filter(
            CategorizationSuggestion.user_id == user_id, CategorizationSuggestion.transaction_id == transaction.id,
            CategorizationSuggestion.target_fingerprint == signature, CategorizationSuggestion.reviewed_at.is_(None),
            CategorizationSuggestion.config_fingerprint == suggestion.config_fingerprint,
            CategorizationSuggestion.inference_status.in_(["assigned", "abstained"]),
        ).order_by(CategorizationSuggestion.created_at.desc()).first()
        if existing:
            return present(db, existing)
        suggestion.inference_status = "generating"
        suggestion.record = serializable(record)
        db.add(suggestion)
        # Record the attempt before the external call. A killed worker leaves a
        # visible incomplete attempt rather than silently dropping the request.
        expire_on_commit = db.expire_on_commit
        try:
            db.expire_on_commit = False
            db.commit()
        finally:
            db.expire_on_commit = expire_on_commit
        results, tokens, _ = matcher.match_categories_batch_llm([{**record["target"], "index": 0}], max_batch_size=1)
        traces = getattr(matcher, "inference_trace", [])
        record["inference"] = serializable(traces)
        record["runtime_metrics"] = serializable(getattr(client, "request_metrics", []))
        suggestion.evidence = [json.loads(line) for line in matcher.last_context.get(0, "").splitlines() if line.strip()]
        result = results.get(0)
        if matcher.last_batch_failures or not tokens:
            raise ValueError("Generation failed")
        suggestion.suggested_category_id = result[0].id if result else None
        suggestion.model_score = result[1] if result else None
        record["suggested_category"] = serializable({key: getattr(result[0], key, None) for key in
            ("id", "name", "category_type", "description", "categorization_instructions")}) if result else None
        parsed = traces[-1].get("parse_outcomes", {}).get("0") if traces else None
        suggestion.inference_status = "assigned" if result else "abstained" if parsed == "abstained" else "invalid_output"
        if suggestion.inference_status == "invalid_output":
            raise ValueError("Invalid model output")
    except Exception as exc:
        if suggestion.inference_status != "invalid_output":
            suggestion.inference_status = "failed"
        record["error_type"] = type(exc).__name__
        record["inference"] = serializable(getattr(matcher, "inference_trace", []))
        record["runtime_metrics"] = serializable(getattr(locals().get("client"), "request_metrics", []))
        suggestion.record = serializable(record)
        suggestion.generation_ms = round((time.monotonic() - started) * 1000)
        db.add(suggestion)
        db.commit()
        raise HTTPException(503, "The categorisation model did not complete; try again later") from None
    suggestion.generation_ms = round((time.monotonic() - started) * 1000)
    suggestion.record = serializable(record)
    # Reload after inference: concurrent manual edits invalidate, but do not erase
    # the attempted inference. Its input snapshot remains the original request.
    transaction = owned_transaction(db, user_id, transaction_id, lock=True)
    try:
        ensure_eligible(db, user_id, transaction)
        if fingerprint(transaction) != signature:
            raise HTTPException(409, "Transaction changed while the suggestion was being generated")
    except HTTPException:
        suggestion.inference_status = "stale"
        db.add(suggestion)
        db.commit()
        raise
    db.add(suggestion)
    db.commit()
    return present(db, suggestion)


def mark_shown(db, user_id, suggestion_id):
    require_trial()
    suggestion = db.query(CategorizationSuggestion).filter(
        CategorizationSuggestion.id == suggestion_id, CategorizationSuggestion.user_id == user_id,
        CategorizationSuggestion.inference_status.in_(["assigned", "abstained"]),
    ).with_for_update().first()
    if not suggestion:
        raise HTTPException(404, "Suggestion not found")
    owned_transaction(db, user_id, suggestion.transaction_id)
    if suggestion.shown_at is None:
        suggestion.shown_at = datetime.utcnow()
        db.commit()
    return {"recorded": True}


def review_suggestion(db, user_id, suggestion_id, *, outcome, category_id=None, review_duration_ms=None):
    require_trial()
    suggestion = db.query(CategorizationSuggestion).filter(
        CategorizationSuggestion.id == suggestion_id, CategorizationSuggestion.user_id == user_id,
    ).with_for_update().populate_existing().first()
    if not suggestion:
        raise HTTPException(404, "Suggestion not found")
    if suggestion.inference_status not in {"assigned", "abstained"}:
        raise HTTPException(409, "This inference cannot be reviewed; request a fresh suggestion")
    if outcome not in {"accepted", "corrected", "dismissed"}:
        raise HTTPException(422, "Invalid review outcome")
    if suggestion.reviewed_at:
        if suggestion.review_outcome == outcome and str(suggestion.reviewed_category_id or "") == str(category_id or ""):
            return present(db, suggestion)
        raise HTTPException(409, "Suggestion has already been reviewed")
    transaction = owned_transaction(db, user_id, suggestion.transaction_id, lock=True)
    ensure_eligible(db, user_id, transaction)
    if fingerprint(transaction) != suggestion.target_fingerprint:
        raise HTTPException(409, "Transaction changed; request a fresh suggestion before reviewing")
    if outcome == "dismissed":
        if category_id is not None:
            raise HTTPException(422, "Dismissal does not assign a category")
    else:
        category = db.query(Category).filter(Category.id == category_id, category_access(user_id),
                                             category_selection_hidden(user_id).isnot(True)).first()
        if not category:
            raise HTTPException(404, "Category not found")
        matches = str(category.id) == str(suggestion.suggested_category_id)
        if (outcome == "accepted") != matches:
            raise HTTPException(422, "Review outcome does not match the selected category")
        db.execute(text("SELECT set_config('app.categorization_suggestion_id', :id, true)"), {"id": str(suggestion.id)})
        transaction.category_id = category.id
        transaction.category_verified_at = datetime.utcnow()
        suggestion.reviewed_category_id = category.id
    suggestion.record = {**suggestion.record, "review": {"outcome": outcome,
        "category": serializable({key: getattr(category_definition_for_actor(category, user_id), key, None) for key in
            ("id", "name", "category_type", "description", "categorization_instructions")}) if outcome != "dismissed" else None}}
    suggestion.review_outcome = outcome
    suggestion.reviewed_at = datetime.utcnow()
    suggestion.review_duration_ms = review_duration_ms
    db.commit()
    return present(db, suggestion)


def trial_summary(db, user_id):
    require_trial()
    rows = db.query(CategorizationSuggestion.review_outcome, func.count(CategorizationSuggestion.id),
                    func.sum(CategorizationSuggestion.review_duration_ms), func.count(CategorizationSuggestion.review_duration_ms)
                    ).join(Transaction, Transaction.id == CategorizationSuggestion.transaction_id).filter(CategorizationSuggestion.user_id == user_id, account_access(Transaction.account_id, user_id), CategorizationSuggestion.inference_status.in_(["assigned", "abstained"])).group_by(CategorizationSuggestion.review_outcome).all()
    outcomes = {outcome or "unreviewed": count for outcome, count, _, _ in rows}
    duration_count = sum(count for _, _, _, count in rows)
    reviews = outcomes.get("accepted", 0) + outcomes.get("corrected", 0)
    return {"requested": sum(outcomes.values()), "outcomes": outcomes,
            "acceptance_among_category_reviews": outcomes.get("accepted", 0) / reviews if reviews else None,
            "mean_review_duration_ms": sum(total or 0 for _, _, total, _ in rows) / duration_count if duration_count else None,
            "duration_note": "Client-reported wall time from suggestion display to review, including idle time; not active effort or verified accuracy."}
