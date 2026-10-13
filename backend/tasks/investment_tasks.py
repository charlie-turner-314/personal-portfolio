from __future__ import annotations
from datetime import date, datetime
import logging
import os
from uuid import UUID
from celery import shared_task
from sqlalchemy import func

from app.database import SessionLocal
from app.models import Account, BrokerConnection, User
from app.services.investment_sync_service import InvestmentSyncService
from app.services.exchange_rate_service import ExchangeRateService
from app.integrations.ibkr_flex_adapter import FlexStatementNotReady
from app.integrations.coinspot_adapter import CoinSpotTransientError
from app.integrations.binance_adapter import BinanceTransientError
from app.integrations.crypto_com_exchange_adapter import CryptoComExchangeTransientError

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_demo_user_id(db) -> str | None:
    """Resolve the shared demo user's id when demo mode is enabled.

    The demo portfolio is seeded directly with deterministic valuations and
    must NOT be touched by the real IBKR/price sync (no valid Flex token, and
    live price fetches would make the data non-deterministic)."""
    if not _env_bool("DEMO_MODE", default=False):
        return None
    user_id = os.getenv("DEMO_SHARED_USER_ID")
    if user_id:
        return user_id
    email = os.getenv("DEMO_SHARED_USER_EMAIL")
    if not email:
        return None
    user = db.query(User).filter(func.lower(User.email) == email.strip().lower()).first()
    return user.id if user else None


class _FxAdapter:
    """Adapts ExchangeRateService.convert_amount to the FxConverter protocol."""
    def __init__(self, db):
        self.db = db
        self._svc = ExchangeRateService(db=db)

    def convert(self, amount, src, dst, on):
        if src.upper() == dst.upper():
            return amount
        result = self._svc.convert_amount(
            amount=amount,
            from_currency=src,
            to_currency=dst,
            for_date=on,
        )
        return result if result is not None else amount


@shared_task(name="tasks.investment_tasks.daily_investment_sync_all")
def daily_investment_sync_all() -> dict:
    db = SessionLocal()
    try:
        demo_user_id = _resolve_demo_user_id(db)

        # Fail loudly on misconfiguration: demo mode is on but we can't identify
        # the demo user. Raising (rather than returning a success-like result)
        # surfaces the deploy error in task monitoring, and aborting before the
        # sync still protects the seeded demo portfolio — its holdings have no
        # valid Flex token and must keep their deterministic valuations.
        if _env_bool("DEMO_MODE", default=False) and not demo_user_id:
            raise RuntimeError(
                "DEMO_MODE is enabled but the demo user identity "
                "(DEMO_SHARED_USER_ID / DEMO_SHARED_USER_EMAIL) is not configured "
                "or resolvable; refusing to run investment sync."
            )

        now = datetime.utcnow()
        broker_q = (
            db.query(Account, BrokerConnection)
            .join(BrokerConnection, BrokerConnection.account_id == Account.id)
            .filter(
                Account.is_active == True,
                Account.account_type == "investment_brokerage",
                (
                    BrokerConnection.next_retry_at.is_(None)
                    | (BrokerConnection.next_retry_at <= now)
                ),
            )
        )
        manual_q = (
            db.query(Account)
            .filter(Account.is_active == True, Account.account_type == "investment_manual")
        )
        if demo_user_id:
            broker_q = broker_q.filter(Account.user_id != demo_user_id)
            manual_q = manual_q.filter(Account.user_id != demo_user_id)

        broker_rows = broker_q.all()
        broker_account_ids = [account.id for account, _connection in broker_rows]
        manual_account_ids = [a.id for a in manual_q.all()]
        queued_at = now.isoformat()
        for _account, connection in broker_rows:
            connection.health_details = {
                **(connection.health_details or {}),
                "scheduled_sync": "daily",
                "scheduled_sync_queued_at": queued_at,
            }
        if broker_rows:
            db.commit()
        all_ids = list(broker_account_ids) + list(manual_account_ids)
        for aid in all_ids:
            sync_investment_account.delay(str(aid))
        return {"queued": len(all_ids), "demo_excluded": bool(demo_user_id)}
    finally:
        db.close()


@shared_task(
    name="tasks.investment_tasks.sync_investment_account",
    bind=True,
    autoretry_for=(FlexStatementNotReady, CoinSpotTransientError),
    retry_backoff=True,
    retry_backoff_max=1800,
    retry_jitter=True,
    max_retries=6,
)
def sync_investment_account(self, account_id: str) -> dict:
    db = SessionLocal()
    try:
        svc = InvestmentSyncService(db=db, fx=_FxAdapter(db))
        svc.sync_account(UUID(account_id))
        return {"account_id": account_id, "status": "ok"}
    except (FlexStatementNotReady, CoinSpotTransientError):
        raise
    except (BinanceTransientError, CryptoComExchangeTransientError) as exc:
        retry_after = int(exc.retry_after_seconds or 0)
        exponential = min(60 * (2 ** int(self.request.retries or 0)), 3600)
        raise self.retry(
            exc=exc,
            countdown=min(max(retry_after, exponential), 259200),
            max_retries=6,
        )
    except Exception:
        logger.exception("Investment sync failed for %s", account_id)
        raise
    finally:
        db.close()
