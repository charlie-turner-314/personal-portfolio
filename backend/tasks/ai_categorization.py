"""Explicit cleanup only fills still-empty categories; never overwrites edits."""
from datetime import datetime
from celery.exceptions import SoftTimeLimitExceeded
from celery_app import celery_app
from app.database import SessionLocal
from app.models import AiCategorizationJob, Transaction, Category
from app.services.ai_settings import user_api_key, safe_ai_error, AiConfigurationError
from app.services.category_matcher import CategoryMatcher


@celery_app.task(name='tasks.ai_categorization.categorize_uncategorized', soft_time_limit=600, time_limit=630)
def categorize_uncategorized(job_id):
    with SessionLocal() as db:
        claimed = db.query(AiCategorizationJob).filter(
            AiCategorizationJob.id == job_id, AiCategorizationJob.status == 'queued',
        ).update({'status': 'running', 'updated_at': datetime.utcnow()})
        db.commit()
        if not claimed:
            return
        job = db.get(AiCategorizationJob, job_id)
        try:
            for offset in range(0, len(job.transaction_ids), 50):
                db.refresh(job)
                if job.status != 'running':
                    return
                if not user_api_key(db, job.user_id, manual=True):
                    raise AiConfigurationError('The API key was removed. Save a key and retry the remaining transactions.')
                ids = job.transaction_ids[offset:offset + 50]
                rows = db.query(Transaction).filter(
                    Transaction.id.in_(ids), Transaction.user_id == job.user_id,
                    Transaction.category_id.is_(None), Transaction.category_system_id.is_(None),
                    Transaction.include_in_analytics.is_(True), Transaction.internal_transfer_id.is_(None),
                ).order_by(Transaction.id).all()
                matcher = CategoryMatcher(db, user_id=job.user_id, manual_ai=True, strict_ai_errors=True)
                payload = [{'index': i, 'description': t.description, 'merchant': t.merchant,
                            'amount': float(t.amount), 'transaction_type': t.transaction_type}
                           for i, t in enumerate(rows)]
                results, _, _ = matcher.match_categories_batch_llm(payload) if payload else ({}, 0, 0)
                assigned = 0
                for i, (category, _) in results.items():
                    if i < 0 or i >= len(rows):
                        continue
                    # Validate ownership independently of model output; conditionally update
                    # so edits made while the provider request ran always win.
                    owned = db.query(Category.id).filter(Category.id == category.id, Category.user_id == job.user_id).first()
                    if not owned:
                        continue
                    assigned += db.query(Transaction).filter(
                        Transaction.id == rows[i].id, Transaction.user_id == job.user_id,
                        Transaction.category_id.is_(None), Transaction.category_system_id.is_(None),
                        Transaction.include_in_analytics.is_(True), Transaction.internal_transfer_id.is_(None),
                    ).update({'category_system_id': category.id}, synchronize_session=False)
                job.processed += len(ids)
                job.categorized += assigned
                job.skipped += len(ids) - len(rows)
                job.updated_at = datetime.utcnow()
                db.commit()
            job.status = 'completed'
            db.commit()
        except Exception as exc:
            db.rollback()
            job = db.get(AiCategorizationJob, job_id)
            job.status = 'failed'
            job.error = ('The run reached its time limit. Retry to process the remaining transactions.'
                         if isinstance(exc, SoftTimeLimitExceeded) else safe_ai_error(exc))
            job.updated_at = datetime.utcnow()
            db.commit()
