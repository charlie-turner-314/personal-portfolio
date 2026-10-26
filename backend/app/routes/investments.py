"""REST endpoints for investment connections, holdings, and portfolio."""
from __future__ import annotations

import csv
import os
from io import StringIO
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.db_helpers import get_user_id
from app.services.investment_scope import InvestmentScope
from app.services.financial_access import account_access, value_in_actor_currency as _value_in_actor_currency
from app.integrations.price_provider import get_price_provider
from app.integrations.coinspot_adapter import (
    CoinSpotAdapter,
    CoinSpotAuthError,
    CoinSpotError,
    CoinSpotReadOnlyClient,
    CoinSpotTransientError,
)
from app.integrations.binance_adapter import (
    BinanceAdapter,
    BinanceAuthError,
    BinanceError,
    BinancePermissionError,
    BinanceReadOnlyClient,
    BinanceTransientError,
)
from app.integrations.crypto_com_exchange_adapter import (
    CryptoComExchangeAdapter,
    CryptoComExchangeAuthError,
    CryptoComExchangeError,
    CryptoComExchangeReadOnlyClient,
    CryptoComExchangeTransientError,
)
from app.models import (
    Account,
    AccountBalance,
    BrokerConnection,
    BrokerTrade,
    CgtAllocation,
    Holding,
    HoldingValuation,
    PriceSnapshot,
    InvestmentIncomeEvent,
    InvestmentCostBaseAdjustment,
    InvestmentCryptoTransfer,
    InvestmentIngestionRun,
    InvestmentReconciliationItem,
    InvestmentSourceRecord,
    CsvImportProfile,
    User,
)
from app.investment_import_schemas import (
    InvestmentImportApplyRequest,
    InvestmentImportProfileSave,
    InvestmentImportRequest,
)
from app.schemas import (
    BinanceTradeSymbolsUpdate,
    BrokerConnectionCreate,
    CoinSpotCredentialsUpdate,
    HoldingCreate,
    HoldingLot,
    CgtAllocationResponse,
    CgtFinancialYearSummary,
    HoldingTrade,
    HoldingUpdate,
    HoldingResponse,
    ManualPriceCreate,
    InvestmentIncomeEventCreate,
    InvestmentIncomeEventResponse,
    InvestmentIncomeSummary,
    InvestmentCryptoTransferResolve,
    InvestmentReconciliationResolve,
    ManualAccountCreate,
    PortfolioSummary,
    SymbolSearchResult,
    ValuationPoint,
)
from app.services.pnl_service import CostBaseAdjustment as _FifoAdjustment, Trade as _FifoTrade, compute_fifo
from app.services.broker_trade_service import ImportError as BrokerTradeImportError, import_trades, remove_trade
from app.services import credentials_crypto
from app.services.investment_activity_service import ActivityApplicationError, revert_run, source_record_view
from app.services.investment_csv_import_service import (
    InvestmentCsvImportError,
    apply_investment_csv,
    normalize_provider,
    preview_investment_csv,
)
from app.services.investment_income_reconciliation_service import (
    INCOME_COMPONENT_FIELDS,
    reconciliation_item_view,
    resolve_reconciliation_item,
)
from app.services.crypto_accounting_service import (
    confirm_owned_crypto_transfer,
    transfer_view,
)

logger = __import__("logging").getLogger(__name__)


def _ingestion_run_view(run: InvestmentIngestionRun) -> dict:
    return {
        "id": str(run.id),
        "account_id": str(run.account_id),
        "provider": run.provider,
        "ingestion_type": run.ingestion_type,
        "status": run.status,
        "source_name": run.source_name,
        "summary": run.summary or {},
        "warnings": run.warnings or [],
        "error": run.error,
        "started_at": run.started_at.isoformat(),
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "reverted_at": run.reverted_at.isoformat() if run.reverted_at else None,
    }


def _investment_sync_hour_utc() -> int:
    try:
        value = int(os.getenv("PERSONAL_PORTFOLIO_INVESTMENT_SYNC_HOUR_UTC", "2"))
    except ValueError:
        value = 2
    return max(0, min(23, value))

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

    from app.services.investment_fx import InvestmentFxAdapter as _FxAdapter

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


def _enqueue_account_refresh(db, background_tasks, account_id):
    account = db.query(Account).filter_by(id=account_id).one()
    account.investment_sync_state = {"request_id": str(uuid4()), "status": "queued", "queued_at": datetime.utcnow().isoformat(), "error": None}
    db.commit()
    background_tasks.add_task(_run_sync_in_process, account_id)


router = APIRouter()


def _save_investment_import_profile(
    db: Session,
    *,
    user_id: str,
    payload: InvestmentImportProfileSave,
) -> CsvImportProfile:
    account = db.query(Account).filter(Account.id == payload.account_id, Account.user_id == user_id).one_or_none()
    if account is None or account.account_type not in {"investment_manual", "investment_brokerage"}:
        raise HTTPException(status_code=404, detail="Investment account not found")
    provider = normalize_provider(payload.provider)
    profile = db.query(CsvImportProfile).filter(
        CsvImportProfile.user_id == user_id,
        CsvImportProfile.account_id == account.id,
        CsvImportProfile.import_kind == "investments",
        CsvImportProfile.provider == provider,
        CsvImportProfile.profile_variant == payload.income_data_kind,
    ).one_or_none()
    if profile is None:
        profile = CsvImportProfile(
            user_id=user_id,
            account_id=account.id,
            import_kind="investments",
            provider=provider,
            profile_variant=payload.income_data_kind,
            name=payload.name,
            column_mapping=payload.stored_mapping(),
            header_signature=payload.header_signature,
            last_used_at=datetime.utcnow(),
        )
        db.add(profile)
    else:
        profile.name = payload.name
        profile.profile_variant = payload.income_data_kind
        profile.column_mapping = payload.stored_mapping()
        profile.header_signature = payload.header_signature
        profile.last_used_at = datetime.utcnow()
        profile.updated_at = datetime.utcnow()
    db.flush()
    return profile


def _import_profile_view(profile: CsvImportProfile) -> dict:
    return {
        "id": str(profile.id),
        "account_id": str(profile.account_id),
        "provider": profile.provider,
        "profile_variant": profile.profile_variant,
        "name": profile.name,
        "mapping": profile.column_mapping,
        "header_signature": profile.header_signature or [],
        "last_used_at": profile.last_used_at.isoformat() if profile.last_used_at else None,
    }


# ---------------------------------------------------------------------------
# Generic investment file imports
# ---------------------------------------------------------------------------


