"""Celery workers for Up connections.

Held Up transactions are intentionally excluded by ``UpAdapter``. Settled
transactions are idempotent through the canonical ``SyncService`` external-ID
upsert path.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func

from celery_app import celery_app
from app.database import SessionLocal
from app.integrations.up_adapter import UpAdapter
from app.models import Account, BankConnection, Transaction
from app.security.data_encryption import decrypt_value
from app.services.sync_service import SyncService
from app.services.up_transfer_link_service import UpTransferLinkService
from tasks.enable_banking_tasks import _account_sync_start_date, _should_skip_sync
from tasks.post_import_pipeline import post_import_pipeline

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)
def sync_up_connection(self, connection_id: str):
    db = SessionLocal()
    started = False
    try:
        connection = db.query(BankConnection).filter(
            BankConnection.id == connection_id,
            BankConnection.provider == "up",
        ).first()
        if not connection:
            return {"error": "Up connection not found"}
        if connection.status != "active":
            return {"skipped": True, "reason": f"Status is {connection.status}"}
        if _should_skip_sync(connection):
            return {"skipped": True, "reason": "sync_too_recent"}
        if not connection.credentials_encrypted:
            raise RuntimeError("Up connection has no encrypted access token")

        connection.sync_started_at = datetime.now(timezone.utc)
        db.commit()
        started = True
        access_token = decrypt_value(connection.credentials_encrypted)
        if not access_token:
            raise RuntimeError("Up connection token could not be decrypted")
        adapter = UpAdapter(access_token)
        sync_service = SyncService(db, user_id=connection.user_id, use_llm_categorization=False)
        accounts = db.query(Account).filter(Account.bank_connection_id == connection.id).all()
        total_created = total_updated = 0
        touched_ids: list[str] = []
        account_ids: list[str] = []
        is_initial_sync = connection.last_synced_at is None
        end_date = datetime.now(timezone.utc)
        live_accounts = {item.external_id: item for item in adapter.fetch_accounts()}
        for account in accounts:
            # Refresh the live balance independently of transaction history.
            account_data = live_accounts.get(sync_service._resolve_account_external_id(account))
            if account_data and account_data.balance_available is not None:
                account.balance_available = account_data.balance_available
                account.balance_is_anchored = True
            created, updated, created_ids, updated_ids = sync_service.sync_transactions(
                adapter, account, start_date=_account_sync_start_date(account, connection), end_date=end_date
            )
            total_created += created
            total_updated += updated
            touched_ids.extend(created_ids + updated_ids)
            account_ids.append(str(account.id))
            account.last_synced_at = datetime.now(timezone.utc)
            if account.balance_is_anchored and account.balance_available is not None:
                txn_sum = db.query(func.sum(Transaction.amount)).filter(
                    Transaction.user_id == connection.user_id, Transaction.account_id == account.id
                ).scalar()
                account.starting_balance = Decimal(str(account.balance_available)) - Decimal(str(txn_sum or 0))
                account.functional_balance = account.balance_available

        connection.last_synced_at = datetime.now(timezone.utc)
        connection.sync_started_at = None
        connection.last_sync_error = None
        db.commit()
        started = False
        linked_transfers = UpTransferLinkService(
            db, connection.user_id
        ).link_explicit_transfers()
        if touched_ids:
            post_import_pipeline.delay(
                user_id=str(connection.user_id), account_ids=account_ids,
                transaction_ids=list(dict.fromkeys(touched_ids)),
                is_initial_sync=is_initial_sync,
            )
        return {
            "connection_id": connection_id,
            "transactions_created": total_created,
            "transactions_updated": total_updated,
            "transfers_linked": linked_transfers,
        }
    except Exception as exc:
        logger.exception("Up sync failed for connection %s", connection_id)
        connection = db.query(BankConnection).filter(BankConnection.id == connection_id).first()
        if connection:
            connection.last_sync_error = str(exc)[:500]
            db.commit()
        raise self.retry(exc=exc)
    finally:
        if started:
            try:
                connection = db.query(BankConnection).filter(BankConnection.id == connection_id).first()
                if connection:
                    connection.sync_started_at = None
                    db.commit()
            except Exception:
                db.rollback()
        db.close()
