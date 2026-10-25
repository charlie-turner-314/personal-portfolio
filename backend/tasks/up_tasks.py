"""Private Up connections may explicitly feed the same canonical shared account."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from sqlalchemy import func, or_, text
from celery_app import celery_app
from app.database import SessionLocal
from app.integrations.up_adapter import UpAdapter
from app.models import Account, BankConnection, Transaction, UpAccountSource, User
from app.security.data_encryption import decrypt_value
from app.services.financial_access import account_access
from app.services.sync_service import SyncService
from app.services.up_account_lock import up_account_sync_lock
from app.services.up_transfer_link_service import UpTransferLinkService
from tasks.enable_banking_tasks import _account_sync_start_date, _should_skip_sync
from tasks.post_import_pipeline import post_import_pipeline

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)
def sync_up_connection(self, connection_id: str, force: bool = False):
    db = SessionLocal()
    started = False
    try:
        connection = db.query(BankConnection).filter(BankConnection.id == connection_id, BankConnection.provider == "up").first()
        if not connection:
            return {"error": "Up connection not found"}
        if connection.status != "active":
            return {"skipped": True, "reason": f"Status is {connection.status}"}
        if _should_skip_sync(SimpleNamespace(last_synced_at=None if force else connection.last_synced_at, sync_started_at=connection.sync_started_at)):
            return {"skipped": True, "reason": "sync_too_recent"}
        if not connection.credentials_encrypted:
            raise RuntimeError("Up connection has no encrypted access token")
        actor_id = connection.user_id
        connection.sync_started_at = datetime.now(timezone.utc)
        connection.last_sync_error = None
        db.commit()
        started = True
        access_token = decrypt_value(connection.credentials_encrypted)
        if not access_token:
            raise RuntimeError("Up connection token could not be decrypted")
        adapter = UpAdapter(access_token)
        live_accounts = {item.external_id: item for item in adapter.fetch_accounts()}
        accounts = db.query(Account).outerjoin(UpAccountSource, UpAccountSource.account_id == Account.id).filter(
            Account.is_active.is_(True), Account.consolidated_into_account_id.is_(None),
            or_(Account.bank_connection_id == connection.id, UpAccountSource.connection_id == connection.id),
            account_access(Account.id, actor_id),
        ).distinct().all()
        total_created = total_updated = 0
        touched_by_owner: dict[str, dict[str, set[str]]] = {}
        is_initial_sync = connection.last_synced_at is None
        end_date = datetime.now(timezone.utc)
        for candidate in accounts:
            # Retained legacy mappings and stale ORM instances must not revive an archive.
            if not candidate.is_active or getattr(candidate, "consolidated_into_account_id", None):
                continue
            account_id = candidate.id
            with up_account_sync_lock(account_id):
                db.expire_all()
                account = db.query(Account).filter(Account.id == account_id, Account.is_active.is_(True), account_access(Account.id, actor_id)).first()
                if not account:
                    continue
                source = db.query(UpAccountSource).filter(UpAccountSource.connection_id == connection.id, UpAccountSource.account_id == account.id).first()
                if source is None and account.user_id == actor_id and account.bank_connection_id == connection.id:
                    source = UpAccountSource(connection_id=connection.id, account_id=account.id, last_synced_at=account.last_synced_at)
                    db.add(source); db.commit()
                if source is None:
                    continue
                account_data = live_accounts.get(SyncService._resolve_account_external_id(account))
                if account_data is None:
                    continue
                start_date = _account_sync_start_date(SimpleNamespace(last_synced_at=source.last_synced_at), connection)
                provider_rows = adapter.fetch_transactions(account_data.external_id, start_date=start_date, end_date=end_date)
                # Fetch outside the consent lock. Each bounded write batch rechecks live
                # permission and its source binding before touching any canonical rows.
                for offset in range(0, max(1, len(provider_rows)), 500):
                    db.rollback()
                    db.execute(text("SELECT pg_advisory_xact_lock(73194, 1)"))
                    account = db.query(Account).filter(Account.id == account_id, Account.is_active.is_(True), account_access(Account.id, actor_id)).first()
                    source = db.query(UpAccountSource).filter(UpAccountSource.connection_id == connection.id, UpAccountSource.account_id == account_id).first()
                    live_connection = db.query(BankConnection).filter(BankConnection.id == connection_id, BankConnection.user_id == actor_id, BankConnection.status == "active").first()
                    if not account or not source or not live_connection:
                        db.rollback()
                        break
                    service = SyncService(db, user_id=account.user_id, use_llm_categorization=False)
                    created, updated, created_ids, updated_ids = service.sync_transactions(
                        adapter, account, start_date=start_date, end_date=end_date,
                        preloaded_transactions=provider_rows[offset:offset + 500], commit=False,
                        preserve_manual_edits=True, cleanup_csv_duplicates=False,
                    )
                    db.flush()
                    total_created += created; total_updated += updated
                    touched = touched_by_owner.setdefault(account.user_id, {"accounts": set(), "transactions": set()})
                    touched["accounts"].add(str(account.id)); touched["transactions"].update(created_ids + updated_ids)
                    if account_data.balance_available is not None:
                        account.balance_available = account_data.balance_available
                        account.balance_is_anchored = True
                    if account.balance_is_anchored and account.balance_available is not None:
                        txn_sum = db.query(func.sum(Transaction.amount)).filter(Transaction.account_id == account.id).scalar()
                        account.starting_balance = Decimal(str(account.balance_available)) - Decimal(str(txn_sum or 0))
                        owner = db.get(User, account.user_id)
                        target_currency = (owner.functional_currency or "EUR") if owner else (account.currency or "EUR")
                        functional = Decimal(str(account.balance_available))
                        if (account.currency or "EUR") != target_currency:
                            from app.services.exchange_rate_service import ExchangeRateService
                            functional = ExchangeRateService(db=db).convert_amount(functional, account.currency, target_currency, end_date.date())
                            if functional is None:
                                raise RuntimeError("Currency conversion unavailable for canonical Up balance")
                        account.functional_balance = functional
                    if offset + 500 >= len(provider_rows):
                        source.last_synced_at = end_date
                        account.last_synced_at = end_date
                    db.commit()
        connection = db.query(BankConnection).filter(BankConnection.id == connection_id).first()
        if connection:
            connection.last_synced_at = end_date
            connection.sync_started_at = None
            connection.last_sync_error = None
            db.commit()
        started = False
        linked_transfers = UpTransferLinkService(db, actor_id).link_explicit_transfers()
        for owner_id, touched in touched_by_owner.items():
            if touched["transactions"]:
                post_import_pipeline.delay(user_id=str(owner_id), account_ids=sorted(touched["accounts"]), transaction_ids=sorted(touched["transactions"]), is_initial_sync=is_initial_sync)
        return {"connection_id": connection_id, "transactions_created": total_created, "transactions_updated": total_updated, "transfers_linked": linked_transfers}
    except Exception as exc:
        logger.exception("Up sync failed for connection %s", connection_id)
        db.rollback()
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
