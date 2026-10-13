"""Transaction-scoped coordination for cross-account investment writes."""
from __future__ import annotations

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.hmac import HMAC
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session


_LOCK_NAMESPACE = b"syllogic:investment-ingestion-lock:v1"


def acquire_user_ingestion_lock(db: Session, *, user_id: str) -> None:
    """Serialize canonical ledger writes that may span a user's accounts."""
    if db.get_bind().dialect.name != "postgresql":
        return
    # A keyed digest gives every user a stable, well-distributed advisory-lock
    # key without treating the user identifier as password material.
    signer = HMAC(_LOCK_NAMESPACE, hashes.SHA256())
    signer.update(user_id.encode("utf-8"))
    digest = signer.finalize()
    lock_key = int.from_bytes(digest[:8], byteorder="big", signed=True)
    db.execute(
        sql_text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": lock_key},
    )
