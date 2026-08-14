"""REST endpoints for investment connections, holdings, and portfolio."""
from __future__ import annotations

import csv
from io import StringIO
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.db_helpers import get_user_id
from app.integrations.price_provider import get_price_provider
from app.models import (
    Account,
    AccountBalance,
    BrokerConnection,
    BrokerTrade,
    CgtAllocation,
    Holding,
    HoldingValuation,
    InvestmentIncomeEvent,
    User,
)
from app.schemas import (
    BrokerConnectionCreate,
    HoldingCreate,
    HoldingLot,
    CgtAllocationResponse,
    CgtFinancialYearSummary,
    HoldingTrade,
    HoldingUpdate,
    HoldingResponse,
    InvestmentIncomeEventCreate,
    InvestmentIncomeEventResponse,
    InvestmentIncomeSummary,
    ManualAccountCreate,
    PortfolioSummary,
    SymbolSearchResult,
    ValuationPoint,
)
from app.services.pnl_service import Trade as _FifoTrade, compute_fifo
from app.services.broker_trade_service import ImportError as BrokerTradeImportError, import_trades, remove_trade
from app.services import credentials_crypto

logger = __import__("logging").getLogger(__name__)

# ---------------------------------------------------------------------------
# Helper: in-process sync (FastAPI BackgroundTask, no Celery/Redis required)
# ---------------------------------------------------------------------------


def _run_sync_in_process(account_id: UUID) -> None:
    """Sync one investment account in the FastAPI worker process.

    Used as a FastAPI BackgroundTask for user-triggered refreshes so the
    result is guaranteed regardless of whether the Celery broker is
    reachable from the backend service (scheduled nightly syncs still go
    through Celery beat → worker as before).
    """
    from uuid import UUID as _UUID
    from app.database import SessionLocal
    from app.services.investment_sync_service import InvestmentSyncService
    from app.services.exchange_rate_service import ExchangeRateService

    class _FxAdapter:
        def __init__(self, db):
            self._svc = ExchangeRateService(db=db)

        def convert(self, amount, src, dst, on):
            if src.upper() == dst.upper():
                return amount
            result = self._svc.convert_amount(
                amount=amount, from_currency=src, to_currency=dst, for_date=on,
            )
            return result if result is not None else amount

    logger.info("[INVESTMENT_SYNC] Starting in-process sync for account %s", account_id)
    db = SessionLocal()
    try:
        svc = InvestmentSyncService(db=db, fx=_FxAdapter(db))
        svc.sync_account(_UUID(str(account_id)))
        logger.info("[INVESTMENT_SYNC] Completed in-process sync for account %s", account_id)
    except Exception:
        logger.exception("[INVESTMENT_SYNC] Failed in-process sync for account %s", account_id)
    finally:
        db.close()


router = APIRouter()


def _owned_income_event_context(db: Session, user_id: str, payload: InvestmentIncomeEventCreate):
    account = db.query(Account).filter(Account.id == payload.account_id, Account.user_id == user_id).first()
    if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
        raise HTTPException(status_code=404, detail="Investment account not found")
    holding = db.query(Holding).filter(
        Holding.id == payload.holding_id,
        Holding.user_id == user_id,
        Holding.account_id == account.id,
    ).first()
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found in this investment account")
    return account, holding


def _save_income_event(
    db: Session,
    user_id: str,
    payload: InvestmentIncomeEventCreate,
    event: InvestmentIncomeEvent | None = None,
) -> InvestmentIncomeEvent:
    account, holding = _owned_income_event_context(db, user_id, payload)
    if payload.source_id:
        existing = db.query(InvestmentIncomeEvent).filter(
            InvestmentIncomeEvent.account_id == account.id,
            InvestmentIncomeEvent.source_id == payload.source_id,
        ).first()
        if existing and event is None:
            return existing
        if existing and existing.id != event.id:
            raise HTTPException(status_code=409, detail="An income event already uses this import source ID")
    if event is not None and event.reinvestment_trade_id:
        remove_trade(db, user_id, str(event.account_id), str(event.reinvestment_trade_id), commit=False)
        event.reinvestment_trade_id = None
    values = payload.model_dump()
    if event is None:
        event = InvestmentIncomeEvent(user_id=user_id, **values)
        db.add(event)
    else:
        for key, value in values.items():
            setattr(event, key, value)
    db.flush()
    if payload.is_drp:
        try:
            import_trades(db, user_id, str(account.id), [{
                "symbol": holding.symbol,
                "trade_date": payload.pay_date.isoformat(),
                "side": "buy",
                "quantity": payload.drp_quantity,
                "price": payload.drp_price,
                "currency": payload.currency,
                "fees": Decimal("0"),
                "external_id": f"income-event-drp:{event.id}",
            }], dry_run=False, commit=False)
        except BrokerTradeImportError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        trade = db.query(BrokerTrade).filter(
            BrokerTrade.account_id == account.id,
            BrokerTrade.external_id == f"income-event-drp:{event.id}",
        ).first()
        event.reinvestment_trade_id = trade.id if trade else None
    db.commit()
    db.refresh(event)
    return event


