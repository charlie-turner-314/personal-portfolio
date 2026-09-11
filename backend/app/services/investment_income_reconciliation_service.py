"""Reconcile cash income, annual tax statements, DRPs, and AMIT adjustments.

Cash activity remains the economic income event. Annual statements enrich that
event through a reversible provenance record; they never create a second cash
event. Ambiguous and conflicting matches are retained for explicit review.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from decimal import Decimal
from typing import Any, Mapping
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import (
    Account,
    BrokerTrade,
    Holding,
    InvestmentActivity,
    InvestmentCostBaseAdjustment,
    InvestmentIncomeEnrichment,
    InvestmentIncomeEvent,
    InvestmentReconciliationItem,
    Transaction,
)
from app.services.broker_trade_service import _recompute_holding
from app.services.investment_lock_service import acquire_user_ingestion_lock
from app.services.pnl_service import (
    CostBaseAdjustment,
    CostBaseAdjustmentError,
    Trade,
    compute_fifo,
)


INCOME_COMPONENT_FIELDS = (
    "franked_amount",
    "unfranked_amount",
    "franking_credit",
    "foreign_income",
    "foreign_tax_paid",
    "tfn_withholding",
    "amit_amma_components",
    "ex_date",
)


def _decimal(metadata: Mapping[str, Any], key: str) -> Decimal | None:
    value = metadata.get(key)
    return None if value is None or value == "" else Decimal(str(value))


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def _source_entry(activity: InvestmentActivity, kind: str) -> dict[str, str]:
    return {
        "kind": kind,
        "activity_id": str(activity.id),
        "run_id": str(activity.run_id),
    }


def _append_component_source(
    sources: Mapping[str, Any] | None,
    field: str,
    entry: Mapping[str, str],
) -> dict[str, Any]:
    result = dict(sources or {})
    existing = result.get(field, [])
    if isinstance(existing, Mapping):
        existing = [dict(existing)]
    elif not isinstance(existing, list):
        existing = []
    rendered = dict(entry)
    if rendered not in existing:
        existing = [*existing, rendered]
    result[field] = existing
    return result


def _upsert_reconciliation(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
    kind: str,
    reason: str,
    income_event: InvestmentIncomeEvent | None = None,
    candidate_income_ids: list[str] | None = None,
    candidate_transaction_ids: list[str] | None = None,
    details: Mapping[str, Any] | None = None,
) -> InvestmentReconciliationItem:
    item = db.query(InvestmentReconciliationItem).filter(
        InvestmentReconciliationItem.source_activity_id == activity.id,
        InvestmentReconciliationItem.kind == kind,
    ).one_or_none()
    if item is None:
        item = InvestmentReconciliationItem(
            user_id=account.user_id,
            account_id=account.id,
            source_activity_id=activity.id,
            kind=kind,
        )
        db.add(item)
    item.income_event_id = income_event.id if income_event else None
    item.status = "pending"
    item.reason = reason
    item.candidate_income_event_ids = candidate_income_ids or []
    item.candidate_transaction_ids = candidate_transaction_ids or []
    item.details = dict(details or {})
    item.resolution = None
    item.resolved_at = None
    db.flush()
    return item


def _cash_transaction_candidates(
    db: Session,
    *,
    event: InvestmentIncomeEvent,
    symbol: str,
) -> list[Transaction]:
    start = datetime.combine(event.pay_date - timedelta(days=3), time.min)
    end = datetime.combine(event.pay_date + timedelta(days=4), time.min)
    candidates = db.query(Transaction).filter(
        Transaction.user_id == event.user_id,
        Transaction.transaction_type == "credit",
        Transaction.currency == event.currency,
        Transaction.amount == event.cash_received,
        Transaction.booked_at >= start,
        Transaction.booked_at < end,
        Transaction.internal_transfer_id.is_(None),
        Transaction.pending.is_(False),
    ).order_by(Transaction.booked_at, Transaction.id).all()
    linked_ids = {
        row[0] for row in db.query(InvestmentIncomeEvent.matched_transaction_id).filter(
            InvestmentIncomeEvent.matched_transaction_id.is_not(None),
            InvestmentIncomeEvent.id != event.id,
        ).all()
    }
    candidates = [item for item in candidates if item.id not in linked_ids]
    if len(candidates) <= 1:
        return candidates
    token = symbol.casefold()
    descriptive = [
        item for item in candidates
        if token in " ".join(
            str(value or "")
            for value in (item.description, item.merchant, item.creditor, item.debtor)
        ).casefold()
    ]
    return descriptive if len(descriptive) == 1 else candidates


def _link_cash_transaction_or_surface(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
    event: InvestmentIncomeEvent,
) -> None:
    candidates = _cash_transaction_candidates(db, event=event, symbol=activity.asset_symbol)
    if len(candidates) == 1:
        event.matched_transaction_id = candidates[0].id
        return
    reason = (
        "No unique cash credit matched this income event within three days."
        if not candidates
        else "More than one cash credit could match this income event."
    )
    _upsert_reconciliation(
        db,
        account=account,
        activity=activity,
        kind="cash_match",
        reason=reason,
        income_event=event,
        candidate_transaction_ids=[str(item.id) for item in candidates],
        details={
            "symbol": activity.asset_symbol,
            "pay_date": event.pay_date.isoformat(),
            "cash_received": format(Decimal(event.cash_received), "f"),
            "currency": event.currency,
        },
    )


def create_cash_income_event(
    db: Session,
    *,
    account: Account,
    holding: Holding,
    activity: InvestmentActivity,
    source_id: str,
) -> InvestmentIncomeEvent:
    metadata = activity.activity_metadata or {}
    is_drp = activity.activity_type == "drp"
    event_type = (
        "distribution"
        if activity.activity_type == "distribution" or metadata.get("income_type") == "distribution"
        else "dividend"
    )
    cash_received = activity.net_amount
    if cash_received is None:
        cash_received = activity.gross_amount
    if cash_received is None and is_drp and activity.quantity is not None and activity.price is not None:
        cash_received = Decimal(activity.quantity) * Decimal(activity.price)
    values = {
        "franked_amount": _decimal(metadata, "franked_amount"),
        "unfranked_amount": _decimal(metadata, "unfranked_amount"),
        "franking_credit": _decimal(metadata, "franking_credit"),
        "foreign_income": _decimal(metadata, "foreign_income"),
        "foreign_tax_paid": _decimal(metadata, "foreign_tax_paid"),
        "tfn_withholding": _decimal(metadata, "tfn_withholding"),
    }
    component_sources: dict[str, Any] = {}
    entry = _source_entry(activity, "cash_activity")
    for field, value in values.items():
        if value is not None:
            component_sources = _append_component_source(component_sources, field, entry)
    if metadata.get("amit_amma_components") is not None:
        component_sources = _append_component_source(
            component_sources, "amit_amma_components", entry
        )
    event = InvestmentIncomeEvent(
        user_id=account.user_id,
        account_id=account.id,
        holding_id=holding.id,
        event_type=event_type,
        pay_date=activity.occurred_at.date(),
        ex_date=(
            datetime.fromisoformat(str(metadata["ex_date"])).date()
            if metadata.get("ex_date") else None
        ),
        currency=activity.currency or account.currency or "AUD",
        cash_received=cash_received or Decimal("0"),
        **values,
        amit_amma_components=metadata.get("amit_amma_components"),
        is_drp=is_drp,
        drp_quantity=activity.quantity if is_drp else None,
        drp_price=activity.price if is_drp else None,
        reinvestment_trade_id=activity.broker_trade_id if is_drp else None,
        source_id=source_id,
        reconciliation_status="provisional",
        component_sources=component_sources,
        created_by_activity_id=activity.id,
        notes=metadata.get("notes") or metadata.get("description"),
    )
    db.add(event)
    db.flush()
    activity.income_event_id = event.id
    _link_cash_transaction_or_surface(
        db, account=account, activity=activity, event=event
    )
    return event


def _annual_candidates(
    db: Session,
    *,
    account: Account,
    holding: Holding,
    activity: InvestmentActivity,
    event_type: str,
) -> list[InvestmentIncomeEvent]:
    metadata = activity.activity_metadata or {}
    pay_date = (
        datetime.fromisoformat(str(metadata["cash_pay_date"])).date()
        if metadata.get("cash_pay_date")
        else activity.occurred_at.date()
    )
    query = db.query(InvestmentIncomeEvent).filter(
        InvestmentIncomeEvent.user_id == account.user_id,
        InvestmentIncomeEvent.account_id == account.id,
        InvestmentIncomeEvent.holding_id == holding.id,
        InvestmentIncomeEvent.event_type == event_type,
        InvestmentIncomeEvent.currency == (activity.currency or account.currency or "AUD"),
        InvestmentIncomeEvent.pay_date == pay_date,
    )
    cash = activity.net_amount if activity.net_amount is not None else activity.gross_amount
    if cash is not None and Decimal(cash) > 0:
        query = query.filter(InvestmentIncomeEvent.cash_received == cash)
    exact = query.order_by(InvestmentIncomeEvent.created_at, InvestmentIncomeEvent.id).all()
    if exact:
        return exact
    if cash is None or Decimal(cash) <= 0:
        return []
    return db.query(InvestmentIncomeEvent).filter(
        InvestmentIncomeEvent.user_id == account.user_id,
        InvestmentIncomeEvent.account_id == account.id,
        InvestmentIncomeEvent.holding_id == holding.id,
        InvestmentIncomeEvent.event_type == event_type,
        InvestmentIncomeEvent.currency == (activity.currency or account.currency or "AUD"),
        InvestmentIncomeEvent.cash_received == cash,
        InvestmentIncomeEvent.pay_date >= pay_date - timedelta(days=7),
        InvestmentIncomeEvent.pay_date <= pay_date + timedelta(days=7),
    ).order_by(InvestmentIncomeEvent.pay_date, InvestmentIncomeEvent.id).all()


def _incoming_components(activity: InvestmentActivity) -> dict[str, Any]:
    metadata = activity.activity_metadata or {}
    result: dict[str, Any] = {
        field: _decimal(metadata, field)
        for field in INCOME_COMPONENT_FIELDS
        if field not in {"amit_amma_components", "ex_date"}
    }
    result["amit_amma_components"] = metadata.get("amit_amma_components")
    result["ex_date"] = (
        datetime.fromisoformat(str(metadata["ex_date"])).date()
        if metadata.get("ex_date") else None
    )
    return {field: value for field, value in result.items() if value is not None}


def _validate_cost_adjustment(
    db: Session,
    *,
    holding: Holding,
    amount: Decimal,
    currency: str,
    effective_date,
) -> None:
    trades = db.query(BrokerTrade).filter(
        BrokerTrade.account_id == holding.account_id,
        BrokerTrade.symbol == holding.symbol,
        BrokerTrade.instrument_type == holding.instrument_type,
    ).all()
    existing = db.query(InvestmentCostBaseAdjustment).filter(
        InvestmentCostBaseAdjustment.holding_id == holding.id,
    ).all()
    fifo_trades = [
        Trade(
            symbol=item.symbol,
            trade_date=item.trade_date,
            side=item.side,
            quantity=Decimal(item.quantity),
            price=Decimal(item.price),
            currency=item.currency,
            fees=Decimal(item.fees or 0),
            trade_id=str(item.id),
            sort_key=str(item.id),
        )
        for item in trades
    ]
    adjustments = [
        CostBaseAdjustment(
            symbol=holding.symbol,
            effective_date=item.effective_date,
            amount=Decimal(item.amount_native),
            currency=item.currency,
            adjustment_id=str(item.id),
            sort_key=str(item.id),
        )
        for item in existing
    ]
    adjustments.append(CostBaseAdjustment(
        symbol=holding.symbol,
        effective_date=effective_date,
        amount=amount,
        currency=currency,
        adjustment_id="proposed",
        sort_key="proposed",
    ))
    compute_fifo(fifo_trades, adjustments)


def _apply_cost_adjustment(
    db: Session,
    *,
    account: Account,
    holding: Holding,
    activity: InvestmentActivity,
    event: InvestmentIncomeEvent,
) -> InvestmentCostBaseAdjustment | None:
    metadata = activity.activity_metadata or {}
    increase = _decimal(metadata, "cost_base_increase") or Decimal("0")
    decrease = _decimal(metadata, "cost_base_decrease") or Decimal("0")
    amount = increase - decrease
    if amount == 0:
        return None
    effective_date = (
        datetime.fromisoformat(str(metadata["cost_base_effective_date"])).date()
        if metadata.get("cost_base_effective_date")
        else activity.occurred_at.date()
    )
    currency = (activity.currency or event.currency).upper()
    existing_for_event = db.query(InvestmentCostBaseAdjustment).filter(
        InvestmentCostBaseAdjustment.income_event_id == event.id,
        InvestmentCostBaseAdjustment.effective_date == effective_date,
    ).all()
    if existing_for_event:
        identical = next((
            item for item in existing_for_event
            if item.currency == currency and Decimal(item.amount_native) == amount
        ), None)
        if identical is not None:
            return identical
        raise CostBaseAdjustmentError(
            holding.symbol,
            effective_date,
            "conflicts with a previously recorded statement adjustment",
        )
    _validate_cost_adjustment(
        db,
        holding=holding,
        amount=amount,
        currency=currency,
        effective_date=effective_date,
    )
    amount_aud = amount if currency == "AUD" else None
    valuation_source = "identity" if currency == "AUD" else None
    assumptions = [
        "Positive amount increases cost base (AMIT shortfall); negative amount decreases cost base (AMIT excess).",
        "The net amount is allocated evenly per unit across units open on the effective date.",
    ]
    if currency != "AUD":
        from app.services.exchange_rate_service import ExchangeRateService

        rate = ExchangeRateService(db=db).get_exchange_rate(currency, "AUD", effective_date)
        if rate is not None:
            amount_aud = (amount * Decimal(rate)).quantize(Decimal("0.00000001"))
            valuation_source = "exchange_rate_service"
        else:
            assumptions.append("AUD valuation is missing for the adjustment effective date.")
    row = InvestmentCostBaseAdjustment(
        user_id=account.user_id,
        account_id=account.id,
        holding_id=holding.id,
        income_event_id=event.id,
        source_activity_id=activity.id,
        effective_date=effective_date,
        currency=currency,
        amount_native=amount,
        amount_aud=amount_aud,
        valuation_source=valuation_source,
        valuation_timestamp=activity.valuation_timestamp,
        calculation_version="amit-v1",
        assumptions=assumptions,
    )
    db.add(row)
    db.flush()
    _recompute_holding(db, account, holding.symbol, holding.instrument_type)
    return row


def enrich_income_event_from_statement(
    db: Session,
    *,
    account: Account,
    holding: Holding,
    activity: InvestmentActivity,
    event: InvestmentIncomeEvent,
) -> InvestmentIncomeEvent:
    incoming = _incoming_components(activity)
    previous: dict[str, Any] = {
        "reconciliation_status": event.reconciliation_status,
        "annual_statement_reference": event.annual_statement_reference,
        "component_sources": event.component_sources or {},
    }
    applied: dict[str, Any] = {}
    conflicts: dict[str, dict[str, Any]] = {}
    sources = dict(event.component_sources or {})
    entry = _source_entry(activity, "annual_statement")
    for field, incoming_value in incoming.items():
        existing_value = getattr(event, field)
        if existing_value is None:
            previous[field] = None
            setattr(event, field, incoming_value)
            applied[field] = _json_value(incoming_value)
            sources = _append_component_source(sources, field, entry)
        elif existing_value == incoming_value:
            sources = _append_component_source(sources, field, entry)
        else:
            conflicts[field] = {
                "existing": _json_value(existing_value),
                "statement": _json_value(incoming_value),
            }
    reference = (activity.activity_metadata or {}).get("annual_statement_reference")
    if reference:
        event.annual_statement_reference = str(reference)[:255]
    event.component_sources = sources
    event.reconciliation_status = "conflict" if conflicts else "confirmed"
    applied.update({
        "reconciliation_status": event.reconciliation_status,
        "annual_statement_reference": event.annual_statement_reference,
        "component_sources": sources,
    })
    enrichment = InvestmentIncomeEnrichment(
        user_id=account.user_id,
        income_event_id=event.id,
        source_activity_id=activity.id,
        previous_values={key: _json_value(value) for key, value in previous.items()},
        applied_values=applied,
    )
    db.add(enrichment)
    db.flush()
    activity.income_event_id = event.id
    try:
        _apply_cost_adjustment(
            db,
            account=account,
            holding=holding,
            activity=activity,
            event=event,
        )
    except CostBaseAdjustmentError as exc:
        conflicts["cost_base_adjustment"] = {
            "statement": {
                "increase": (activity.activity_metadata or {}).get("cost_base_increase"),
                "decrease": (activity.activity_metadata or {}).get("cost_base_decrease"),
            },
            "reason": str(exc),
        }
        event.reconciliation_status = "conflict"
    if conflicts:
        _upsert_reconciliation(
            db,
            account=account,
            activity=activity,
            kind="component_conflict",
            reason="Annual statement values conflict with recorded or user-confirmed income data.",
            income_event=event,
            candidate_income_ids=[str(event.id)],
            details={"conflicts": conflicts, "incoming": {
                key: _json_value(value) for key, value in incoming.items()
            }},
        )
    return event


def reconcile_annual_statement(
    db: Session,
    *,
    account: Account,
    holding: Holding,
    activity: InvestmentActivity,
) -> InvestmentIncomeEvent | None:
    metadata = activity.activity_metadata or {}
    event_type = (
        "distribution"
        if activity.activity_type == "distribution" or metadata.get("income_type") == "distribution"
        else "dividend"
    )
    candidates = _annual_candidates(
        db,
        account=account,
        holding=holding,
        activity=activity,
        event_type=event_type,
    )
    if len(candidates) != 1:
        reason = (
            "No provisional cash income event matched this annual statement row."
            if not candidates
            else "Multiple cash income events matched this annual statement row."
        )
        _upsert_reconciliation(
            db,
            account=account,
            activity=activity,
            kind="annual_statement",
            reason=reason,
            candidate_income_ids=[str(item.id) for item in candidates],
            details={
                "symbol": holding.symbol,
                "event_type": event_type,
                "statement_date": activity.occurred_at.date().isoformat(),
            },
        )
        return None
    return enrich_income_event_from_statement(
        db,
        account=account,
        holding=holding,
        activity=activity,
        event=candidates[0],
    )


def reconciliation_item_view(item: InvestmentReconciliationItem) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "account_id": str(item.account_id),
        "source_activity_id": str(item.source_activity_id),
        "income_event_id": str(item.income_event_id) if item.income_event_id else None,
        "kind": item.kind,
        "status": item.status,
        "reason": item.reason,
        "candidate_income_event_ids": item.candidate_income_event_ids or [],
        "candidate_transaction_ids": item.candidate_transaction_ids or [],
        "details": item.details or {},
        "resolution": item.resolution,
        "resolved_at": item.resolved_at.isoformat() if item.resolved_at else None,
        "created_at": item.created_at.isoformat(),
    }


def resolve_reconciliation_item(
    db: Session,
    *,
    user_id: str,
    item_id: str | UUID,
    action: str,
    income_event_id: str | UUID | None = None,
    transaction_id: str | UUID | None = None,
    activity_id: str | UUID | None = None,
) -> InvestmentReconciliationItem:
    acquire_user_ingestion_lock(db, user_id=user_id)
    item = db.query(InvestmentReconciliationItem).filter(
        InvestmentReconciliationItem.id == item_id,
        InvestmentReconciliationItem.user_id == user_id,
    ).one_or_none()
    if item is None:
        raise ValueError("reconciliation item not found")
    if item.status != "pending":
        return item
    if action == "ignore":
        item.status = "ignored"
    elif (
        item.kind == "cash_match"
        and (item.details or {}).get("workflow") == "investment_cash_transfer"
        and action in {"link_transaction", "link_activity"}
    ):
        if action == "link_transaction":
            if not transaction_id or str(transaction_id) not in (
                item.candidate_transaction_ids or []
            ):
                raise ValueError("a suggested transaction_id is required")
            transaction = db.query(Transaction).filter(
                Transaction.id == transaction_id,
                Transaction.user_id == user_id,
            ).one_or_none()
            if transaction is None:
                raise ValueError("owned transaction is required")
        else:
            candidates = (item.details or {}).get("candidate_activity_ids") or []
            if not activity_id or str(activity_id) not in candidates:
                raise ValueError("a suggested activity_id is required")
            counterpart_activity = db.query(InvestmentActivity).filter(
                InvestmentActivity.id == activity_id,
                InvestmentActivity.user_id == user_id,
                InvestmentActivity.applied_at.is_not(None),
            ).one_or_none()
            if counterpart_activity is None:
                raise ValueError("owned investment activity is required")
            counterpart = db.query(InvestmentReconciliationItem).filter(
                InvestmentReconciliationItem.source_activity_id == counterpart_activity.id,
                InvestmentReconciliationItem.kind == "cash_match",
            ).one_or_none()
            if counterpart is not None and counterpart.status == "pending":
                counterpart.status = "resolved"
                counterpart.reason = "Matched after explicit user confirmation."
                counterpart.resolution = {
                    "action": "link_activity",
                    "activity_id": str(item.source_activity_id),
                    "confidence": "confirmed",
                }
                counterpart.resolved_at = datetime.utcnow()
        item.status = "resolved"
    elif item.kind == "cash_match" and action == "link_transaction":
        if not transaction_id or not item.income_event_id:
            raise ValueError("transaction_id is required")
        transaction = db.query(Transaction).filter(
            Transaction.id == transaction_id,
            Transaction.user_id == user_id,
        ).one_or_none()
        event = db.query(InvestmentIncomeEvent).filter(
            InvestmentIncomeEvent.id == item.income_event_id,
            InvestmentIncomeEvent.user_id == user_id,
        ).one_or_none()
        if transaction is None or event is None:
            raise ValueError("owned transaction and income event are required")
        already_used = db.query(InvestmentIncomeEvent.id).filter(
            InvestmentIncomeEvent.matched_transaction_id == transaction.id,
            InvestmentIncomeEvent.id != event.id,
        ).first()
        if already_used:
            raise ValueError("transaction is already linked to another income event")
        event.matched_transaction_id = transaction.id
        item.status = "resolved"
    elif item.kind == "annual_statement" and action == "link_income_event":
        if not income_event_id:
            raise ValueError("income_event_id is required")
        activity = db.query(InvestmentActivity).filter(
            InvestmentActivity.id == item.source_activity_id,
            InvestmentActivity.user_id == user_id,
        ).one()
        event = db.query(InvestmentIncomeEvent).filter(
            InvestmentIncomeEvent.id == income_event_id,
            InvestmentIncomeEvent.user_id == user_id,
            InvestmentIncomeEvent.account_id == item.account_id,
        ).one_or_none()
        if event is None:
            raise ValueError("owned income event is required")
        holding = db.query(Holding).filter(
            Holding.id == event.holding_id,
            Holding.symbol == activity.asset_symbol,
        ).one_or_none()
        account = db.query(Account).filter(
            Account.id == item.account_id,
            Account.user_id == user_id,
        ).one()
        if holding is None:
            raise ValueError("income event does not match the statement asset")
        enrich_income_event_from_statement(
            db,
            account=account,
            holding=holding,
            activity=activity,
            event=event,
        )
        item.income_event_id = event.id
        item.status = "resolved"
    elif item.kind == "component_conflict" and action in {"keep_existing", "apply_statement"}:
        event = db.query(InvestmentIncomeEvent).filter(
            InvestmentIncomeEvent.id == item.income_event_id,
            InvestmentIncomeEvent.user_id == user_id,
        ).one_or_none()
        if event is None:
            raise ValueError("income event not found")
        if action == "apply_statement":
            if "cost_base_adjustment" in (item.details or {}).get("conflicts", {}):
                raise ValueError(
                    "this cost-base decrease may create CGT event E10 and cannot be applied automatically"
                )
            sources = dict(event.component_sources or {})
            for field, values in (item.details or {}).get("conflicts", {}).items():
                if field in INCOME_COMPONENT_FIELDS and "statement" in values:
                    value = values["statement"]
                    if field == "ex_date" and value:
                        value = datetime.fromisoformat(str(value)).date()
                    elif field != "amit_amma_components" and value is not None:
                        value = Decimal(str(value))
                    setattr(event, field, value)
                    sources = _append_component_source(
                        sources,
                        field,
                        {"kind": "user_resolution", "reconciliation_item_id": str(item.id)},
                    )
            event.component_sources = sources
        event.user_confirmed_at = datetime.utcnow()
        event.reconciliation_status = "confirmed"
        item.status = "resolved"
    else:
        raise ValueError("resolution action is not valid for this reconciliation item")
    item.resolution = {
        "action": action,
        "income_event_id": str(income_event_id) if income_event_id else None,
        "transaction_id": str(transaction_id) if transaction_id else None,
        "activity_id": str(activity_id) if activity_id else None,
        "confidence": "confirmed" if action in {"link_transaction", "link_activity"} else None,
    }
    item.resolved_at = datetime.utcnow()
    db.commit()
    db.refresh(item)
    return item
