"""Transaction-scoped coordination for cross-account investment writes."""
from __future__ import annotations

import hashlib

from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session


def acquire_user_ingestion_lock(db: Session, *, user_id: str) -> None:
    """Serialize canonical ledger writes that may span a user's accounts."""
    if db.get_bind().dialect.name != "postgresql":
        return
    digest = hashlib.sha256(f"investment-ingestion:{user_id}".encode("utf-8")).digest()
    lock_key = int.from_bytes(digest[:8], byteorder="big", signed=True)
    db.execute(
        sql_text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": lock_key},
    )
