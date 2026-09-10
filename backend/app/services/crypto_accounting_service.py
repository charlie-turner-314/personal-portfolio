"""Derived crypto accounting for canonical investment activities.

The normalized activity row remains the immutable provider fact. This module
creates replaceable accounting projections: trade legs, ordinary-income rows,
and matched owned-wallet lot movements. Missing market values are represented
explicitly and never silently inferred as zero for tax reporting.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from decimal import Decimal
from typing import Iterable

from sqlalchemy.orm import Session

from app.models import (
    Account,
    BrokerTrade,
    Holding,
    InvestmentActivity,
    InvestmentCryptoTransfer,
    InvestmentCryptoTransferLot,
    InvestmentIncomeEvent,
)
from app.services.broker_trade_service import _recompute_holding
from app.services.pnl_service import Trade, compute_fifo


FIAT_CODES = frozenset({
    "AUD", "CAD", "CHF", "EUR", "GBP", "HKD", "JPY", "NZD", "SGD", "USD",
})
TRANSFER_ECONOMIC_TYPES = ("transfer_out", "transfer_in")
REWARD_TYPES = frozenset({"staking_reward", "airdrop", "interest"})


@dataclass
class CryptoApplyResult:
    trades: list[BrokerTrade] = field(default_factory=list)
    income_events: list[InvestmentIncomeEvent] = field(default_factory=list)
    affected_instruments: set[tuple[str, str]] = field(default_factory=set)


def _unique_assumptions(*groups: Iterable[str]) -> list[str]:
    result: list[str] = []
    for group in groups:
        for item in group:
            rendered = str(item)
            if rendered not in result:
                result.append(rendered)
    return result


def _event_group(activity: InvestmentActivity, idempotency_key: str) -> str:
    return activity.external_group_id or f"ing:{idempotency_key}:{activity.leg_index}"


def _crypto_aud_terms(
    activity: InvestmentActivity,
    quantity: Decimal,
) -> tuple[Decimal, Decimal | None, str | None, datetime | None, bool, list[str]]:
    assumptions = list(activity.assumptions or [])
    if activity.aud_value is not None:
        value = Decimal(activity.aud_value)
        return (
            value / quantity,
            value,
            activity.valuation_source,
            activity.valuation_timestamp,
            False,
            assumptions,
        )
    if activity.currency == "AUD" and activity.price is not None:
        value = Decimal(activity.price) * quantity
        assumptions = _unique_assumptions(
            assumptions,
            ("AUD market value uses the provider-reported AUD unit price.",),
        )
        return (
            Decimal(activity.price),
            value,
            activity.valuation_source or "reported_aud_price",
            activity.valuation_timestamp or activity.occurred_at,
            False,
            assumptions,
        )
    assumptions = _unique_assumptions(
        assumptions,
        ("AUD market value is missing; holdings quantity is retained but tax valuation is incomplete.",),
    )
    return Decimal("0"), None, None, activity.occurred_at, True, assumptions


def _fee_is_crypto(activity: InvestmentActivity) -> bool:
    code = (activity.fee_currency or "").upper()
    if not code or activity.fee_amount is None:
        return False
    return code not in FIAT_CODES or code in {
        activity.asset_symbol,
        activity.counter_asset_symbol,
    }


def _fiat_fee_aud(
    db: Session,
    activity: InvestmentActivity,
) -> tuple[Decimal, list[str], bool]:
    if activity.fee_amount is None or _fee_is_crypto(activity):
        return Decimal("0"), [], False
    amount = Decimal(activity.fee_amount)
    if activity.fee_aud_value is not None:
        return Decimal(activity.fee_aud_value), [], False
    if activity.fee_currency == "AUD":
        return amount, [], False
    from app.services.exchange_rate_service import ExchangeRateService

    rate = ExchangeRateService(db=db).get_exchange_rate(
        activity.fee_currency,
        "AUD",
        activity.occurred_at.date(),
    )
    if rate is None:
        return Decimal("0"), [
            "Fiat fee AUD conversion is missing and is excluded from the derived tax basis.",
        ], True
    return amount * Decimal(rate), [
        "Fiat fee AUD value uses the recorded daily exchange rate because event-time fee value was absent.",
    ], False


def _new_trade(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
    suffix: str,
    symbol: str,
    side: str,
    quantity: Decimal,
    price: Decimal,
    currency: str,
    economic_type: str,
    idempotency_key: str,
    fees: Decimal = Decimal("0"),
    taxable_disposal: bool = True,
    aud_value: Decimal | None = None,
    valuation_source: str | None = None,
    valuation_timestamp: datetime | None = None,
    valuation_missing: bool = False,
    assumptions: Iterable[str] = (),
    acquisition_date=None,
    source_acquisition_trade_id=None,
) -> BrokerTrade:
    trade = BrokerTrade(
        account_id=account.id,
        symbol=symbol.upper(),
        instrument_type="crypto",
        trade_date=activity.occurred_at.date(),
        occurred_at=activity.occurred_at,
        acquisition_date=acquisition_date or activity.occurred_at.date(),
        side=side,
        quantity=quantity,
        price=price,
        currency=currency,
        fees=fees,
        external_id=f"ing:{idempotency_key}:{activity.leg_index}:{suffix}"[:128],
        economic_type=economic_type,
        taxable_disposal=taxable_disposal,
        aud_value=aud_value,
        valuation_source=valuation_source,
        valuation_timestamp=valuation_timestamp,
        valuation_missing=valuation_missing,
        assumptions=list(assumptions),
        source_activity_id=activity.id,
        event_group_id=_event_group(activity, idempotency_key),
        source_acquisition_trade_id=source_acquisition_trade_id,
    )
    db.add(trade)
    db.flush()
    return trade


def _fee_disposal(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
    idempotency_key: str,
) -> BrokerTrade | None:
    if activity.activity_type == "fee":
        quantity = Decimal(activity.quantity or activity.fee_amount or 0)
        symbol = activity.asset_symbol or activity.fee_currency
    elif _fee_is_crypto(activity):
        quantity = Decimal(activity.fee_amount or 0)
        symbol = activity.fee_currency
    else:
        return None
    if quantity <= 0 or not symbol:
        return None

    aud_value = Decimal(activity.fee_aud_value) if activity.fee_aud_value is not None else None
    source = activity.fee_valuation_source
    timestamp = activity.fee_valuation_timestamp
    assumptions: list[str] = []
    if aud_value is None and symbol == activity.asset_symbol and activity.aud_value is not None and activity.quantity:
        aud_value = Decimal(activity.aud_value) * quantity / Decimal(activity.quantity)
        source = activity.valuation_source
        timestamp = activity.valuation_timestamp
        assumptions.append("Fee market value uses the source asset's event-time AUD unit value.")
    if (
        aud_value is None
        and symbol == activity.asset_symbol
        and activity.currency == "AUD"
        and activity.price is not None
    ):
        aud_value = Decimal(activity.price) * quantity
        source = activity.valuation_source or "reported_aud_price"
        timestamp = activity.valuation_timestamp or activity.occurred_at
        assumptions.append("Fee market value uses the provider-reported AUD unit price.")
    if (
        aud_value is None
        and symbol == activity.counter_asset_symbol
        and activity.aud_value is not None
        and activity.counter_quantity
    ):
        aud_value = Decimal(activity.aud_value) * quantity / Decimal(activity.counter_quantity)
        source = activity.valuation_source
        timestamp = activity.valuation_timestamp
        assumptions.append("Fee market value uses the acquired asset's event-time AUD unit value.")
    if (
        aud_value is None
        and symbol == activity.counter_asset_symbol
        and activity.currency == "AUD"
        and activity.price is not None
        and activity.quantity
        and activity.counter_quantity
    ):
        event_value = Decimal(activity.price) * Decimal(activity.quantity)
        aud_value = event_value * quantity / Decimal(activity.counter_quantity)
        source = activity.valuation_source or "reported_aud_price"
        timestamp = activity.valuation_timestamp or activity.occurred_at
        assumptions.append("Fee market value uses the swap's provider-reported AUD value.")
    missing = aud_value is None
    if missing:
        assumptions.append("Network/trading fee disposal has no event-time AUD market value.")
    assumptions.append("Crypto used to pay a network or trading fee is treated as a separate disposal.")
    return _new_trade(
        db,
        account=account,
        activity=activity,
        suffix="fee",
        symbol=symbol,
        side="sell",
        quantity=quantity,
        price=(aud_value / quantity if aud_value is not None else Decimal("0")),
        currency="AUD",
        economic_type="network_fee",
        idempotency_key=idempotency_key,
        aud_value=aud_value,
        valuation_source=source,
        valuation_timestamp=timestamp or activity.occurred_at,
        valuation_missing=missing,
        assumptions=_unique_assumptions(activity.assumptions or [], assumptions),
    )


def _ensure_crypto_holding(db: Session, account: Account, activity: InvestmentActivity) -> Holding:
    holding = db.query(Holding).filter(
        Holding.account_id == account.id,
        Holding.symbol == activity.asset_symbol,
        Holding.instrument_type == "crypto",
    ).one_or_none()
    if holding is None:
        holding = Holding(
            user_id=account.user_id,
            account_id=account.id,
            symbol=activity.asset_symbol,
            name=activity.asset_name,
            currency="AUD",
            instrument_type="crypto",
            quantity=Decimal("0"),
            avg_cost=None,
            as_of_date=activity.occurred_at.date(),
            source="activity_import",
        )
        db.add(holding)
        db.flush()
    return holding


def _reward_income(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
    idempotency_key: str,
    aud_value: Decimal | None,
    valuation_source: str | None,
    valuation_timestamp: datetime | None,
    valuation_missing: bool,
) -> InvestmentIncomeEvent:
    holding = _ensure_crypto_holding(db, account, activity)
    source_id = f"ing:{idempotency_key}:{activity.leg_index}"
    source = {
        "kind": "crypto_activity",
        "activity_id": str(activity.id),
        "run_id": str(activity.run_id),
    }
    event = InvestmentIncomeEvent(
        user_id=account.user_id,
        account_id=account.id,
        holding_id=holding.id,
        event_type=activity.activity_type,
        pay_date=activity.occurred_at.date(),
        currency="AUD",
        cash_received=Decimal("0"),
        asset_quantity=activity.quantity,
        aud_market_value=aud_value,
        valuation_source=valuation_source,
        valuation_timestamp=valuation_timestamp or activity.occurred_at,
        valuation_missing=valuation_missing,
        source_id=source_id,
        reconciliation_status="confirmed" if not valuation_missing else "provisional",
        component_sources={
            "asset_quantity": [source],
            "aud_market_value": [source],
        },
        created_by_activity_id=activity.id,
        notes=(activity.activity_metadata or {}).get("description"),
    )
    db.add(event)
    db.flush()
    activity.income_event_id = event.id
    return event


def _record_transfer(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
) -> InvestmentCryptoTransfer:
    direction = activity.direction
    if activity.activity_type == "deposit":
        direction = "in"
    elif activity.activity_type == "withdrawal":
        direction = "out"
    if direction is None:
        raise ValueError("crypto transfer direction is required")
    metadata = activity.activity_metadata or {}
    transaction_hash = (
        metadata.get("transaction_hash")
        or metadata.get("tx_hash")
        or activity.external_group_id
    )
    row = InvestmentCryptoTransfer(
        user_id=account.user_id,
        account_id=account.id,
        source_activity_id=activity.id,
        direction=direction,
        asset_symbol=activity.asset_symbol,
        quantity=activity.quantity,
        occurred_at=activity.occurred_at,
        transaction_hash=str(transaction_hash)[:255] if transaction_hash else None,
        status="internal" if direction == "internal" else "pending",
        reason=(
            "Provider marked this as an internal movement within the same account."
            if direction == "internal"
            else "Awaiting a unique opposite movement in another owned account."
        ),
        assumptions=[
            "Deposits and withdrawals remain non-taxable candidates until uniquely matched between owned accounts.",
            "The recorded transfer quantity is treated as the net movement; any crypto network fee is modelled separately.",
        ],
    )
    db.add(row)
    db.flush()
    return row


def apply_crypto_activity(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
    idempotency_key: str,
) -> CryptoApplyResult:
    """Project one canonical crypto activity into trades/income/transfers."""
    result = CryptoApplyResult()
    activity_type = activity.activity_type

    if activity_type in {"buy", "sell"}:
        quantity = Decimal(activity.quantity)
        price, aud_value, source, timestamp, missing, assumptions = _crypto_aud_terms(
            activity, quantity
        )
        fiat_fee, fee_assumptions, fee_missing = _fiat_fee_aud(db, activity)
        trade = _new_trade(
            db,
            account=account,
            activity=activity,
            suffix="trade",
            symbol=activity.asset_symbol,
            side=activity_type,
            quantity=quantity,
            price=price,
            currency="AUD",
            economic_type="trade",
            idempotency_key=idempotency_key,
            fees=fiat_fee,
            aud_value=aud_value,
            valuation_source=source,
            valuation_timestamp=timestamp,
            valuation_missing=missing or fee_missing,
            assumptions=_unique_assumptions(assumptions, fee_assumptions),
        )
        activity.broker_trade_id = trade.id
        result.trades.append(trade)
        result.affected_instruments.add((activity.asset_symbol, "crypto"))

    elif activity_type == "crypto_swap":
        disposed_quantity = Decimal(activity.quantity)
        acquired_quantity = Decimal(activity.counter_quantity)
        price, aud_value, source, timestamp, missing, assumptions = _crypto_aud_terms(
            activity, disposed_quantity
        )
        fiat_fee, fee_assumptions, fee_missing = _fiat_fee_aud(db, activity)
        disposal = _new_trade(
            db,
            account=account,
            activity=activity,
            suffix="swap-out",
            symbol=activity.asset_symbol,
            side="sell",
            quantity=disposed_quantity,
            price=price,
            currency="AUD",
            economic_type="swap_disposal",
            idempotency_key=idempotency_key,
            fees=fiat_fee,
            aud_value=aud_value,
            valuation_source=source,
            valuation_timestamp=timestamp,
            valuation_missing=missing or fee_missing,
            assumptions=_unique_assumptions(
                assumptions,
                fee_assumptions,
                ("A crypto-to-crypto swap is a disposal followed by an acquisition at the same AUD market value.",),
            ),
        )
        acquisition = _new_trade(
            db,
            account=account,
            activity=activity,
            suffix="swap-in",
            symbol=activity.counter_asset_symbol,
            side="buy",
            quantity=acquired_quantity,
            price=(aud_value / acquired_quantity if aud_value is not None else Decimal("0")),
            currency="AUD",
            economic_type="swap_acquisition",
            idempotency_key=idempotency_key,
            aud_value=aud_value,
            valuation_source=source,
            valuation_timestamp=timestamp,
            valuation_missing=missing,
            assumptions=_unique_assumptions(
                assumptions,
                ("Acquired crypto cost base uses the swap's event-time AUD market value.",),
            ),
        )
        activity.broker_trade_id = disposal.id
        result.trades.extend((disposal, acquisition))
        result.affected_instruments.update({
            (activity.asset_symbol, "crypto"),
            (activity.counter_asset_symbol, "crypto"),
        })

    elif activity_type in REWARD_TYPES:
        quantity = Decimal(activity.quantity)
        price, aud_value, source, timestamp, missing, assumptions = _crypto_aud_terms(
            activity, quantity
        )
        acquisition = _new_trade(
            db,
            account=account,
            activity=activity,
            suffix="reward",
            symbol=activity.asset_symbol,
            side="buy",
            quantity=quantity,
            price=price,
            currency="AUD",
            economic_type="reward_acquisition",
            idempotency_key=idempotency_key,
            aud_value=aud_value,
            valuation_source=source,
            valuation_timestamp=timestamp,
            valuation_missing=missing,
            assumptions=_unique_assumptions(
                assumptions,
                ("Reward ordinary income and acquisition cost base use the same receipt-time AUD market value.",),
            ),
        )
        activity.broker_trade_id = acquisition.id
        result.trades.append(acquisition)
        result.income_events.append(_reward_income(
            db,
            account=account,
            activity=activity,
            idempotency_key=idempotency_key,
            aud_value=aud_value,
            valuation_source=source,
            valuation_timestamp=timestamp,
            valuation_missing=missing,
        ))
        result.affected_instruments.add((activity.asset_symbol, "crypto"))

    elif activity_type in {"transfer", "deposit", "withdrawal"}:
        _record_transfer(db, account=account, activity=activity)

    elif activity_type != "fee":
        raise ValueError(f"unsupported crypto accounting activity: {activity_type}")

    fee_trade = _fee_disposal(
        db,
        account=account,
        activity=activity,
        idempotency_key=idempotency_key,
    )
    if fee_trade is not None:
        if activity.broker_trade_id is None:
            activity.broker_trade_id = fee_trade.id
        result.trades.append(fee_trade)
        result.affected_instruments.add((fee_trade.symbol, "crypto"))
    return result


def _trade_event_time(trade: BrokerTrade) -> datetime:
    if trade.occurred_at is not None:
        return trade.occurred_at
    return datetime.combine(
        trade.trade_date,
        time.min if trade.side == "buy" else time.max,
    )


def _transfer_candidates(
    outbound: InvestmentCryptoTransfer,
    inbound: InvestmentCryptoTransfer,
) -> tuple[bool, str | None]:
    if outbound.account_id == inbound.account_id:
        return False, None
    if outbound.asset_symbol != inbound.asset_symbol:
        return False, None
    if Decimal(outbound.quantity) != Decimal(inbound.quantity):
        return False, None
    if outbound.transaction_hash and inbound.transaction_hash:
        return (
            outbound.transaction_hash == inbound.transaction_hash,
            "transaction_hash" if outbound.transaction_hash == inbound.transaction_hash else None,
        )
    if abs(outbound.occurred_at - inbound.occurred_at) <= timedelta(days=7):
        return True, "quantity_time_window"
    return False, None


def _aud_cost_for_open_lot(
    db: Session,
    *,
    currency: str,
    cost_native: Decimal,
    acquisition_date,
    acquisition_trade: BrokerTrade,
) -> tuple[Decimal | None, str | None]:
    if acquisition_trade.valuation_missing:
        return None, None
    if currency == "AUD":
        return cost_native, acquisition_trade.valuation_source or "aud_cost_basis"
    from app.services.exchange_rate_service import ExchangeRateService

    rate = ExchangeRateService(db=db).get_exchange_rate(currency, "AUD", acquisition_date)
    if rate is None:
        return None, None
    return cost_native * Decimal(rate), "exchange_rate_service"


def _create_transfer_pair_lots(
    db: Session,
    *,
    outbound: InvestmentCryptoTransfer,
    inbound: InvestmentCryptoTransfer,
) -> tuple[bool, set[tuple[object, str]]]:
    source_account = db.query(Account).filter(Account.id == outbound.account_id).one()
    destination_account = db.query(Account).filter(Account.id == inbound.account_id).one()
    source_activity = db.query(InvestmentActivity).filter(
        InvestmentActivity.id == outbound.source_activity_id
    ).one()
    destination_activity = db.query(InvestmentActivity).filter(
        InvestmentActivity.id == inbound.source_activity_id
    ).one()
    trades = db.query(BrokerTrade).filter(
        BrokerTrade.account_id == source_account.id,
        BrokerTrade.symbol == outbound.asset_symbol,
        BrokerTrade.instrument_type == "crypto",
    ).all()
    eligible = [item for item in trades if _trade_event_time(item) <= outbound.occurred_at]
    fifo = compute_fifo([
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
            occurred_at=item.occurred_at,
            acquisition_date=item.acquisition_date,
        )
        for item in eligible
    ])
    open_lots = sorted(
        (item for item in fifo.open_lots if item.symbol == outbound.asset_symbol),
        key=lambda item: (item.open_date, item.acquisition_trade_id or ""),
    )
    available = sum((Decimal(item.quantity_remaining) for item in open_lots), Decimal("0"))
    required = Decimal(outbound.quantity)
    if available < required:
        outbound.status = inbound.status = "ambiguous"
        outbound.reason = inbound.reason = (
            f"Matched movement needs {required} {outbound.asset_symbol}, but only {available} units have known source lots."
        )
        return False, set()

    trades_by_id = {str(item.id): item for item in eligible}
    remaining = required
    affected: set[tuple[object, str]] = {
        (source_account.id, outbound.asset_symbol),
        (destination_account.id, inbound.asset_symbol),
    }
    for index, lot in enumerate(open_lots):
        if remaining <= 0:
            break
        quantity = min(Decimal(lot.quantity_remaining), remaining)
        acquisition = trades_by_id[lot.acquisition_trade_id]
        cost_native = quantity * Decimal(lot.cost_per_share_native)
        cost_aud, cost_source = _aud_cost_for_open_lot(
            db,
            currency=lot.currency,
            cost_native=cost_native,
            acquisition_date=lot.open_date,
            acquisition_trade=acquisition,
        )
        source_trade = BrokerTrade(
            account_id=source_account.id,
            symbol=outbound.asset_symbol,
            instrument_type="crypto",
            trade_date=outbound.occurred_at.date(),
            occurred_at=outbound.occurred_at,
            acquisition_date=outbound.occurred_at.date(),
            side="sell",
            quantity=quantity,
            price=lot.cost_per_share_native,
            currency=lot.currency,
            fees=Decimal("0"),
            external_id=f"crypto-transfer-out:{outbound.id}:{index}"[:128],
            economic_type="transfer_out",
            taxable_disposal=False,
            aud_value=cost_aud,
            valuation_source="basis_carry_forward" if cost_aud is not None else None,
            valuation_timestamp=outbound.occurred_at,
            valuation_missing=cost_aud is None,
            assumptions=["Owned-wallet transfer out consumes FIFO units without creating a CGT disposal."],
            source_activity_id=source_activity.id,
            event_group_id=str(outbound.id),
        )
        db.add(source_trade)
        db.flush()
        destination_trade = BrokerTrade(
            account_id=destination_account.id,
            symbol=inbound.asset_symbol,
            instrument_type="crypto",
            trade_date=inbound.occurred_at.date(),
            occurred_at=inbound.occurred_at,
            acquisition_date=lot.open_date,
            side="buy",
            quantity=quantity,
            price=(cost_aud / quantity if cost_aud is not None else Decimal("0")),
            currency="AUD",
            fees=Decimal("0"),
            external_id=f"crypto-transfer-in:{inbound.id}:{index}"[:128],
            economic_type="transfer_in",
            taxable_disposal=False,
            aud_value=cost_aud,
            valuation_source="basis_carry_forward" if cost_aud is not None else None,
            valuation_timestamp=inbound.occurred_at,
            valuation_missing=cost_aud is None,
            assumptions=["Owned-wallet transfer in carries original acquisition date and cost basis."],
            source_activity_id=destination_activity.id,
            event_group_id=str(outbound.id),
            source_acquisition_trade_id=(
                acquisition.source_acquisition_trade_id or acquisition.id
            ),
        )
        db.add(destination_trade)
        db.flush()
        db.add(InvestmentCryptoTransferLot(
            transfer_out_id=outbound.id,
            transfer_in_id=inbound.id,
            source_broker_trade_id=source_trade.id,
            destination_broker_trade_id=destination_trade.id,
            original_acquisition_trade_id=(
                acquisition.source_acquisition_trade_id or acquisition.id
            ),
            quantity=quantity,
            acquisition_date=lot.open_date,
            source_currency=lot.currency,
            unit_cost_native=lot.cost_per_share_native,
            cost_base_aud=cost_aud,
            valuation_source=cost_source,
            provenance={
                "outbound_activity_id": str(outbound.source_activity_id),
                "inbound_activity_id": str(inbound.source_activity_id),
                "source_acquisition_trade_id": str(acquisition.id),
            },
        ))
        if source_activity.broker_trade_id is None:
            source_activity.broker_trade_id = source_trade.id
        if destination_activity.broker_trade_id is None:
            destination_activity.broker_trade_id = destination_trade.id
        remaining -= quantity
    db.flush()
    return True, affected


def rebuild_owned_crypto_transfers(db: Session, *, user_id: str) -> dict[str, int]:
    """Deterministically rebuild matched transfer legs after imports or backfills."""
    transfers = db.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.user_id == user_id
    ).order_by(InvestmentCryptoTransfer.occurred_at, InvestmentCryptoTransfer.id).all()
    transfer_ids = [item.id for item in transfers]
    transfer_activity_ids = [item.source_activity_id for item in transfers]
    if transfer_ids:
        db.query(InvestmentCryptoTransferLot).filter(
            InvestmentCryptoTransferLot.transfer_out_id.in_(transfer_ids)
        ).delete(synchronize_session=False)
    account_ids = [row[0] for row in db.query(Account.id).filter(Account.user_id == user_id).all()]
    old_derived = db.query(BrokerTrade).filter(
        BrokerTrade.account_id.in_(account_ids),
        BrokerTrade.economic_type.in_(TRANSFER_ECONOMIC_TYPES),
    ).all() if account_ids else []
    affected: set[tuple[object, str]] = {
        (item.account_id, item.symbol) for item in old_derived
    }
    for item in old_derived:
        db.delete(item)
    if transfer_activity_ids:
        db.query(InvestmentActivity).filter(
            InvestmentActivity.id.in_(transfer_activity_ids)
        ).update({InvestmentActivity.broker_trade_id: None}, synchronize_session="fetch")
    for item in transfers:
        item.matched_transfer_id = None
        item.match_method = None
        if item.direction == "internal":
            item.status = "internal"
            item.reason = "Provider marked this as an internal movement within the same account."
        else:
            item.status = "pending"
            item.reason = "Awaiting a unique opposite movement in another owned account."
    db.flush()

    outgoing = [item for item in transfers if item.direction == "out"]
    incoming = [item for item in transfers if item.direction == "in"]
    used_incoming: set[object] = set()
    matched = 0
    for outbound in outgoing:
        candidates: list[tuple[InvestmentCryptoTransfer, str]] = []
        for inbound in incoming:
            if inbound.id in used_incoming:
                continue
            matches, method = _transfer_candidates(outbound, inbound)
            if matches and method:
                candidates.append((inbound, method))
        # A provider transaction hash is stronger evidence than the fallback
        # quantity/time heuristic. Do not let a nearby hashless observation
        # make an otherwise exact on-chain match ambiguous.
        exact_candidates = [item for item in candidates if item[1] == "transaction_hash"]
        if exact_candidates:
            candidates = exact_candidates
        if len(candidates) != 1:
            if candidates:
                outbound.status = "ambiguous"
                outbound.reason = "Multiple owned-account movements match this transfer."
                for inbound, _ in candidates:
                    inbound.status = "ambiguous"
                    inbound.reason = "Multiple owned-account movements match this transfer."
            continue
        inbound, method = candidates[0]
        reverse_candidates = [
            other for other in outgoing
            if _transfer_candidates(other, inbound)[0]
        ]
        exact_reverse_candidates = [
            other for other in reverse_candidates
            if _transfer_candidates(other, inbound)[1] == "transaction_hash"
        ]
        if exact_reverse_candidates:
            reverse_candidates = exact_reverse_candidates
        if len(reverse_candidates) != 1:
            outbound.status = inbound.status = "ambiguous"
            outbound.reason = inbound.reason = "Transfer match is not unique in both directions."
            continue
        success, pair_affected = _create_transfer_pair_lots(
            db,
            outbound=outbound,
            inbound=inbound,
        )
        if not success:
            continue
        outbound.matched_transfer_id = inbound.id
        inbound.matched_transfer_id = outbound.id
        outbound.status = inbound.status = "matched"
        outbound.match_method = inbound.match_method = method
        outbound.reason = inbound.reason = "Matched between owned accounts; original lot basis is preserved."
        used_incoming.add(inbound.id)
        affected.update(pair_affected)
        matched += 1
    db.flush()

    accounts = {
        account.id: account
        for account in db.query(Account).filter(Account.id.in_([item[0] for item in affected])).all()
    } if affected else {}
    for account_id, symbol in sorted(affected, key=lambda item: (str(item[0]), item[1])):
        _recompute_holding(db, accounts[account_id], symbol, "crypto")
    return {
        "total_transfers": len(transfers),
        "matched_pairs": matched,
        "ambiguous_transfers": sum(1 for item in transfers if item.status == "ambiguous"),
        "pending_transfers": sum(1 for item in transfers if item.status == "pending"),
        "internal_transfers": sum(1 for item in transfers if item.status == "internal"),
    }


def transfer_view(item: InvestmentCryptoTransfer) -> dict[str, object]:
    return {
        "id": str(item.id),
        "account_id": str(item.account_id),
        "source_activity_id": str(item.source_activity_id),
        "matched_transfer_id": str(item.matched_transfer_id) if item.matched_transfer_id else None,
        "direction": item.direction,
        "asset_symbol": item.asset_symbol,
        "quantity": format(Decimal(item.quantity), "f"),
        "occurred_at": item.occurred_at.isoformat(),
        "transaction_hash": item.transaction_hash,
        "status": item.status,
        "match_method": item.match_method,
        "reason": item.reason,
        "assumptions": item.assumptions or [],
    }
