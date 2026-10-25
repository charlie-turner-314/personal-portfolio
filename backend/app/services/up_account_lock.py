"""Serialize canonical Up writes across private connections, including reconciliation."""
from contextlib import contextmanager
from sqlalchemy import text
from app.database import engine


def lock_up_accounts(db, account_ids):
    for account_id in sorted({str(value) for value in account_ids}):
        db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": "up-account:" + account_id})


@contextmanager
def up_account_sync_lock(account_id):
    # Use a dedicated connection: SyncService commits must not return a held
    # session lock to the pool or release it while a second token is importing.
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as guard:
        key = {"key": "up-account:" + str(account_id)}
        guard.execute(text("SELECT pg_advisory_lock(hashtextextended(:key, 0))"), key)
        try:
            yield
        finally:
            try:
                guard.execute(text("SELECT pg_advisory_unlock(hashtextextended(:key, 0))"), key)
            except Exception:
                guard.invalidate()
                raise
