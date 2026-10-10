"""Transaction-scoped coordination for cross-account investment writes."""
from __future__ import annotations

import hmac

from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session


_LOCK_NAMESPACE = b"syllogic:investment-ingestion-lock:v1"


def acquire_user_ingestion_lock(db: Session, *, user_id: str) -> None:
    """Serialize canonical ledger writes that may span a user's accounts."""
    if db.get_bind().dialect.name != "postgresql":
        return
    # A keyed digest gives every user a stable, well-distributed advisory-lock
    # key without treating the user identifier as password material.
    digest = hmac.digest(_LOCK_NAMESPACE, user_id.encode("utf-8"), "sha256")
    lock_key = int.from_bytes(digest[:8], byteorder="big", signed=True)
    db.execute(
        sql_text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": lock_key},
    )