def _owned_income_event(db: Session, user_id: str, event_id: UUID) -> InvestmentIncomeEvent:
    event = (
        db.query(InvestmentIncomeEvent)
        .filter(InvestmentIncomeEvent.id == event_id, InvestmentIncomeEvent.user_id == user_id)
        .first()
    )
    if not event:
        raise HTTPException(status_code=404, detail="Investment income event not found")
    return event


def _financial_year_bounds(financial_year_start: int) -> tuple[date, date]:
    """Return the inclusive/exclusive Australian FY date range for a start year."""
    return date(financial_year_start, 7, 1), date(financial_year_start + 1, 7, 1)


# ---------------------------------------------------------------------------
# Investment income events
# ---------------------------------------------------------------------------


@router.post("/income-events", response_model=InvestmentIncomeEventResponse)
def create_investment_income_event(
    payload: InvestmentIncomeEventCreate,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Create an owned dividend/distribution event.

    A caller-supplied source_id makes imports idempotent per investment
    account. Tax fields are persisted exactly as supplied and never derived.
    """
    user_id = get_user_id(user_id)
    return _save_income_event(db, user_id, payload)


@router.get("/income-events", response_model=list[InvestmentIncomeEventResponse])
def list_investment_income_events(
    account_id: Optional[UUID] = None,
    holding_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    query = db.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.user_id == user_id)
    if account_id is not None:
        account = db.query(Account).filter(Account.id == account_id, Account.user_id == user_id).first()
        if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(InvestmentIncomeEvent.account_id == account.id)
    if holding_id is not None:
        holding = db.query(Holding).filter(Holding.id == holding_id, Holding.user_id == user_id).first()
        if not holding or (account_id is not None and holding.account_id != account_id):
            raise HTTPException(status_code=404, detail="Holding not found in this investment account")
        query = query.filter(InvestmentIncomeEvent.holding_id == holding.id)
    return query.order_by(InvestmentIncomeEvent.pay_date.desc(), InvestmentIncomeEvent.created_at.desc()).all()


@router.put("/income-events/{event_id:uuid}", response_model=InvestmentIncomeEventResponse)
def update_investment_income_event(
    event_id: UUID,
    payload: InvestmentIncomeEventCreate,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Replace an income event and rebuild its linked DRP trade when needed."""
    user_id = get_user_id(user_id)
    event = _owned_income_event(db, user_id, event_id)
    return _save_income_event(db, user_id, payload, event)


@router.delete("/income-events/{event_id:uuid}", status_code=204)
def delete_investment_income_event(
    event_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    event = _owned_income_event(db, user_id, event_id)
    if event.reinvestment_trade_id:
        try:
            remove_trade(db, user_id, str(event.account_id), str(event.reinvestment_trade_id), commit=False)
        except BrokerTradeImportError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.delete(event)
    db.commit()
    return None


@router.get("/income-events/summary", response_model=list[InvestmentIncomeSummary])
def investment_income_summary(
    financial_year_start: int = Query(..., ge=1900, le=2200),
    account_id: Optional[UUID] = None,
    holding_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Summarise statement-supplied income components by Australian FY/currency."""
    user_id = get_user_id(user_id)
    start, end = _financial_year_bounds(financial_year_start)
    query = db.query(
        InvestmentIncomeEvent.currency,
        func.coalesce(func.sum(InvestmentIncomeEvent.cash_received), 0).label("cash_income"),
        func.coalesce(func.sum(InvestmentIncomeEvent.franking_credit), 0).label("franking_credits"),
        func.coalesce(func.sum(InvestmentIncomeEvent.foreign_income), 0).label("foreign_income"),
        func.coalesce(func.sum(InvestmentIncomeEvent.foreign_tax_paid), 0).label("foreign_tax_paid"),
    ).filter(
        InvestmentIncomeEvent.user_id == user_id,
        InvestmentIncomeEvent.pay_date >= start,
        InvestmentIncomeEvent.pay_date < end,
    )
    if account_id is not None:
        account = db.query(Account).filter(Account.id == account_id, Account.user_id == user_id).first()
        if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(InvestmentIncomeEvent.account_id == account.id)
    if holding_id is not None:
        holding = db.query(Holding).filter(Holding.id == holding_id, Holding.user_id == user_id).first()
        if not holding or (account_id is not None and holding.account_id != account_id):
            raise HTTPException(status_code=404, detail="Holding not found in this investment account")
        query = query.filter(InvestmentIncomeEvent.holding_id == holding.id)
    rows = query.group_by(InvestmentIncomeEvent.currency).order_by(InvestmentIncomeEvent.currency).all()
    return [
        InvestmentIncomeSummary(
            financial_year_start=financial_year_start,
            currency=row.currency,
            cash_income=Decimal(row.cash_income),
            franking_credits=Decimal(row.franking_credits),
            foreign_income=Decimal(row.foreign_income),
            foreign_tax_paid=Decimal(row.foreign_tax_paid),
        )
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Broker connections
# ---------------------------------------------------------------------------


@router.post("/broker-connections")
def create_broker_connection(
    payload: BrokerConnectionCreate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)

    # Create the underlying brokerage account.
    account = Account(
        user_id=user_id,
        name=payload.account_name,
        account_type="investment_brokerage",
        currency=payload.base_currency,
        provider=payload.provider,
    )
    db.add(account)
    db.flush()

    creds = {
        "flex_token": payload.flex_token,
        "query_id_positions": payload.query_id_positions,
        "query_id_trades": payload.query_id_trades,
    }
    encrypted = credentials_crypto.encrypt(creds)

    conn = BrokerConnection(
        user_id=user_id,
        account_id=account.id,
        provider=payload.provider,
        credentials_encrypted=encrypted,
        last_sync_status="pending",
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)

    # Kick off background sync.
    background_tasks.add_task(_run_sync_in_process, account.id)

    return {
        "connection_id": str(conn.id),
        "account_id": str(account.id),
        "provider": conn.provider,
        "last_sync_status": conn.last_sync_status,
    }


@router.get("/broker-connections")
def list_broker_connections(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    conns = db.query(BrokerConnection).filter(BrokerConnection.user_id == user_id).all()
    return [
        {
            "id": str(c.id),
            "account_id": str(c.account_id),
            "provider": c.provider,
            "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None,
            "last_sync_status": c.last_sync_status,
            "last_sync_error": c.last_sync_error,
        }
        for c in conns
    ]


@router.post("/broker-connections/{connection_id}/sync")
def trigger_sync(
    connection_id: UUID,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    conn = (
        db.query(BrokerConnection)
        .filter(BrokerConnection.id == connection_id, BrokerConnection.user_id == user_id)
        .first()
    )
    if not conn:
        raise HTTPException(status_code=404, detail="Broker connection not found")
    background_tasks.add_task(_run_sync_in_process, conn.account_id)
    return {"status": "queued", "account_id": str(conn.account_id)}


@router.post("/sync-all")
def trigger_sync_all(
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Queue a price-refresh sync for every active investment account belonging
    to the user (manual + brokerage). Uses Celery when Redis is available,
    otherwise falls back to FastAPI BackgroundTasks (in-process)."""
    user_id = get_user_id(user_id)
    accounts = (
        db.query(Account)
        .filter(
            Account.user_id == user_id,
            Account.is_active.is_(True),
            Account.account_type.in_(["investment_manual", "investment_brokerage"]),
        )
        .all()
    )
    for account in accounts:
        background_tasks.add_task(_run_sync_in_process, account.id)
    return {"status": "queued", "count": len(accounts)}


@router.delete("/broker-connections/{connection_id}", status_code=204)
def delete_broker_connection(
    connection_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    conn = (
        db.query(BrokerConnection)
        .filter(BrokerConnection.id == connection_id, BrokerConnection.user_id == user_id)
        .first()
    )
    if not conn:
        raise HTTPException(status_code=404, detail="Broker connection not found")
    db.delete(conn)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Manual investment accounts
# ---------------------------------------------------------------------------


@router.post("/manual-accounts")
def create_manual_account(
    payload: ManualAccountCreate,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    account = Account(
        user_id=user_id,
        name=payload.name,
        account_type="investment_manual",
        currency=payload.base_currency,
        provider="manual",
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return {
        "account_id": str(account.id),
        "name": account.name,
        "currency": account.currency,
    }


@router.post("/manual-accounts/{account_id}/holdings")
def create_manual_holding(
    account_id: UUID,
    payload: HoldingCreate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    account = (
        db.query(Account)
        .filter(Account.id == account_id, Account.user_id == user_id)
        .first()
    )
    if not account or account.account_type != "investment_manual":
        raise HTTPException(status_code=404, detail="Manual investment account not found")

    # Resolve symbol metadata via the price provider.
    name: Optional[str] = None
    try:
        provider = get_price_provider()
        matches = provider.search_symbols(payload.symbol)
        if matches:
            top = matches[0]
            name = getattr(top, "name", None)
    except Exception:
        # Symbol lookup is best-effort; do not fail the holding creation.
        name = None

    holding = Holding(
        user_id=user_id,
        account_id=account.id,
        symbol=payload.symbol,
        provider_symbol=payload.provider_symbol or None,
        name=name,
        currency=payload.currency,
        instrument_type=payload.instrument_type,
        quantity=payload.quantity,
        avg_cost=payload.avg_cost,
        as_of_date=payload.as_of_date,
        source="manual",
    )
    db.add(holding)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"A {payload.instrument_type} holding for {payload.symbol} already "
                "exists in this account. Edit the existing holding instead of adding a new one."
            ),
        )
    db.refresh(holding)

    # Trigger an async revaluation so the new holding gets priced.
    background_tasks.add_task(_run_sync_in_process, account.id)

    return {
        "holding_id": str(holding.id),
        "account_id": str(account.id),
        "symbol": holding.symbol,
        "name": holding.name,
        "quantity": str(holding.quantity),
    }


# ---------------------------------------------------------------------------
# Holdings
# ---------------------------------------------------------------------------


@router.get("/holdings", response_model=list[HoldingResponse])
def list_holdings(
    account_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    user = db.query(User).filter(User.id == user_id).first()
    user_currency = (
        getattr(user, "functional_currency", None) or "EUR"
    ).upper()

    from app.services.exchange_rate_service import ExchangeRateService

    fx_svc = ExchangeRateService(db=db)

    def _convert_cost_to_user(
        avg_cost: Optional[Decimal],
        qty: Decimal,
        src_currency: str,
        on: Optional[date],
    ) -> Optional[Decimal]:
        if avg_cost is None:
            return None
        cost_native = Decimal(avg_cost) * Decimal(qty)
        src = (src_currency or user_currency).upper()
        if src == user_currency:
            return cost_native.quantize(Decimal("0.01"))
        for_date = on or date.today()
        # Use the fallback resolver: DB → yfinance backfill at as_of date →
        # today's FX. Avoids `cost_basis_user_currency = null` (which
        # makes the dashboard render P&L as "—") for older as_of dates
        # that don't have FX history yet.
        rate = fx_svc.get_exchange_rate_with_fallback(
            base_currency=src,
            target_currency=user_currency,
            for_date=for_date,
        )
        if rate is None:
            return None
        return (cost_native * Decimal(rate)).quantize(Decimal("0.01"))

    query = db.query(Holding).filter(Holding.user_id == user_id)
    if account_id is not None:
        query = query.filter(Holding.account_id == account_id)

    results: list[HoldingResponse] = []
    for h in query.all():
        latest_val = (
            db.query(HoldingValuation)
            .filter(HoldingValuation.holding_id == h.id)
            .order_by(desc(HoldingValuation.date))
            .first()
        )
        cost_basis_user = _convert_cost_to_user(
            h.avg_cost, h.quantity, h.currency, h.as_of_date
        )
        results.append(
            HoldingResponse(
                id=h.id,
                account_id=h.account_id,
                symbol=h.symbol,
                provider_symbol=h.provider_symbol,
                name=h.name,
                currency=h.currency,
                instrument_type=h.instrument_type,
                quantity=h.quantity,
                avg_cost=h.avg_cost,
                as_of_date=h.as_of_date,
                source=h.source,
                current_price=latest_val.price if latest_val else None,
                current_value_user_currency=(
                    latest_val.value_user_currency if latest_val else None
                ),
                cost_basis_user_currency=cost_basis_user,
                is_stale=bool(latest_val.is_stale) if latest_val else False,
            )
        )
    return results


@router.patch("/holdings/{holding_id}")
def update_holding(
    holding_id: UUID,
    updates: HoldingUpdate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    holding = (
        db.query(Holding)
        .filter(Holding.id == holding_id, Holding.user_id == user_id)
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if holding.source != "manual":
        raise HTTPException(status_code=400, detail="Only manual holdings can be edited")

    payload = updates.model_dump(exclude_unset=True)
    lookup_changed = (
        ("symbol" in payload and payload["symbol"] != holding.symbol)
        or ("provider_symbol" in payload and payload["provider_symbol"] != holding.provider_symbol)
    )
    for field, value in payload.items():
        setattr(holding, field, value)
    db.commit()
    db.refresh(holding)

    # Re-price the account if the lookup symbol changed so the new ticker
    # gets fetched from the price provider immediately.
    if lookup_changed:
        background_tasks.add_task(_run_sync_in_process, holding.account_id)

    return {"id": str(holding.id), "symbol": holding.symbol, "quantity": str(holding.quantity)}


@router.delete("/holdings/{holding_id}", status_code=204)
def delete_holding(
    holding_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    holding = (
        db.query(Holding)
        .filter(Holding.id == holding_id, Holding.user_id == user_id)
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if holding.source != "manual":
        raise HTTPException(status_code=400, detail="Only manual holdings can be deleted")
    db.delete(holding)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Portfolio
# ---------------------------------------------------------------------------


@router.get("/portfolio/summary", response_model=PortfolioSummary)
def portfolio_summary(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    user = db.query(User).filter(User.id == user_id).first()
    currency = getattr(user, "functional_currency", "EUR") or "EUR"

    accounts = (
        db.query(Account)
        .filter(
            Account.user_id == user_id,
            Account.account_type.in_(["investment_brokerage", "investment_manual"]),
        )
        .all()
    )

    total_value = Decimal("0")
    today_change = Decimal("0")
    allocation_by_type: dict[str, Decimal] = {}
    allocation_by_currency: dict[str, Decimal] = {}
    accounts_payload: list[dict] = []

    for account in accounts:
        # Account total = sum of latest valuations across its holdings.
        account_value = Decimal("0")
        holdings = db.query(Holding).filter(Holding.account_id == account.id).all()
        for h in holdings:
            latest = (
                db.query(HoldingValuation)
                .filter(HoldingValuation.holding_id == h.id)
                .order_by(desc(HoldingValuation.date))
                .first()
            )
            if latest:
                account_value += Decimal(latest.value_user_currency)
                allocation_by_type[h.instrument_type] = (
                    allocation_by_type.get(h.instrument_type, Decimal("0"))
                    + Decimal(latest.value_user_currency)
                )
                allocation_by_currency[h.currency] = (
                    allocation_by_currency.get(h.currency, Decimal("0"))
                    + Decimal(latest.value_user_currency)
                )

        total_value += account_value

        # Today change: today's snapshot vs the immediately prior snapshot.
        # Skip if no snapshot for today (e.g. weekend, holiday, missed Celery run)
        # so we don't surface a stale delta as "today's" movement.
        today_iso = date.today()
        latest_balance = (
            db.query(AccountBalance)
            .filter(
                AccountBalance.account_id == account.id,
                AccountBalance.date == today_iso,
            )
            .order_by(desc(AccountBalance.date))
            .first()
        )
        if latest_balance is not None:
            prior_balance = (
                db.query(AccountBalance)
                .filter(
                    AccountBalance.account_id == account.id,
                    AccountBalance.date < today_iso,
                )
                .order_by(desc(AccountBalance.date))
                .first()
            )
            if prior_balance is not None:
                today_change += Decimal(
                    latest_balance.balance_in_functional_currency
                ) - Decimal(prior_balance.balance_in_functional_currency)

        accounts_payload.append(
            {
                "id": str(account.id),
                "name": account.name,
                "type": account.account_type,
                "currency": account.currency,
                "value": str(account_value),
            }
        )

    return PortfolioSummary(
        total_value=total_value,
        total_value_today_change=today_change,
        currency=currency,
        accounts=accounts_payload,
        allocation_by_type=allocation_by_type,
        allocation_by_currency=allocation_by_currency,
    )


@router.get("/holdings/{holding_id}/history", response_model=list[ValuationPoint])
def holding_history(
    holding_id: UUID,
    days: int = Query(30, ge=1, le=3650),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    holding = (
        db.query(Holding)
        .filter(Holding.id == holding_id, Holding.user_id == user_id)
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    end_date = to_date or date.today()
    cutoff = from_date or (date.today() - timedelta(days=days))
    if end_date < cutoff:
        raise HTTPException(status_code=400, detail="to must be on or after from")
    rows = (
        db.query(HoldingValuation)
        .filter(
            HoldingValuation.holding_id == holding_id,
            HoldingValuation.date >= cutoff,
            HoldingValuation.date <= end_date,
        )
        .order_by(HoldingValuation.date.asc())
        .all()
    )
    return [
        ValuationPoint(date=r.date, value=Decimal(r.value_user_currency))
        for r in rows
    ]


@router.get("/portfolio/history", response_model=list[ValuationPoint])
def portfolio_history(
    days: int = Query(30, ge=1, le=3650),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    end_date = to_date or date.today()
    cutoff = from_date or (date.today() - timedelta(days=days))
    if end_date < cutoff:
        raise HTTPException(status_code=400, detail="to must be on or after from")

    accounts = (
        db.query(Account.id)
        .filter(
            Account.user_id == user_id,
            Account.account_type.in_(["investment_brokerage", "investment_manual"]),
        )
        .all()
    )
    account_ids = [a.id for a in accounts]
    if not account_ids:
        return []

    rows = (
        db.query(AccountBalance)
        .filter(
            AccountBalance.account_id.in_(account_ids),
            AccountBalance.date >= cutoff,
            AccountBalance.date <= end_date,
        )
        .order_by(AccountBalance.date.asc())
        .all()
    )

    by_date: dict[date, Decimal] = {}
    for r in rows:
        d = r.date.date() if isinstance(r.date, datetime) else r.date
        by_date[d] = by_date.get(d, Decimal("0")) + Decimal(r.balance_in_functional_currency)

    return [ValuationPoint(date=d, value=v) for d, v in sorted(by_date.items())]


@router.get("/holdings/{holding_id}/trades", response_model=list[HoldingTrade])
def holding_trades(
    holding_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return all BrokerTrade rows behind this holding (account_id, symbol),
    chronologically. Each row carries a running quantity (post-trade)."""
    user_id = get_user_id(user_id)
    holding = (
        db.query(Holding)
        .filter(Holding.id == holding_id, Holding.user_id == user_id)
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    trades = (
        db.query(BrokerTrade)
        .filter(
            BrokerTrade.account_id == holding.account_id,
            BrokerTrade.symbol == holding.symbol,
        )
        .order_by(BrokerTrade.trade_date.asc(), BrokerTrade.id.asc())
        .all()
    )

    out: list[HoldingTrade] = []
    running = Decimal("0")
    for t in trades:
        qty = Decimal(t.quantity)
        price = Decimal(t.price)
        fees = Decimal(t.fees or 0)
        if t.side == "buy":
            running += qty
            cost_native = qty * price + fees
            proceeds_native = None
        else:
            running -= qty
            cost_native = None
            proceeds_native = qty * price - fees
        out.append(
            HoldingTrade(
                id=t.id,
                trade_date=t.trade_date,
                symbol=t.symbol,
                side=t.side,
                quantity=qty,
                price=price,
                currency=t.currency,
                fees=fees,
                external_id=t.external_id,
                cost_native=cost_native,
                proceeds_native=proceeds_native,
                running_quantity=running,
            )
        )
    return out


@router.get("/holdings/{holding_id}/lots", response_model=list[HoldingLot])
def holding_lots(
    holding_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return the open FIFO lots for this holding."""
    user_id = get_user_id(user_id)
    holding = (
        db.query(Holding)
        .filter(Holding.id == holding_id, Holding.user_id == user_id)
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    trades = (
        db.query(BrokerTrade)
        .filter(
            BrokerTrade.account_id == holding.account_id,
            BrokerTrade.symbol == holding.symbol,
        )
        .order_by(BrokerTrade.trade_date.asc(), BrokerTrade.id.asc())
        .all()
    )
    if not trades:
        return []

    fifo_trades = [
        _FifoTrade(
            symbol=t.symbol,
            trade_date=t.trade_date,
            side=t.side,
            quantity=Decimal(t.quantity),
            price=Decimal(t.price),
            currency=t.currency,
            fees=Decimal(t.fees or 0),
        )
        for t in trades
    ]
    fifo = compute_fifo(fifo_trades)

    user = db.query(User).filter(User.id == user_id).first()
    user_currency = (
        getattr(user, "functional_currency", None) or holding.currency or "EUR"
    ).upper()

    from app.services.exchange_rate_service import ExchangeRateService

    fx_svc = ExchangeRateService(db=db)
    today = date.today()

    out: list[HoldingLot] = []
    for lot in fifo.open_lots:
        if lot.symbol != holding.symbol:
            continue
        cost_per_share_user: Optional[Decimal] = None
        if lot.currency.upper() == user_currency:
            cost_per_share_user = lot.cost_per_share_native
        else:
            rate = fx_svc.get_exchange_rate_with_fallback(
                lot.currency.upper(), user_currency, lot.open_date
            )
            if rate is not None:
                cost_per_share_user = (
                    Decimal(lot.cost_per_share_native) * Decimal(rate)
                ).quantize(Decimal("0.00000001"))
        out.append(
            HoldingLot(
                open_date=lot.open_date,
                quantity_remaining=lot.quantity_remaining,
                cost_per_share_native=lot.cost_per_share_native,
                cost_per_share_user=cost_per_share_user,
                age_days=(today - lot.open_date).days,
                currency=lot.currency,
            )
        )
    return out


@router.get("/holdings/{holding_id}/cgt-allocations", response_model=list[CgtAllocationResponse])
def holding_cgt_allocations(
    holding_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return persisted FIFO allocation rows for disposals of this holding."""
    user_id = get_user_id(user_id)
    holding = db.query(Holding).filter(Holding.id == holding_id, Holding.user_id == user_id).first()
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    return db.query(CgtAllocation).filter(
        CgtAllocation.account_id == holding.account_id,
        CgtAllocation.symbol == holding.symbol,
    ).order_by(CgtAllocation.disposal_date.desc(), CgtAllocation.id.asc()).all()


def _cgt_allocations_query(
    db: Session,
    user_id: str,
    financial_year_start: Optional[int] = None,
    account_id: Optional[UUID] = None,
):
    query = db.query(CgtAllocation).join(Account, Account.id == CgtAllocation.account_id).filter(
        Account.user_id == user_id,
    )
    if financial_year_start is not None:
        start, end = _financial_year_bounds(financial_year_start)
        query = query.filter(
            CgtAllocation.disposal_date >= start,
            CgtAllocation.disposal_date < end,
        )
    if account_id is not None:
        account = db.query(Account).filter(Account.id == account_id, Account.user_id == user_id).first()
        if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(CgtAllocation.account_id == account.id)
    return query.order_by(CgtAllocation.disposal_date.desc(), CgtAllocation.id.asc())


def _cgt_export_csv(rows: list[CgtAllocation]) -> str:
    """Serialize persisted allocations without deriving or hiding tax-relevant values."""
    fields = [
        "allocation_id", "account_id", "acquisition_trade_id", "disposal_trade_id", "symbol",
        "acquisition_date", "disposal_date", "quantity", "currency", "cost_base_native",
        "proceeds_native", "gain_native", "cost_base_aud", "proceeds_aud", "gain_aud",
        "fx_missing", "discount_eligible", "calculation_version", "assumptions",
    ]
    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow({
            "allocation_id": row.id,
            "account_id": row.account_id,
            "acquisition_trade_id": row.acquisition_trade_id,
            "disposal_trade_id": row.disposal_trade_id,
            "symbol": row.symbol,
            "acquisition_date": row.acquisition_date.isoformat(),
            "disposal_date": row.disposal_date.isoformat(),
            "quantity": row.quantity,
            "currency": row.currency,
            "cost_base_native": row.cost_base_native,
            "proceeds_native": row.proceeds_native,
            "gain_native": row.gain_native,
            "cost_base_aud": row.cost_base_aud if row.cost_base_aud is not None else "",
            "proceeds_aud": row.proceeds_aud if row.proceeds_aud is not None else "",
            "gain_aud": row.gain_aud if row.gain_aud is not None else "",
            "fx_missing": str(bool(row.fx_missing)).lower(),
            "discount_eligible": str(bool(row.discount_eligible)).lower(),
            "calculation_version": row.calculation_version,
            "assumptions": " | ".join(row.assumptions or []),
        })
    return output.getvalue()


@router.get("/cgt/allocations", response_model=list[CgtAllocationResponse])
def cgt_allocations(
    financial_year_start: Optional[int] = Query(None, ge=1900, le=2200),
    account_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return the user's persisted CGT allocation records, optionally for one FY/account."""
    user_id = get_user_id(user_id)
    return _cgt_allocations_query(db, user_id, financial_year_start, account_id).all()


@router.get("/cgt/export.csv")
def export_cgt_allocations_csv(
    financial_year_start: int = Query(..., ge=1900, le=2200),
    account_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Download the authenticated user's Australian-FY CGT allocation audit trail."""
    user_id = get_user_id(user_id)
    rows = _cgt_allocations_query(db, user_id, financial_year_start, account_id).all()
    filename = f"cgt-allocations-fy{financial_year_start}-{financial_year_start + 1}.csv"
    return StreamingResponse(
        iter([_cgt_export_csv(rows)]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/cgt/summary", response_model=CgtFinancialYearSummary)
def cgt_financial_year_summary(
    financial_year_start: int = Query(..., ge=1900, le=2200),
    account_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Summarise recorded Australian-dollar CGT allocations for an Australian FY.

    This is a calculation record, not tax advice. Allocations lacking either
    transaction-date FX rate are deliberately excluded from AUD totals.
    """
    user_id = get_user_id(user_id)
    rows = _cgt_allocations_query(db, user_id, financial_year_start, account_id).all()
    known = [row for row in rows if not row.fx_missing and row.gain_aud is not None]
    gross_gains = sum((max(Decimal(row.gain_aud), Decimal("0")) for row in known), Decimal("0"))
    losses = sum((max(-Decimal(row.gain_aud), Decimal("0")) for row in known), Decimal("0"))
    discounted = sum((Decimal(row.gain_aud) / 2 for row in known if row.discount_eligible and row.gain_aud > 0), Decimal("0"))
    net_before_losses = sum((
        Decimal(row.gain_aud) / 2 if row.discount_eligible and row.gain_aud > 0 else Decimal(row.gain_aud)
        for row in known
    ), Decimal("0"))
    assumptions = [
        "FIFO matching is calculated from recorded broker trades and their recorded fees.",
        "Corporate actions, managed-fund cost-base adjustments, and other tax elections are not calculated.",
    ]
    missing = len(rows) - len(known)
    if missing:
        assumptions.append(f"{missing} allocation(s) excluded from AUD totals because transaction-date FX is missing.")
    return CgtFinancialYearSummary(
        financial_year_start=financial_year_start,
        gross_gains_aud=gross_gains.quantize(Decimal("0.01")),
        capital_losses_aud=losses.quantize(Decimal("0.01")),
        discounted_gains_aud=discounted.quantize(Decimal("0.01")),
        net_capital_gain_before_losses_aud=net_before_losses.quantize(Decimal("0.01")),
        allocation_count=len(rows),
        missing_fx_allocation_count=missing,
        assumptions=assumptions,
    )


# ---------------------------------------------------------------------------
# Symbol search
# ---------------------------------------------------------------------------


@router.get("/symbols/search", response_model=list[SymbolSearchResult])
def search_symbols(q: str = Query(..., min_length=1)):
    provider = get_price_provider()
    matches = provider.search_symbols(q)
    return [
        SymbolSearchResult(
            symbol=getattr(m, "symbol", ""),
            name=getattr(m, "name", ""),
            exchange=getattr(m, "exchange", None),
            currency=getattr(m, "currency", None),
        )
        for m in matches
    ]
