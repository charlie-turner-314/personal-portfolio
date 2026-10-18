"""Settings and durable categorisation progress scoped to the authenticated user."""
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, SecretStr
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.database import get_db
from app.db_helpers import get_user_id
from app.models import UserAiSettings, AiCategorizationJob, Transaction
from app.security.data_encryption import encrypt_value, is_data_encryption_enabled
from app.services.ai_settings import MODEL, user_api_key, test_key, safe_ai_error

router = APIRouter()


def eligible(db, user_id):
    return db.query(Transaction).filter(
        Transaction.user_id == user_id, Transaction.category_id.is_(None),
        Transaction.category_system_id.is_(None), Transaction.include_in_analytics.is_(True),
        Transaction.internal_transfer_id.is_(None),
    )


def expire_stalled(db, user_id):
    db.query(AiCategorizationJob).filter(
        AiCategorizationJob.user_id == user_id,
        AiCategorizationJob.status.in_(['queued', 'running']),
        AiCategorizationJob.updated_at < datetime.utcnow() - timedelta(minutes=15),
    ).update({'status': 'failed', 'error': 'The job stopped responding. Retry to process the remaining uncategorised transactions.'})
    db.commit()


def job_summary(job):
    if not job:
        return None
    return {k: str(getattr(job, k)) if k == 'id' else getattr(job, k)
            for k in ['id', 'status', 'total', 'processed', 'categorized', 'skipped', 'error']}


@router.get('')
def get_settings(user_id: str = Depends(get_user_id), db: Session = Depends(get_db)):
    expire_stalled(db, user_id)
    settings = db.get(UserAiSettings, user_id)
    job = db.query(AiCategorizationJob).filter(AiCategorizationJob.user_id == user_id).order_by(AiCategorizationJob.created_at.desc()).first()
    return {'configured': bool(settings and settings.api_key_encrypted),
            'automatic': bool(settings and settings.automatic), 'model': MODEL,
            'encryption_available': is_data_encryption_enabled(),
            'uncategorized_count': eligible(db, user_id).count(), 'job': job_summary(job)}


class KeyRequest(BaseModel):
    api_key: Optional[SecretStr] = None
    automatic: bool = True


def request_key(body):
    value = body.api_key.get_secret_value().strip() if body.api_key else None
    if value is not None and (not value or len(value) > 4096 or any(c.isspace() for c in value)):
        raise HTTPException(400, 'Enter a valid API key without spaces.')
    return value


@router.post('/test')
def test_connection(body: KeyRequest, user_id: str = Depends(get_user_id), db: Session = Depends(get_db)):
    try:
        test_key(request_key(body) or user_api_key(db, user_id, manual=True))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, safe_ai_error(exc)) from None
    return {'success': True}


@router.put('')
def save_settings(body: KeyRequest, user_id: str = Depends(get_user_id), db: Session = Depends(get_db)):
    key = request_key(body)
    settings = db.get(UserAiSettings, user_id)
    if key:
        encrypted = encrypt_value(key)
        if not encrypted:
            raise HTTPException(503, 'Server encryption is not configured. The key was not saved.')
        try:
            test_key(key)
        except Exception as exc:
            raise HTTPException(400, safe_ai_error(exc)) from None
        if settings is None:
            settings = UserAiSettings(user_id=user_id)
            db.add(settings)
        settings.api_key_encrypted = encrypted
    elif settings is None or not settings.api_key_encrypted:
        raise HTTPException(400, 'Enter an OpenAI API key first.')
    settings.automatic = body.automatic
    settings.updated_at = datetime.utcnow()
    db.commit()
    return {'success': True}


@router.delete('')
def remove_key(user_id: str = Depends(get_user_id), db: Session = Depends(get_db)):
    settings = db.get(UserAiSettings, user_id)
    if settings is None:
        settings = UserAiSettings(user_id=user_id)
        db.add(settings)
    settings.api_key_encrypted = None
    settings.automatic = False
    db.commit()
    return {'success': True}


@router.post('/categorize')
def start_categorization(user_id: str = Depends(get_user_id), db: Session = Depends(get_db)):
    from tasks.ai_categorization import categorize_uncategorized
    expire_stalled(db, user_id)
    try:
        if not user_api_key(db, user_id, manual=True):
            raise HTTPException(400, 'Save an OpenAI API key first.')
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, safe_ai_error(exc)) from None
    ids = [str(row.id) for row in eligible(db, user_id).order_by(Transaction.id).all()]
    job = AiCategorizationJob(user_id=user_id, transaction_ids=ids, total=len(ids), status='queued' if ids else 'completed')
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Categorisation is already running. Its progress is shown below.') from None
    if ids:
        try:
            categorize_uncategorized.delay(str(job.id))
        except Exception:
            job.status = 'failed'
            job.error = 'Could not queue categorisation. Please try again.'
            db.commit()
            raise HTTPException(503, job.error) from None
    return {'success': True, 'job': job_summary(job)}
