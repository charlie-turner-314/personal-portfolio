"""Explicit, opt-in reviews with a durable prospective evaluation record."""
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import os
import time

from fastapi import HTTPException
from sqlalchemy import or_, func

from app.models import Account, Category, CategorizationSuggestion, InternalTransfer, Transaction
from app.services.categorization_context import precedent_fingerprint, transaction_record
from app.services.category_matcher import CategoryMatcher


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
        Transaction.id == transaction_id, Transaction.user_id == user_id, Account.user_id == user_id)
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
    category = db.query(Category).filter(Category.id == suggestion.suggested_category_id,
                                        Category.user_id == suggestion.user_id).first() if suggestion.suggested_category_id else None
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
    existing = db.query(CategorizationSuggestion).filter(
        CategorizationSuggestion.user_id == user_id, CategorizationSuggestion.transaction_id == transaction.id,
        CategorizationSuggestion.target_fingerprint == signature, CategorizationSuggestion.reviewed_at.is_(None),
        CategorizationSuggestion.context_mode == context_mode,
    ).order_by(CategorizationSuggestion.created_at.desc()).first()
    if existing:
        return present(db, existing)
    matcher = CategoryMatcher(db, user_id=user_id)
    matcher.context_enabled = True
    matcher._category_cache = {name: category for name, category in matcher._load_categories().items()
                               if not category.hide_from_selection}
    matcher._get_context_retriever().include_counterparts = context_mode == "contextual"
    if not matcher._get_openai_client():
        raise HTTPException(503, "The categorisation model is unavailable")
    started = time.monotonic()
    results, tokens, _ = matcher.match_categories_batch_llm([{**transaction_record(transaction), "index": 0}], max_batch_size=1)
    if matcher.last_batch_failures or not tokens:
        raise HTTPException(503, "The categorisation model did not complete; try again later")
    result = results.get(0)
    suggestion = CategorizationSuggestion(
        user_id=user_id, transaction_id=transaction.id, target_fingerprint=signature,
        suggested_category_id=result[0].id if result else None,
        model_score=result[1] if result else None,
        provider=os.getenv("CATEGORIZER_PROVIDER", "openai"), model=matcher.LLM_MODEL, context_mode=context_mode,
        evidence=[json.loads(line) for line in matcher.last_context.get(0, "").splitlines() if line.strip()],
        generation_ms=round((time.monotonic() - started) * 1000),
    )
    # Reload after inference: concurrent manual edits must invalidate this result.
    transaction = owned_transaction(db, user_id, transaction_id, lock=True)
    ensure_eligible(db, user_id, transaction)
    if fingerprint(transaction) != signature:
        raise HTTPException(409, "Transaction changed while the suggestion was being generated")
    db.add(suggestion)
    db.commit()
    return present(db, suggestion)


def review_suggestion(db, user_id, suggestion_id, *, outcome, category_id=None, review_duration_ms=None):
    require_trial()
    suggestion = db.query(CategorizationSuggestion).filter(
        CategorizationSuggestion.id == suggestion_id, CategorizationSuggestion.user_id == user_id,
    ).with_for_update().populate_existing().first()
    if not suggestion:
        raise HTTPException(404, "Suggestion not found")
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
        category = db.query(Category).filter(Category.id == category_id, Category.user_id == user_id,
                                             Category.hide_from_selection.isnot(True)).first()
        if not category:
            raise HTTPException(404, "Category not found")
        matches = str(category.id) == str(suggestion.suggested_category_id)
        if (outcome == "accepted") != matches:
            raise HTTPException(422, "Review outcome does not match the selected category")
        transaction.category_id = category.id
        transaction.category_verified_at = datetime.utcnow()
        suggestion.reviewed_category_id = category.id
    suggestion.review_outcome = outcome
    suggestion.reviewed_at = datetime.utcnow()
    suggestion.review_duration_ms = review_duration_ms
    db.commit()
    return present(db, suggestion)


def trial_summary(db, user_id):
    require_trial()
    rows = db.query(CategorizationSuggestion.review_outcome, func.count(CategorizationSuggestion.id),
                    func.sum(CategorizationSuggestion.review_duration_ms), func.count(CategorizationSuggestion.review_duration_ms)
                    ).filter(CategorizationSuggestion.user_id == user_id).group_by(CategorizationSuggestion.review_outcome).all()
    outcomes = {outcome or "unreviewed": count for outcome, count, _, _ in rows}
    duration_count = sum(count for _, _, _, count in rows)
    reviews = outcomes.get("accepted", 0) + outcomes.get("corrected", 0)
    return {"requested": sum(outcomes.values()), "outcomes": outcomes,
            "acceptance_among_category_reviews": outcomes.get("accepted", 0) / reviews if reviews else None,
            "mean_review_duration_ms": sum(total or 0 for _, _, total, _ in rows) / duration_count if duration_count else None,
            "duration_note": "Client-reported wall time from suggestion display to review, including idle time; not active effort or verified accuracy."}