@router.post("/imports/preview")
def preview_investment_import(
    payload: InvestmentImportRequest,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    try:
        _, response = preview_investment_csv(
            db,
            user_id=user_id,
            account_id=payload.account_id,
            parse_options=payload.parse_options(),
        )
        return response
    except InvestmentCsvImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/imports")
def apply_investment_import(
    payload: InvestmentImportApplyRequest,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    try:
        result = apply_investment_csv(
            db,
            user_id=user_id,
            account_id=payload.account_id,
            parse_options=payload.parse_options(),
            selected_row_numbers=payload.selected_row_numbers,
        )
        if payload.save_mapping:
            profile_payload = InvestmentImportProfileSave(
                account_id=payload.account_id,
                provider=payload.provider,
                name=payload.mapping_name,
                mapping=payload.mapping,
                date_format=payload.date_format,
                amount_format=payload.amount_format,
                default_asset_type=payload.default_asset_type,
                default_currency=payload.default_currency,
                default_activity_type=payload.default_activity_type,
                activity_type_aliases=payload.activity_type_aliases,
                income_data_kind=payload.income_data_kind,
                header_signature=result["headers"],
            )
            profile = _save_investment_import_profile(db, user_id=user_id, payload=profile_payload)
            db.commit()
            result["profile_id"] = str(profile.id)
        _enqueue_account_refresh(db, background_tasks, payload.account_id)
        return result
    except (InvestmentCsvImportError, ActivityApplicationError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/imports")
def list_investment_imports(
    account_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    query = db.query(InvestmentIngestionRun).filter(
        InvestmentIngestionRun.user_id == user_id,
        InvestmentIngestionRun.ingestion_type == "csv_import",
    )
    if account_id is not None:
        query = query.filter(InvestmentIngestionRun.account_id == account_id)
    return [
        _ingestion_run_view(run)
        for run in query.order_by(InvestmentIngestionRun.started_at.desc()).limit(100).all()
    ]


@router.get("/ingestion-runs")
def list_investment_ingestion_runs(
    account_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return CSV and API ingestion history through one operational view."""
    user_id = get_user_id(user_id)
    query = db.query(InvestmentIngestionRun).filter(
        InvestmentIngestionRun.user_id == user_id
    )
    if account_id is not None:
        query = query.filter(InvestmentIngestionRun.account_id == account_id)
    return [
        _ingestion_run_view(run)
        for run in query.order_by(InvestmentIngestionRun.started_at.desc()).limit(100).all()
    ]


@router.get("/ingestion-runs/{run_id:uuid}/source-records")
def list_investment_ingestion_source_records(
    run_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    run = db.query(InvestmentIngestionRun).filter(
        InvestmentIngestionRun.id == run_id,
        InvestmentIngestionRun.user_id == user_id,
    ).one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Investment ingestion run not found")
    records = db.query(InvestmentSourceRecord).filter(
        InvestmentSourceRecord.run_id == run.id,
        InvestmentSourceRecord.user_id == user_id,
    ).order_by(InvestmentSourceRecord.occurred_at, InvestmentSourceRecord.created_at).all()
    return [source_record_view(record) for record in records]


@router.get("/imports/{run_id:uuid}/source-records")
def list_investment_import_source_records(
    run_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    run = db.query(InvestmentIngestionRun).filter(
        InvestmentIngestionRun.id == run_id,
        InvestmentIngestionRun.user_id == user_id,
        InvestmentIngestionRun.ingestion_type == "csv_import",
    ).one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Investment import not found")
    records = db.query(InvestmentSourceRecord).filter(
        InvestmentSourceRecord.run_id == run.id,
        InvestmentSourceRecord.user_id == user_id,
    ).order_by(InvestmentSourceRecord.occurred_at, InvestmentSourceRecord.created_at).all()
    return [source_record_view(record) for record in records]


@router.post("/imports/{run_id:uuid}/revert")
def revert_investment_import(
    run_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    try:
        return revert_run(db, user_id=user_id, run_id=run_id)
    except ActivityApplicationError as exc:
        status_code = 404 if "not found" in str(exc) else 400
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc


@router.get("/import-profiles")
def list_investment_import_profiles(
    account_id: UUID,
    provider: Optional[str] = None,
    income_data_kind: Optional[str] = Query(default=None, pattern="^(cash_activity|annual_statement)$"),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    account = db.query(Account).filter(Account.id == account_id, Account.user_id == user_id).one_or_none()
    if account is None:
        raise HTTPException(status_code=404, detail="Investment account not found")
    query = db.query(CsvImportProfile).filter(
        CsvImportProfile.user_id == user_id,
        CsvImportProfile.account_id == account.id,
        CsvImportProfile.import_kind == "investments",
    )
    if provider:
        query = query.filter(CsvImportProfile.provider == normalize_provider(provider))
    if income_data_kind:
        query = query.filter(CsvImportProfile.profile_variant == income_data_kind)
    return [_import_profile_view(profile) for profile in query.order_by(CsvImportProfile.last_used_at.desc()).all()]


@router.put("/import-profiles")
def save_investment_import_profile(
    payload: InvestmentImportProfileSave,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    try:
        profile = _save_investment_import_profile(db, user_id=user_id, payload=payload)
        db.commit()
        db.refresh(profile)
        return _import_profile_view(profile)
    except InvestmentCsvImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    if payload.event_type in {"interest", "staking_reward", "airdrop"}:
        raise HTTPException(
            status_code=400,
            detail=(
                "Crypto income is managed through activity imports so its receipt-time value "
                "and acquisition cost base stay linked."
            ),
        )
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
    now = datetime.utcnow()
    manual_source = {"kind": "manual", "confirmed_at": now.isoformat()}
    component_sources = dict(event.component_sources or {}) if event is not None else {}
    for field in ("cash_received", "asset_quantity", "aud_market_value", *INCOME_COMPONENT_FIELDS):
        if values.get(field) is None:
            continue
        entries = component_sources.get(field, [])
        if isinstance(entries, dict):
            entries = [entries]
        elif not isinstance(entries, list):
            entries = []
        component_sources[field] = [*entries, manual_source]
    if event is None:
        event = InvestmentIncomeEvent(
            user_id=user_id,
            **values,
            reconciliation_status="confirmed",
            user_confirmed_at=now,
            component_sources=component_sources,
        )
        db.add(event)
    else:
        for key, value in values.items():
            setattr(event, key, value)
        event.reconciliation_status = "confirmed"
        event.user_confirmed_at = now
        event.component_sources = component_sources
        pending_items = db.query(InvestmentReconciliationItem).filter(
            InvestmentReconciliationItem.income_event_id == event.id,
            InvestmentReconciliationItem.status == "pending",
        ).all()
        for item in pending_items:
            item.status = "resolved"
            item.resolution = {"action": "manual_edit"}
            item.resolved_at = now
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
    query = db.query(InvestmentIncomeEvent).filter(account_access(InvestmentIncomeEvent.account_id, user_id))
    if account_id is not None:
        account = db.query(Account).filter(Account.id == account_id, account_access(Account.id, user_id)).first()
        if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(InvestmentIncomeEvent.account_id == account.id)
    if holding_id is not None:
        holding = db.query(Holding).filter(Holding.id == holding_id, account_access(Holding.account_id, user_id)).first()
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


@router.get("/reporting-years")
def investment_reporting_years(user_id: Optional[str] = None, db: Session = Depends(get_db)):
    user_id = get_user_id(user_id)
    years = set()
    for model, column in ((InvestmentIncomeEvent, InvestmentIncomeEvent.pay_date), (CgtAllocation, CgtAllocation.disposal_date)):
        dates = db.query(column).filter(account_access(model.account_id, user_id)).distinct().all()
        years.update(day.year if day.month >= 7 else day.year - 1 for (day,) in dates)
    today = date.today()
    years.add(today.year if today.month >= 7 else today.year - 1)
    return sorted(years, reverse=True)


@router.get("/income-events/summary", response_model=list[InvestmentIncomeSummary])
def investment_income_summary(
    financial_year_start: int = Query(..., ge=1900, le=2200),
    account_id: Optional[UUID] = None,
    holding_id: Optional[UUID] = None,
    trailing: bool = False,
    person_ids: Optional[str] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Summarise statement-supplied income components by Australian FY/currency."""
    user_id = get_user_id(user_id)
    scope = InvestmentScope(db, user_id, person_ids)
    start, end = _financial_year_bounds(financial_year_start)
    if trailing:
        end = date.today() + timedelta(days=1)
        try:
            start = end.replace(year=end.year - 1)
        except ValueError:
            start = end.replace(year=end.year - 1, day=28)
    query = db.query(InvestmentIncomeEvent).filter(
        account_access(InvestmentIncomeEvent.account_id, user_id),
        InvestmentIncomeEvent.pay_date >= start,
        InvestmentIncomeEvent.pay_date < end,
    )
    if account_id is not None:
        account = db.query(Account).filter(Account.id == account_id, account_access(Account.id, user_id)).first()
        if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(InvestmentIncomeEvent.account_id == account.id)
    if holding_id is not None:
        holding = db.query(Holding).filter(Holding.id == holding_id, account_access(Holding.account_id, user_id)).first()
        if not holding or (account_id is not None and holding.account_id != account_id):
            raise HTTPException(status_code=404, detail="Holding not found in this investment account")
        query = query.filter(InvestmentIncomeEvent.holding_id == holding.id)
    totals = {}
    fields = {"cash_income": "cash_received", "franking_credits": "franking_credit", "foreign_income": "foreign_income", "foreign_tax_paid": "foreign_tax_paid", "tfn_withholding": "tfn_withholding"}
    for event in query.all():
        share = scope.share(event.account_id, event.pay_date)
        if share == 0:
            continue
        group = totals.setdefault(event.currency, {name: Decimal(0) for name in fields})
        for name, field in fields.items():
            group[name] += Decimal(getattr(event, field) or 0) * share
    return [InvestmentIncomeSummary(financial_year_start=financial_year_start, currency=currency, **values) for currency, values in sorted(totals.items())]


@router.get("/reconciliation-items")
def list_investment_reconciliation_items(
    account_id: Optional[UUID] = None,
    status: Optional[str] = Query(default="pending", pattern="^(pending|resolved|ignored|all)$"),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    query = db.query(InvestmentReconciliationItem).filter(
        InvestmentReconciliationItem.user_id == user_id
    )
    if account_id is not None:
        query = query.filter(InvestmentReconciliationItem.account_id == account_id)
    if status and status != "all":
        query = query.filter(InvestmentReconciliationItem.status == status)
    return [
        reconciliation_item_view(item)
        for item in query.order_by(
            InvestmentReconciliationItem.created_at.desc(),
            InvestmentReconciliationItem.id,
        ).limit(200).all()
    ]


@router.post("/reconciliation-items/{item_id:uuid}/resolve")
def resolve_investment_reconciliation(
    item_id: UUID,
    payload: InvestmentReconciliationResolve,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    try:
        item = resolve_reconciliation_item(
            db,
            user_id=user_id,
            item_id=item_id,
            action=payload.action,
            income_event_id=payload.income_event_id,
            transaction_id=payload.transaction_id,
            activity_id=payload.activity_id,
        )
        return reconciliation_item_view(item)
    except ValueError as exc:
        status_code = 404 if "not found" in str(exc) else 400
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc


@router.get("/cost-base-adjustments")
def list_investment_cost_base_adjustments(
    account_id: Optional[UUID] = None,
    holding_id: Optional[UUID] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    query = db.query(InvestmentCostBaseAdjustment).filter(
        account_access(InvestmentCostBaseAdjustment.account_id, user_id)
    )
    if account_id is not None:
        query = query.filter(InvestmentCostBaseAdjustment.account_id == account_id)
    if holding_id is not None:
        query = query.filter(InvestmentCostBaseAdjustment.holding_id == holding_id)
    return [{
        "id": str(item.id),
        "account_id": str(item.account_id),
        "holding_id": str(item.holding_id),
        "income_event_id": str(item.income_event_id) if item.income_event_id else None,
        "source_activity_id": str(item.source_activity_id),
        "effective_date": item.effective_date.isoformat(),
        "currency": item.currency,
        "amount_native": str(item.amount_native),
        "amount_aud": str(item.amount_aud) if item.amount_aud is not None else None,
        "valuation_source": item.valuation_source,
        "calculation_version": item.calculation_version,
        "assumptions": item.assumptions or [],
    } for item in query.order_by(
        InvestmentCostBaseAdjustment.effective_date,
        InvestmentCostBaseAdjustment.id,
    ).all()]


@router.get("/crypto-transfers")
def list_investment_crypto_transfers(
    account_id: Optional[UUID] = None,
    status: Optional[str] = Query(default="all", pattern="^(pending|matched|ambiguous|internal|all)$"),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    query = db.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.user_id == user_id
    )
    if account_id is not None:
        account = db.query(Account.id).filter(
            Account.id == account_id,
            Account.user_id == user_id,
        ).one_or_none()
        if account is None:
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(InvestmentCryptoTransfer.account_id == account_id)
    if status and status != "all":
        query = query.filter(InvestmentCryptoTransfer.status == status)
    return [
        transfer_view(item, db=db)
        for item in query.order_by(
            InvestmentCryptoTransfer.occurred_at.desc(),
            InvestmentCryptoTransfer.id,
        ).limit(500).all()
    ]


@router.post("/crypto-transfers/{transfer_id:uuid}/confirm")
def confirm_investment_crypto_transfer(
    transfer_id: UUID,
    payload: InvestmentCryptoTransferResolve,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    try:
        item = confirm_owned_crypto_transfer(
            db,
            user_id=user_id,
            transfer_id=transfer_id,
            candidate_transfer_id=payload.candidate_transfer_id,
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return transfer_view(item, db=db)


# ---------------------------------------------------------------------------
# Broker connections
# ---------------------------------------------------------------------------


def _verify_coinspot_credentials(api_key: str, api_secret: str) -> None:
    adapter = CoinSpotAdapter(CoinSpotReadOnlyClient(
        api_key=api_key,
        api_secret=api_secret,
    ))
    try:
        adapter.verify_read_only()
    except CoinSpotAuthError as exc:
        raise HTTPException(
            status_code=400,
            detail="CoinSpot rejected the API key. Generate a Read Only API key and try again.",
        ) from exc
    except CoinSpotTransientError as exc:
        raise HTTPException(
            status_code=503,
            detail="CoinSpot is temporarily unavailable. Try connecting again shortly.",
        ) from exc
    except CoinSpotError as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc
    finally:
        adapter.close()


def _verify_binance_credentials(api_key: str, api_secret: str) -> None:
    adapter = BinanceAdapter(BinanceReadOnlyClient(api_key=api_key, api_secret=api_secret))
    try:
        adapter.verify_read_only()
    except BinancePermissionError as exc:
        raise HTTPException(
            status_code=400,
            detail=(
                "Binance key is not least privilege. Enable reading only and disable "
                "Spot/margin trading, withdrawals, futures, options, and transfers."
            ),
        ) from exc
    except BinanceAuthError as exc:
        raise HTTPException(
            status_code=400,
            detail="Binance rejected the API key. Check the key, secret, and IP restrictions.",
        ) from exc
    except BinanceTransientError as exc:
        raise HTTPException(
            status_code=503,
            detail="Binance is temporarily unavailable or rate limited. Try connecting again shortly.",
        ) from exc
    except BinanceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc
    finally:
        adapter.close()


def _verify_crypto_com_exchange_credentials(api_key: str, api_secret: str) -> None:
    adapter = CryptoComExchangeAdapter(CryptoComExchangeReadOnlyClient(
        api_key=api_key, api_secret=api_secret,
    ))
    try:
        adapter.verify_read_only()
    except CryptoComExchangeAuthError as exc:
        raise HTTPException(
            status_code=400,
            detail=(
                "Crypto.com Exchange rejected the key. Check the key, secret, IP allowlist, "
                "and system clock, and confirm the key is Can Read only."
            ),
        ) from exc
    except CryptoComExchangeTransientError as exc:
        raise HTTPException(
            status_code=503,
            detail="Crypto.com Exchange is temporarily unavailable or rate limited. Try again shortly.",
        ) from exc
    except CryptoComExchangeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc
    finally:
        adapter.close()


@router.post("/broker-connections")
def create_broker_connection(
    payload: BrokerConnectionCreate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)

    if payload.provider == "coinspot":
        # The client is deliberately incapable of leaving CoinSpot's V2
        # read-only namespace. Validate credentials before persisting anything.
        _verify_coinspot_credentials(payload.api_key or "", payload.api_secret or "")
    elif payload.provider == "binance":
        _verify_binance_credentials(payload.api_key or "", payload.api_secret or "")
    elif payload.provider == "crypto_com_exchange":
        _verify_crypto_com_exchange_credentials(
            payload.api_key or "", payload.api_secret or ""
        )

    if payload.account_id is not None:
        account = db.query(Account).filter(
            Account.id == payload.account_id,
            Account.user_id == user_id,
            Account.account_type.in_(["investment_manual", "investment_brokerage"]),
        ).one_or_none()
        if account is None:
            raise HTTPException(status_code=404, detail="Investment account not found")
        if db.query(BrokerConnection.id).filter(
            BrokerConnection.account_id == account.id
        ).first():
            raise HTTPException(
                status_code=409,
                detail="This investment account already has an automatic connection.",
            )
        if (account.currency or "").upper() != payload.base_currency.upper():
            raise HTTPException(
                status_code=400,
                detail="The existing account currency must match the connector base currency.",
            )
        if db.query(Holding.id).filter(Holding.account_id == account.id, Holding.source == "manual").first():
            raise HTTPException(status_code=409, detail="This account contains manual opening snapshots. Use a separate connected account so its history and balances cannot be mixed ambiguously.")
        account.account_type = "investment_brokerage"
        account.provider = payload.provider
    else:
        account = Account(
            user_id=user_id,
            name=payload.account_name,
            account_type="investment_brokerage",
            currency=payload.base_currency,
            provider=payload.provider,
        )
        db.add(account)
        db.flush()

    if payload.provider in {"coinspot", "binance", "crypto_com_exchange"}:
        creds = {
            "api_key": payload.api_key,
            "api_secret": payload.api_secret,
            "history_start_date": (
                payload.history_start_date
                or (
                    date(2013, 1, 1)
                    if payload.provider == "coinspot"
                    else date(2017, 7, 1)
                    if payload.provider == "binance"
                    else date(2019, 1, 1)
                )
            ).isoformat(),
        }
        if payload.provider == "binance":
            creds["trade_symbols"] = payload.trade_symbols
    else:
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
        read_only_verified_at=(
            datetime.utcnow()
            if payload.provider in {"coinspot", "binance", "crypto_com_exchange"}
            else None
        ),
        consecutive_failures=0,
        health_details=(
            {
                "read_only_namespace": (
                    "https://www.coinspot.com.au/api/v2/ro"
                    if payload.provider == "coinspot"
                    else "Binance signed USER_DATA GET allowlist"
                    if payload.provider == "binance"
                    else "Crypto.com Exchange signed read-method allowlist"
                ),
                **(
                    {"read_only_verification": "user_confirmed_and_read_access_verified"}
                    if payload.provider == "crypto_com_exchange"
                    else {}
                ),
            }
            if payload.provider in {"coinspot", "binance", "crypto_com_exchange"} else {}
        ),
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)

    # Kick off background sync.
    _enqueue_account_refresh(db, background_tasks, account.id)

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
            "account_name": c.account.name,
            "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None,
            "last_sync_status": c.last_sync_status,
            "last_sync_error": c.last_sync_error,
            "read_only_verified_at": (
                c.read_only_verified_at.isoformat() if c.read_only_verified_at else None
            ),
            "consecutive_failures": c.consecutive_failures or 0,
            "next_retry_at": c.next_retry_at.isoformat() if c.next_retry_at else None,
            "health_details": {
                **(c.health_details or {}),
                "scheduled_sync": "daily",
                "scheduled_sync_hour_utc": _investment_sync_hour_utc(),
            },
        }
        for c in conns
    ]


@router.get("/broker-connections/{connection_id}/diagnostics")
def export_broker_connection_diagnostics(
    connection_id: UUID,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Export a credential-free support bundle for one investment connection."""
    user_id = get_user_id(user_id)
    conn = db.query(BrokerConnection).filter(
        BrokerConnection.id == connection_id,
        BrokerConnection.user_id == user_id,
    ).one_or_none()
    if conn is None:
        raise HTTPException(status_code=404, detail="Broker connection not found")
    runs = db.query(InvestmentIngestionRun).filter(
        InvestmentIngestionRun.account_id == conn.account_id,
        InvestmentIngestionRun.user_id == user_id,
    ).order_by(InvestmentIngestionRun.started_at.desc()).limit(100).all()
    records = db.query(InvestmentSourceRecord).filter(
        InvestmentSourceRecord.account_id == conn.account_id,
        InvestmentSourceRecord.user_id == user_id,
    ).order_by(InvestmentSourceRecord.occurred_at.desc()).limit(200).all()
    transfers = db.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.account_id == conn.account_id,
        InvestmentCryptoTransfer.user_id == user_id,
    ).order_by(InvestmentCryptoTransfer.occurred_at.desc()).limit(200).all()
    reconciliation_items = db.query(InvestmentReconciliationItem).filter(
        InvestmentReconciliationItem.account_id == conn.account_id,
        InvestmentReconciliationItem.user_id == user_id,
    ).order_by(
        InvestmentReconciliationItem.created_at.desc(),
        InvestmentReconciliationItem.id,
    ).limit(200).all()
    return {
        "format": "syllogic-investment-diagnostics-v1",
        "generated_at": datetime.utcnow().isoformat(),
        "account": {
            "id": str(conn.account.id),
            "name": conn.account.name,
            "currency": conn.account.currency,
            "provider": conn.provider,
            "active": bool(conn.account.is_active),
        },
        "connection": {
            "id": str(conn.id),
            "last_sync_at": conn.last_sync_at.isoformat() if conn.last_sync_at else None,
            "last_sync_status": conn.last_sync_status,
            "last_sync_error": conn.last_sync_error,
            "consecutive_failures": conn.consecutive_failures or 0,
            "next_retry_at": conn.next_retry_at.isoformat() if conn.next_retry_at else None,
            "read_only_verified_at": (
                conn.read_only_verified_at.isoformat()
                if conn.read_only_verified_at else None
            ),
            "health_details": conn.health_details or {},
            "scheduled_sync": {
                "frequency": "daily",
                "hour_utc": _investment_sync_hour_utc(),
            },
            "credentials_included": False,
        },
        "runs": [_ingestion_run_view(run) for run in runs],
        "source_records": [source_record_view(record) for record in records],
        "transfers": [transfer_view(item, db=db) for item in transfers],
        "reconciliation_items": [
            reconciliation_item_view(item) for item in reconciliation_items
        ],
        "retention": (
            "Disconnect removes encrypted credentials and stops future sync; imported "
            "history and provenance remain until the account is deleted."
        ),
    }


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
    conn.last_sync_status = "pending"
    conn.last_sync_error = None
    conn.next_retry_at = None
    db.commit()
    _enqueue_account_refresh(db, background_tasks, conn.account_id)
    return {"status": "queued", "account_id": str(conn.account_id)}


@router.patch("/broker-connections/{connection_id}/credentials")
def update_coinspot_credentials(
    connection_id: UUID,
    payload: CoinSpotCredentialsUpdate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    conn = db.query(BrokerConnection).filter(
        BrokerConnection.id == connection_id,
        BrokerConnection.user_id == user_id,
    ).one_or_none()
    if conn is None:
        raise HTTPException(status_code=404, detail="Broker connection not found")
    if conn.provider not in {"coinspot", "binance", "crypto_com_exchange"}:
        raise HTTPException(status_code=400, detail="Credential replacement is only available for API connections")

    if conn.provider == "coinspot":
        _verify_coinspot_credentials(payload.api_key, payload.api_secret)
    elif conn.provider == "binance":
        _verify_binance_credentials(payload.api_key, payload.api_secret)
    else:
        if not payload.read_only_confirmed:
            raise HTTPException(
                status_code=400,
                detail="Confirm the replacement Crypto.com Exchange key is Can Read only.",
            )
        _verify_crypto_com_exchange_credentials(payload.api_key, payload.api_secret)
    existing = credentials_crypto.decrypt(conn.credentials_encrypted)
    conn.credentials_encrypted = credentials_crypto.encrypt({
        **existing,
        "api_key": payload.api_key,
        "api_secret": payload.api_secret,
        **(
            {"trade_symbols": payload.trade_symbols}
            if conn.provider == "binance" and payload.trade_symbols is not None else {}
        ),
    })
    conn.read_only_verified_at = datetime.utcnow()
    conn.last_sync_status = "pending"
    conn.last_sync_error = None
    conn.consecutive_failures = 0
    conn.next_retry_at = None
    conn.health_details = {
        **(conn.health_details or {}),
        "failure_kind": None,
        "read_only_namespace": (
            "https://www.coinspot.com.au/api/v2/ro"
            if conn.provider == "coinspot"
            else "Binance signed USER_DATA GET allowlist"
            if conn.provider == "binance"
            else "Crypto.com Exchange signed read-method allowlist"
        ),
        **(
            {"read_only_verification": "user_confirmed_and_read_access_verified"}
            if conn.provider == "crypto_com_exchange"
            else {}
        ),
    }
    db.commit()
    _enqueue_account_refresh(db, background_tasks, conn.account_id)
    return {"status": "queued", "account_id": str(conn.account_id)}


@router.patch("/broker-connections/{connection_id}/configuration")
def update_binance_configuration(
    connection_id: UUID,
    payload: BinanceTradeSymbolsUpdate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    conn = db.query(BrokerConnection).filter(
        BrokerConnection.id == connection_id,
        BrokerConnection.user_id == user_id,
    ).one_or_none()
    if conn is None:
        raise HTTPException(status_code=404, detail="Broker connection not found")
    if conn.provider != "binance":
        raise HTTPException(status_code=400, detail="Spot-pair configuration is only available for Binance")
    existing = credentials_crypto.decrypt(conn.credentials_encrypted)
    conn.credentials_encrypted = credentials_crypto.encrypt({
        **existing, "trade_symbols": payload.trade_symbols,
    })
    conn.last_sync_status = "pending"
    conn.last_sync_error = None
    conn.next_retry_at = None
    conn.health_details = {
        **(conn.health_details or {}),
        "configured_trade_symbols": payload.trade_symbols,
    }
    db.commit()
    _enqueue_account_refresh(db, background_tasks, conn.account_id)
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
        account.investment_sync_state = {"request_id": str(uuid4()), "status": "queued", "queued_at": datetime.utcnow().isoformat(), "error": None}
    db.commit()
    for account in accounts:
        background_tasks.add_task(_run_sync_in_process, account.id)
    return {"status": "queued", "count": len(accounts), "account_ids": [str(account.id) for account in accounts]}


@router.get("/sync-status")
def investment_sync_status(user_id: Optional[str] = None, db: Session = Depends(get_db)):
    user_id = get_user_id(user_id)
    accounts = db.query(Account).filter(account_access(Account.id, user_id), Account.account_type.in_(["investment_manual", "investment_brokerage"])).all()
    return [{"account_id": str(account.id), "name": account.name, **(account.investment_sync_state or {"status": "idle"})} for account in accounts]



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
    # Disconnect credentials without deleting the user's imported history.
    # The account remains usable as a manual investment account.
    account = conn.account
    account.account_type = "investment_manual"
    account.provider = "manual"
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
    def existing_account():
        if not payload.creation_key:
            return None
        existing = db.query(Account).filter_by(user_id=user_id, investment_creation_key=payload.creation_key).one_or_none()
        if existing and (existing.name != payload.name or existing.currency != payload.base_currency):
            raise HTTPException(status_code=409, detail="This account request was already used with different details")
        return existing
    account = existing_account()
    if account is None:
        account = Account(user_id=user_id, name=payload.name, account_type="investment_manual", currency=payload.base_currency, provider="manual", investment_creation_key=payload.creation_key)
        db.add(account)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            account = existing_account()
            if account is None:
                raise HTTPException(status_code=409, detail="Account creation conflicted; reload and retry")
        db.refresh(account)
    return {"account_id": str(account.id), "name": account.name, "currency": account.currency}



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
        .filter(Account.id == account_id, account_access(Account.id, user_id))
        .first()
    )
    if not account or account.account_type != "investment_manual":
        raise HTTPException(status_code=404, detail="Manual investment account not found")

    if payload.provider_symbol and payload.provider_symbol.startswith(("manual:", "ibkr:")):
        raise HTTPException(status_code=422, detail="Private price references are created through this holding's unit-price form")

    def existing_position():
        existing = db.query(Holding).filter_by(account_id=account.id, symbol=payload.symbol, instrument_type=payload.instrument_type).one_or_none()
        if existing is None:
            return None
        if existing.source == "manual" and not existing.archived_at and all((
            existing.quantity == payload.quantity, existing.currency == payload.currency,
            existing.avg_cost == payload.avg_cost, existing.as_of_date == payload.as_of_date,
            existing.provider_symbol == (payload.provider_symbol or None),
        )):
            return {"holding_id": str(existing.id), "account_id": str(account.id), "symbol": existing.symbol, "name": existing.name, "quantity": str(existing.quantity)}
        raise HTTPException(status_code=409, detail="This symbol and type already exist with different details; edit the existing position")
    repeated = existing_position()
    if repeated:
        _enqueue_account_refresh(db, background_tasks, account.id)
        return repeated

    # Symbol resolution is an explicit UI step. Saving a manual or unlisted
    # instrument must not depend on a live market-data request.
    name = payload.name or payload.symbol

    holding = Holding(
        user_id=account.user_id,
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
        repeated = existing_position()
        if repeated:
            return repeated
        raise HTTPException(status_code=409, detail="Holding creation conflicted; reload and retry")
    db.refresh(holding)

    # Trigger an async revaluation so the new holding gets priced.
    _enqueue_account_refresh(db, background_tasks, account.id)

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


def _latest_valuation_map(db, user_id):
    latest = db.query(HoldingValuation.holding_id.label("holding_id"), func.max(HoldingValuation.date).label("date")).join(
        Holding, Holding.id == HoldingValuation.holding_id
    ).filter(account_access(Holding.account_id, user_id)).group_by(HoldingValuation.holding_id).subquery()
    rows = db.query(HoldingValuation).join(latest, (HoldingValuation.holding_id == latest.c.holding_id) & (HoldingValuation.date == latest.c.date)).all()
    return {row.holding_id: row for row in rows}


def _valuation_in_actor_currency(db, valuation, owner_user_id, actor_user_id):
    source = valuation.value_currency
    if not source:
        raise HTTPException(status_code=503, detail="Historical valuation currency is unverified. Refresh current prices or rebuild history from source records.")
    actor = db.query(User).filter_by(id=actor_user_id).one()
    target = actor.functional_currency or "AUD"
    if source == target:
        return Decimal(valuation.value_user_currency)
    from app.services.exchange_rate_service import ExchangeRateService
    converted = ExchangeRateService(db=db).convert_amount(
        Decimal(valuation.value_user_currency), source, target, valuation.date
    )
    if converted is None:
        raise HTTPException(status_code=503, detail="Valuation FX is unavailable")
    return converted


@router.get("/holdings", response_model=list[HoldingResponse])
def list_holdings(
    account_id: Optional[UUID] = None,
    person_ids: Optional[str] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    scope = InvestmentScope(db, user_id, person_ids)
    user = db.query(User).filter(User.id == user_id).first()
    user_currency = (
        getattr(user, "functional_currency", None) or "EUR"
    ).upper()

    from app.services.exchange_rate_service import ExchangeRateService

    fx_svc = ExchangeRateService(db=db)

    query = db.query(Holding).filter(account_access(Holding.account_id, user_id))
    if account_id is not None:
        query = query.filter(Holding.account_id == account_id)

    valuations = _latest_valuation_map(db, user_id)
    account_types = dict(db.query(Account.id, Account.account_type).filter(account_access(Account.id, user_id)).all())
    from app.services.investment_cost_basis import InvestmentCostBasis
    basis = InvestmentCostBasis(db, list(account_types), fx_svc, user_currency)
    results: list[HoldingResponse] = []
    for h in query.all():
        latest_val = valuations.get(h.id)
        share = scope.share(h.account_id, latest_val.date if latest_val else date.today())
        if share == 0:
            continue
        cost_basis_user, basis_kind = basis.for_holding(h, latest_val.date if latest_val else date.today())
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
                current_price=latest_val.price if latest_val and latest_val.quote_currency else None,
                current_value_user_currency=(
                    _valuation_in_actor_currency(db, latest_val, h.user_id, user_id) * share if latest_val and latest_val.value_currency else None
                ),
                cost_basis_user_currency=cost_basis_user * share if cost_basis_user is not None else None,
                ownership_share=share,
                is_stale=bool(h.last_price_error) or not latest_val or bool(latest_val.is_stale) or (date.today() - latest_val.date).days > 3,
                valuation_date=latest_val.date if latest_val else None,
                valuation_error=("Position quantity changed; revaluation pending" if latest_val and latest_val.quantity != h.quantity else None) or h.last_price_error or ("Valuation currency is unverified; refresh this holding" if latest_val and not latest_val.value_currency else None if latest_val else "No valuation available"),
                quote_currency=latest_val.quote_currency if latest_val else None,
                quote_date=latest_val.quote_date if latest_val else None,
                quote_source=latest_val.quote_source if latest_val else None,
                archived_at=h.archived_at,
                can_manage=account_types[h.account_id] == "investment_manual" and not h.archived_at,
                can_edit=account_types[h.account_id] == "investment_manual" and not h.archived_at and h.source in {"manual", "ibkr_flex", "coinspot_api", "binance_api", "crypto_com_api"},
                cost_basis_kind=basis_kind,
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
        .filter(Holding.id == holding_id, account_access(Holding.account_id, user_id))
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    account = db.query(Account).filter_by(id=holding.account_id).one()
    if holding.archived_at or account.account_type != "investment_manual" or holding.source not in {"manual", "ibkr_flex", "coinspot_api", "binance_api", "crypto_com_api"}:
        raise HTTPException(status_code=400, detail="Only current manual or disconnected-broker positions can be edited")

    payload = updates.model_dump(exclude_unset=True)
    reference = payload.get("provider_symbol")
    if reference and reference.startswith(("manual:", "ibkr:")) and reference.split(":", 1)[1] != holding.id.hex:
        raise HTTPException(status_code=422, detail="A private price belongs to its original holding")
    if any(field in payload and payload[field] is None for field in ("symbol", "currency", "instrument_type", "quantity")):
        raise HTTPException(status_code=422, detail="Instrument identity and quantity cannot be null")
    if payload:
        holding.last_price_error = "Position updated; revaluation pending"
    if any(field in payload for field in ("currency", "instrument_type", "symbol")) and db.query(BrokerTrade).filter(BrokerTrade.account_id == holding.account_id, BrokerTrade.symbol == holding.symbol).first():
        raise HTTPException(status_code=409, detail="Instrument identity is linked to transaction history. Archive this position or correct the source records instead.")
    for field, value in payload.items():
        setattr(holding, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A holding with that symbol and type already exists")
    db.refresh(holding)

    # Every position correction invalidates current valuation, including quantity.
    if payload:
        _enqueue_account_refresh(db, background_tasks, holding.account_id)

    return {"id": str(holding.id), "symbol": holding.symbol, "quantity": str(holding.quantity)}


@router.post("/holdings/{holding_id}/archive", status_code=204)
def archive_holding(
    holding_id: UUID,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    holding = db.query(Holding).filter(
        Holding.id == holding_id, account_access(Holding.account_id, user_id)
    ).first()
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    account = db.query(Account).filter_by(id=holding.account_id).one()
    if account.account_type != "investment_manual":
        raise HTTPException(status_code=400, detail="Disconnect the broker before archiving positions")
    holding.archived_at = datetime.utcnow()
    db.commit()
    _enqueue_account_refresh(db, background_tasks, holding.account_id)


@router.delete("/holdings/{holding_id}", status_code=204)
def delete_holding(
    holding_id: UUID,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    holding = db.query(Holding).filter(
        Holding.id == holding_id, account_access(Holding.account_id, user_id)
    ).first()
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    if holding.source != "manual":
        raise HTTPException(status_code=400, detail="Only manual holdings can be deleted")
    dependent = any((
        db.query(model).filter(model.holding_id == holding.id).first() is not None
        for model in (HoldingValuation, InvestmentIncomeEvent, InvestmentCostBaseAdjustment)
    )) or db.query(BrokerTrade).filter(
        BrokerTrade.account_id == holding.account_id,
        BrokerTrade.symbol == holding.symbol,
        BrokerTrade.instrument_type == holding.instrument_type,
    ).first() is not None
    if dependent:
        raise HTTPException(status_code=409, detail="This holding has financial history. Archive it to preserve the records.")
    account_id = holding.account_id
    db.delete(holding)
    db.commit()
    _enqueue_account_refresh(db, background_tasks, account_id)


@router.post("/holdings/{holding_id}/prices")
def save_manual_price(
    holding_id: UUID,
    payload: ManualPriceCreate,
    background_tasks: BackgroundTasks,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    holding = db.query(Holding).filter(
        Holding.id == holding_id, account_access(Holding.account_id, user_id)
    ).first()
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    account = db.query(Account).filter_by(id=holding.account_id).one()
    if account.account_type != "investment_manual" or holding.archived_at or holding.instrument_type == "cash":
        raise HTTPException(status_code=400, detail="A current non-cash manual-account holding is required")
    if payload.date > date.today():
        raise HTTPException(status_code=422, detail="A unit price cannot be future-dated")
    # Per-holding keys prevent one user's NAV overriding any public ticker or
    # another user's private price. The source label is retained with the quote.
    symbol = f"manual:{holding.id.hex}"
    snap = db.query(PriceSnapshot).filter_by(symbol=symbol, date=payload.date, provider="manual").one_or_none()
    if snap is None:
        snap = PriceSnapshot(symbol=symbol, date=payload.date)
        db.add(snap)
    snap.currency = payload.currency
    snap.close = payload.price
    snap.provider = "manual"
    snap.source_label = payload.source
    holding.provider_symbol = symbol
    db.commit()
    _enqueue_account_refresh(db, background_tasks, holding.account_id)
    return {"date": payload.date, "price": payload.price, "currency": payload.currency, "source": payload.source}


# ---------------------------------------------------------------------------
# Portfolio
# ---------------------------------------------------------------------------


@router.get("/portfolio/summary", response_model=PortfolioSummary)
def portfolio_summary(
    person_ids: Optional[str] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    scope = InvestmentScope(db, user_id, person_ids)
    user = db.query(User).filter(User.id == user_id).first()
    currency = getattr(user, "functional_currency", "EUR") or "EUR"

    accounts = (
        db.query(Account)
        .filter(
            account_access(Account.id, user_id),
            Account.account_type.in_(["investment_brokerage", "investment_manual"]),
        )
        .all()
    )

    valuations = _latest_valuation_map(db, user_id)
    account_holdings = {}
    for holding in db.query(Holding).filter(account_access(Holding.account_id, user_id), Holding.archived_at.is_(None)).all():
        account_holdings.setdefault(holding.account_id, []).append(holding)
    unavailable_holdings = 0
    valuation_dates = []
    priced_holdings = 0
    total_value = Decimal("0")
    today_change = Decimal("0")
    allocation_by_type: dict[str, Decimal] = {}
    allocation_by_currency: dict[str, Decimal] = {}
    accounts_payload: list[dict] = []

    for account in accounts:
        # Account total = sum of latest valuations across its holdings.
        account_value = Decimal("0")
        holdings = account_holdings.get(account.id, [])
        for h in holdings:
            latest = valuations.get(h.id)
            share = scope.share(account.id, latest.date if latest else date.today())
            if share == 0:
                continue
            if not latest or not latest.value_currency or latest.quantity != h.quantity or h.last_price_error or latest.is_stale or (date.today() - latest.date).days > 3:
                unavailable_holdings += 1
            if latest and latest.value_currency:
                priced_holdings += 1
                if latest.quote_date:
                    valuation_dates.append(latest.quote_date)
                visible_value = _valuation_in_actor_currency(db, latest, account.user_id, user_id) * share
                account_value += visible_value
                allocation_by_type[h.instrument_type] = (
                    allocation_by_type.get(h.instrument_type, Decimal("0"))
                    + visible_value
                )
                allocation_by_currency[h.currency] = (
                    allocation_by_currency.get(h.currency, Decimal("0"))
                    + visible_value
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
                today_change += _value_in_actor_currency(db, latest_balance.balance_in_functional_currency, account.user_id, user_id, latest_balance.date) * scope.share(account.id, latest_balance.date.date() if isinstance(latest_balance.date, datetime) else latest_balance.date) - _value_in_actor_currency(db, prior_balance.balance_in_functional_currency, account.user_id, user_id, prior_balance.date) * scope.share(account.id, prior_balance.date.date() if isinstance(prior_balance.date, datetime) else prior_balance.date)

        accounts_payload.append(
            {
                "id": str(account.id),
                "name": account.name,
                "type": account.account_type,
                "currency": account.currency,
                "source": account.provider,
                "sync_state": account.investment_sync_state,
                "can_add_holdings": account.account_type == "investment_manual",
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
        valuation_status="unavailable" if unavailable_holdings and not priced_holdings else "partial" if unavailable_holdings else "complete",
        unavailable_holdings=unavailable_holdings,
        as_of=min(valuation_dates) if valuation_dates and len(valuation_dates) == priced_holdings else None,
    )


@router.get("/holdings/{holding_id}/history", response_model=list[ValuationPoint])
def holding_history(
    holding_id: UUID,
    days: int = Query(30, ge=1, le=3650),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    person_ids: Optional[str] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    scope = InvestmentScope(db, user_id, person_ids)
    holding = (
        db.query(Holding)
        .filter(Holding.id == holding_id, account_access(Holding.account_id, user_id))
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    end_date = min(to_date or date.today(), date.today())
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
        ValuationPoint(date=r.date, value=_valuation_in_actor_currency(db, r, holding.user_id, user_id) * scope.share(holding.account_id, r.date))
        for r in rows
    ]


@router.get("/portfolio/history", response_model=list[ValuationPoint])
def portfolio_history(
    days: int = Query(30, ge=1, le=3650),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    person_ids: Optional[str] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = get_user_id(user_id)
    scope = InvestmentScope(db, user_id, person_ids)
    end_date = min(to_date or date.today(), date.today())
    cutoff = from_date or (date.today() - timedelta(days=days))
    if end_date < cutoff:
        raise HTTPException(status_code=400, detail="to must be on or after from")

    accounts = (
        db.query(Account.id, Account.user_id, Account.currency)
        .filter(
            account_access(Account.id, user_id),
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
            AccountBalance.date <= end_date,
        )
        .order_by(AccountBalance.date.asc())
        .all()
    )

    actor = db.query(User).filter_by(id=user_id).one()
    target_currency = actor.functional_currency or "AUD"
    from app.models import ExchangeRate
    rate_rows = db.query(ExchangeRate).filter(
        ExchangeRate.target_currency == target_currency,
        ExchangeRate.date >= cutoff - timedelta(days=7),
        ExchangeRate.date <= datetime.combine(end_date, time.max),
    ).all()
    rates = {(row.base_currency, row.date.date() if isinstance(row.date, datetime) else row.date): Decimal(row.rate) for row in rate_rows}
    def rate_on(source, day):
        for days_back in range(8):
            value = rates.get((source, day - timedelta(days=days_back)))
            if value is not None:
                return value
        return None
    # Seed balances before the selected range and carry each account forward.
    # Accounts with no opening observation do not exist in this series yet.
    observations = {}
    for row in rows:
        observed = row.date.date() if isinstance(row.date, datetime) else row.date
        observations.setdefault(observed, []).append(row)
    latest = {}
    for observed in sorted(observations):
        if observed >= cutoff:
            break
        for row in observations[observed]:
            latest[row.account_id] = row
    out = []
    day = cutoff
    while day <= end_date:
        for row in observations.get(day, []):
            latest[row.account_id] = row
        if latest:
            total = Decimal("0")
            for account_id, row in latest.items():
                source = row.account_currency
                if not source:
                    raise HTTPException(status_code=503, detail="Historical account currency is unverified. Rebuild from source records before reporting this history.")
                amount = Decimal(row.balance_in_account_currency)
                if source != target_currency:
                    rate = rate_on(source, day)
                    if rate is None:
                        raise HTTPException(status_code=503, detail=f"Portfolio history FX unavailable on {day}")
                    amount *= rate
                total += amount * scope.share(account_id, day)
            out.append(ValuationPoint(date=day, value=total))
        day += timedelta(days=1)
    return out


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
        .filter(Holding.id == holding_id, account_access(Holding.account_id, user_id))
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    trades = (
        db.query(BrokerTrade)
        .filter(
            BrokerTrade.account_id == holding.account_id,
            BrokerTrade.symbol == holding.symbol,
            BrokerTrade.instrument_type == holding.instrument_type,
        )
        .order_by(BrokerTrade.trade_date.asc(), BrokerTrade.occurred_at.asc(), BrokerTrade.id.asc())
        .all()
    )
    trades.sort(key=lambda trade: (
        trade.occurred_at or datetime.combine(
            trade.trade_date,
            time.min if trade.side == "buy" else time.max,
        ),
        0 if trade.side == "buy" else 1,
        str(trade.id),
    ))

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
                economic_type=t.economic_type,
                taxable_disposal=t.taxable_disposal,
                aud_value=t.aud_value,
                valuation_source=t.valuation_source,
                valuation_timestamp=t.valuation_timestamp,
                valuation_missing=t.valuation_missing,
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
        .filter(Holding.id == holding_id, account_access(Holding.account_id, user_id))
        .first()
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    trades = (
        db.query(BrokerTrade)
        .filter(
            BrokerTrade.account_id == holding.account_id,
            BrokerTrade.symbol == holding.symbol,
            BrokerTrade.instrument_type == holding.instrument_type,
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
            trade_id=str(t.id),
            sort_key=str(t.id),
            occurred_at=t.occurred_at,
            acquisition_date=t.acquisition_date,
        )
        for t in trades
    ]
    adjustment_rows = db.query(InvestmentCostBaseAdjustment).filter(
        InvestmentCostBaseAdjustment.holding_id == holding.id,
    ).all()
    fifo = compute_fifo(fifo_trades, [
        _FifoAdjustment(
            symbol=holding.symbol,
            effective_date=item.effective_date,
            amount=Decimal(item.amount_native),
            currency=item.currency,
            adjustment_id=str(item.id),
            sort_key=str(item.id),
        )
        for item in adjustment_rows
    ])

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
        def converted(amount, on):
            if lot.currency.upper() == user_currency:
                return Decimal(amount)
            rate = fx_svc.get_exchange_rate(lot.currency.upper(), user_currency, on)
            return Decimal(amount) * Decimal(rate) if rate is not None else None
        original = converted(lot.original_cost_per_share_native, lot.open_date)
        adjustments = [converted(item.amount_native, item.effective_date) for item in lot.adjustments]
        cost_per_share_user = (original + sum(adjustments, Decimal(0))).quantize(Decimal("0.00000001")) if original is not None and all(value is not None for value in adjustments) else None
        out.append(
            HoldingLot(
                open_date=lot.open_date,
                quantity_remaining=lot.quantity_remaining,
                cost_per_share_native=lot.cost_per_share_native,
                original_cost_per_share_native=lot.original_cost_per_share_native,
                cost_base_adjustment_per_share_native=lot.cost_base_adjustment_per_share_native,
                adjustment_ids=[
                    item.adjustment_id for item in lot.adjustments if item.adjustment_id
                ],
                cost_per_share_user=cost_per_share_user,
                age_days=(today - lot.open_date).days,
                currency=lot.currency,
                acquisition_trade_id=lot.acquisition_trade_id,
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
    holding = db.query(Holding).filter(Holding.id == holding_id, account_access(Holding.account_id, user_id)).first()
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    return db.query(CgtAllocation).filter(
        CgtAllocation.account_id == holding.account_id,
        CgtAllocation.symbol == holding.symbol,
        CgtAllocation.instrument_type == holding.instrument_type,
    ).order_by(CgtAllocation.disposal_date.desc(), CgtAllocation.id.asc()).all()


def _cgt_allocations_query(
    db: Session,
    user_id: str,
    financial_year_start: Optional[int] = None,
    account_id: Optional[UUID] = None,
):
    query = db.query(CgtAllocation).join(Account, Account.id == CgtAllocation.account_id).filter(
        account_access(Account.id, user_id),
    )
    if financial_year_start is not None:
        start, end = _financial_year_bounds(financial_year_start)
        query = query.filter(
            CgtAllocation.disposal_date >= start,
            CgtAllocation.disposal_date < end,
        )
    if account_id is not None:
        account = db.query(Account).filter(Account.id == account_id, account_access(Account.id, user_id)).first()
        if not account or account.account_type not in ("investment_manual", "investment_brokerage"):
            raise HTTPException(status_code=404, detail="Investment account not found")
        query = query.filter(CgtAllocation.account_id == account.id)
    return query.order_by(CgtAllocation.disposal_date.desc(), CgtAllocation.id.asc())


def _cgt_export_csv(rows: list[CgtAllocation]) -> str:
    """Serialize persisted allocations without deriving or hiding tax-relevant values."""
    fields = [
        "allocation_id", "account_id", "acquisition_trade_id", "disposal_trade_id", "symbol", "instrument_type",
        "acquisition_date", "disposal_date", "quantity", "currency", "cost_base_native",
        "proceeds_native", "gain_native", "cost_base_adjustment_native", "cost_base_aud", "proceeds_aud", "gain_aud",
        "cost_base_adjustment_aud", "adjustment_ids",
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
            "instrument_type": row.instrument_type,
            "acquisition_date": row.acquisition_date.isoformat(),
            "disposal_date": row.disposal_date.isoformat(),
            "quantity": row.quantity,
            "currency": row.currency,
            "cost_base_native": row.cost_base_native,
            "proceeds_native": row.proceeds_native,
            "gain_native": row.gain_native,
            "cost_base_adjustment_native": row.cost_base_adjustment_native,
            "cost_base_aud": row.cost_base_aud if row.cost_base_aud is not None else "",
            "proceeds_aud": row.proceeds_aud if row.proceeds_aud is not None else "",
            "gain_aud": row.gain_aud if row.gain_aud is not None else "",
            "cost_base_adjustment_aud": row.cost_base_adjustment_aud if row.cost_base_adjustment_aud is not None else "",
            "adjustment_ids": " | ".join(row.adjustment_ids or []),
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
    person_ids: Optional[str] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Summarise recorded Australian-dollar CGT allocations for an Australian FY.

    This is a calculation record, not tax advice. Allocations lacking either
    transaction-date FX rate are deliberately excluded from AUD totals.
    """
    user_id = get_user_id(user_id)
    scope = InvestmentScope(db, user_id, person_ids)
    rows = _cgt_allocations_query(db, user_id, financial_year_start, account_id).all()
    rows = [row for row in rows if scope.share(row.account_id, row.disposal_date) > 0]
    known = [row for row in rows if not row.fx_missing and row.gain_aud is not None]
    def attributed_gain(row):
        return Decimal(row.gain_aud) * scope.share(row.account_id, row.disposal_date)
    gross_gains = sum((max(attributed_gain(row), Decimal("0")) for row in known), Decimal("0"))
    losses = sum((max(-attributed_gain(row), Decimal("0")) for row in known), Decimal("0"))
    discounted = sum((attributed_gain(row) / 2 for row in known if row.discount_eligible and row.gain_aud > 0), Decimal("0"))
    net_before_losses = sum((
        attributed_gain(row) / 2 if row.discount_eligible and row.gain_aud > 0 else attributed_gain(row)
        for row in known
    ), Decimal("0"))
    assumptions = [
        "FIFO matching is calculated from recorded broker trades and their recorded fees.",
        "The allocation result sums discounted positive gains and negative gains; it is not a final net capital gain or a tax loss-ordering calculation.",
        "Completeness refers only to recorded allocations, not completeness of the taxpayer history.",
        "Statement-supplied AMIT/AMMA net amounts are included on their recorded effective dates.",
        "Corporate actions and tax elections other than recorded AMIT/AMMA adjustments are not calculated.",
    ]
    from app.services.investment_report_coverage import investment_report_warnings
    start, end = _financial_year_bounds(financial_year_start)
    coverage_warnings = investment_report_warnings(db, user_id, start, end, scope, account_id)
    assumptions.extend(coverage_warnings)
    missing = len(rows) - len(known)
    if missing:
        assumptions.append(f"{missing} allocation(s) excluded from AUD totals because required AUD valuation, fee or transaction-date FX inputs are missing.")
    return CgtFinancialYearSummary(
        financial_year_start=financial_year_start,
        gross_gains_aud=gross_gains.quantize(Decimal("0.01")),
        capital_losses_aud=losses.quantize(Decimal("0.01")),
        discounted_gains_aud=discounted.quantize(Decimal("0.01")),
        net_capital_gain_before_losses_aud=net_before_losses.quantize(Decimal("0.01")),
        allocation_count=len(rows),
        disposal_count=len({row.disposal_trade_id for row in rows}),
        allocation_result_aud=net_before_losses.quantize(Decimal("0.01")),
        coverage_warnings=coverage_warnings,
        missing_fx_allocation_count=missing,
        assumptions=assumptions,
    )


# ---------------------------------------------------------------------------
# Symbol search
# ---------------------------------------------------------------------------


@router.get("/symbols/search", response_model=list[SymbolSearchResult])
def search_symbols(q: str = Query(..., min_length=1)):
    provider = get_price_provider()
    try:
        matches = provider.search_symbols(q)
    except Exception:
        raise HTTPException(status_code=503, detail="Symbol search is unavailable; try again or enter the instrument manually")
    return [
        SymbolSearchResult(
            symbol=getattr(m, "symbol", ""),
            name=getattr(m, "name", ""),
            exchange=getattr(m, "exchange", None),
            currency=getattr(m, "currency", None),
        )
        for m in matches
    ]


@router.get("/symbols/resolve", response_model=SymbolSearchResult)
def resolve_investment_symbol(symbol: str = Query(..., min_length=1, max_length=64)):
    try:
        match = get_price_provider().resolve_symbol(symbol.strip())
    except Exception:
        raise HTTPException(status_code=503, detail="Instrument identity or currency could not be verified. Enter it manually or retry.")
    return SymbolSearchResult(symbol=match.symbol, name=match.name, exchange=match.exchange, currency=match.currency, instrument_type=match.instrument_type)
