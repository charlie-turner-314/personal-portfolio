from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.db_helpers import get_user_id
from app.services.categorization_suggestions import request_suggestion, review_suggestion, trial_enabled, trial_summary

router = APIRouter()


class ReviewRequest(BaseModel):
    outcome: Literal["accepted", "corrected", "dismissed"]
    category_id: UUID | None = None
    review_duration_ms: int | None = Field(default=None, ge=0, le=3_600_000)


@router.get("/availability")
def availability():
    return {"enabled": trial_enabled()}


@router.get("/summary")
def summary(db: Session = Depends(get_db)):
    return trial_summary(db, get_user_id(None))


@router.post("/transactions/{transaction_id}")
def suggest(transaction_id: UUID, db: Session = Depends(get_db)):
    return request_suggestion(db, get_user_id(None), transaction_id)


@router.post("/{suggestion_id}/review")
def review(suggestion_id: UUID, body: ReviewRequest, db: Session = Depends(get_db)):
    return review_suggestion(db, get_user_id(None), suggestion_id, **body.model_dump())
