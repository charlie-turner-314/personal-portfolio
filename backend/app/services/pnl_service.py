"""
Pure FIFO P&L engine.

`compute_fifo` is a pure function over a list of trades — no DB access,
no FX, no I/O. DB- and FX-aware wrappers live below.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Callable, Iterable, Optional


@dataclass(frozen=True)
class Trade:
    """Input trade for the FIFO engine."""
    symbol: str
    trade_date: date
    side: str  # "buy" | "sell"
    quantity: Decimal
    price: Decimal
    currency: str
    fees: Decimal = Decimal("0")  # native currency, non-negative
    trade_id: Optional[str] = None
    sort_key: Optional[str] = None


@dataclass(frozen=True)
class CostBaseAdjustment:
    """A signed adjustment applied across units open on its effective date.

    Positive amounts increase cost base (AMIT shortfall); negative amounts
    decrease it (AMIT excess). The signed convention is deliberately stored
    at the domain boundary so statement labels cannot be misinterpreted later.
    """
    symbol: str
    effective_date: date
    amount: Decimal
    currency: str
    adjustment_id: Optional[str] = None
    sort_key: Optional[str] = None


@dataclass(frozen=True)
class AppliedCostBaseAdjustment:
    adjustment_id: Optional[str]
    effective_date: date
    amount_native: Decimal


@dataclass(frozen=True)
class ClosedLot:
    """A realized P&L lot — the result of a sell matching against open buy lots."""
    symbol: str
    currency: str
    open_date: date
    close_date: date
    quantity: Decimal
    cost_native: Decimal
    original_cost_native: Decimal
    cost_base_adjustment_native: Decimal
    proceeds_native: Decimal
    pnl_native: Decimal
    acquisition_trade_id: Optional[str] = None
    disposal_trade_id: Optional[str] = None
    adjustments: tuple[AppliedCostBaseAdjustment, ...] = ()


@dataclass(frozen=True)
class OpenLot:
    """A remaining unmatched buy lot."""
    symbol: str
    currency: str
    open_date: date
    quantity_remaining: Decimal
    cost_per_share_native: Decimal
    original_cost_per_share_native: Decimal = Decimal("0")
    cost_base_adjustment_per_share_native: Decimal = Decimal("0")
    adjustments: tuple[AppliedCostBaseAdjustment, ...] = ()


@dataclass
class FifoResult:
    realized: list[ClosedLot] = field(default_factory=list)
    open_lots: list[OpenLot] = field(default_factory=list)


@dataclass(frozen=True)
class CgtAudValues:
    """AUD amounts for an auditable disposal allocation, or an explicit FX gap."""
    cost_base_aud: Optional[Decimal]
    proceeds_aud: Optional[Decimal]
    gain_aud: Optional[Decimal]
    cost_base_adjustment_aud: Optional[Decimal]
    fx_missing: bool


class OverSellError(Exception):
    """Raised when a sell exceeds available open quantity for a symbol."""
    def __init__(self, symbol: str, trade_date: date, qty_attempted: Decimal, qty_available: Decimal):
        self.symbol = symbol
        self.trade_date = trade_date
        self.qty_attempted = qty_attempted
        self.qty_available = qty_available
        super().__init__(
            f"Sell of {qty_attempted} {symbol} on {trade_date} exceeds available {qty_available}"
        )


class CostBaseAdjustmentError(Exception):
    """Raised when an adjustment cannot safely be applied to open units."""

    def __init__(self, symbol: str, effective_date: date, reason: str):
        self.symbol = symbol
        self.effective_date = effective_date
        self.reason = reason
        super().__init__(f"Cost-base adjustment for {symbol} on {effective_date} {reason}")


@dataclass
class _MutableLot:
    open_date: date
    quantity_remaining: Decimal
    cost_per_share_native: Decimal
    original_cost_per_share_native: Decimal
    currency: str
    trade_id: Optional[str]
    adjustments_per_share: list[AppliedCostBaseAdjustment] = field(default_factory=list)


def compute_fifo(
    trades: Iterable[Trade],
    adjustments: Iterable[CostBaseAdjustment] = (),
) -> FifoResult:
    """
    Apply FIFO matching to a sequence of trades.

    Trades are processed in chronological order (then by side, buys first on
    ties so a same-day buy can cover a same-day sell).

    Currency is tracked per-symbol; if a symbol's trades use mixed currencies
    they are still matched (currency redenomination is out of scope for the
    pure engine — caller decides whether to split).
    """
    events: list[tuple[date, int, str, Trade | CostBaseAdjustment]] = [
        (trade.trade_date, 0 if trade.side == "buy" else 2, trade.sort_key or trade.trade_id or "", trade)
        for trade in trades
    ]
    events.extend(
        (item.effective_date, 1, item.sort_key or item.adjustment_id or "", item)
        for item in adjustments
    )
    events.sort(key=lambda item: item[:3])

    open_by_key: dict[tuple[str, str], list[_MutableLot]] = {}
    realized: list[ClosedLot] = []

    for _, _, _, t in events:
        if isinstance(t, CostBaseAdjustment):
            lots = open_by_key.setdefault((t.symbol, t.currency), [])
            open_quantity = sum((lot.quantity_remaining for lot in lots), Decimal("0"))
            if open_quantity <= 0:
                raise CostBaseAdjustmentError(t.symbol, t.effective_date, "has no open units")
            per_share = t.amount / open_quantity
            if any(lot.cost_per_share_native + per_share < 0 for lot in lots):
                raise CostBaseAdjustmentError(
                    t.symbol,
                    t.effective_date,
                    "would reduce an open lot below a zero cost base; review possible CGT event E10",
                )
            for lot in lots:
                lot.cost_per_share_native += per_share
                lot.adjustments_per_share.append(AppliedCostBaseAdjustment(
                    adjustment_id=t.adjustment_id,
                    effective_date=t.effective_date,
                    amount_native=per_share,
                ))
            continue

        lots = open_by_key.setdefault((t.symbol, t.currency), [])
        if t.side == "buy":
            # Buy fees increase cost basis: cost_per_share = (price*qty + fees) / qty
            cost_per_share = (
                (t.price * t.quantity + t.fees) / t.quantity
                if t.quantity > 0
                else t.price
            )
            lots.append(_MutableLot(
                open_date=t.trade_date,
                quantity_remaining=t.quantity,
                cost_per_share_native=cost_per_share,
                original_cost_per_share_native=cost_per_share,
                currency=t.currency,
                trade_id=t.trade_id,
            ))
            continue

        # sell — fees reduce proceeds, prorated by consumed quantity vs total sell qty
        remaining = t.quantity
        sell_total_qty = t.quantity
        # Pre-compute available quantity before iterating (for oversell error reporting)
        available_at_start = sum((l.quantity_remaining for l in lots), Decimal("0"))
        while remaining > 0:
            if not lots:
                raise OverSellError(t.symbol, t.trade_date, t.quantity, available_at_start)
            lot = lots[0]
            consumed = min(lot.quantity_remaining, remaining)
            cost = consumed * lot.cost_per_share_native
            original_cost = consumed * lot.original_cost_per_share_native
            applied_adjustments = tuple(
                AppliedCostBaseAdjustment(
                    adjustment_id=item.adjustment_id,
                    effective_date=item.effective_date,
                    amount_native=item.amount_native * consumed,
                )
                for item in lot.adjustments_per_share
            )
            adjustment_cost = cost - original_cost
            fee_share = (t.fees * consumed / sell_total_qty) if sell_total_qty > 0 else Decimal("0")
            proceeds = consumed * t.price - fee_share
            realized.append(ClosedLot(
                symbol=t.symbol,
                currency=t.currency,
                open_date=lot.open_date,
                close_date=t.trade_date,
                quantity=consumed,
                cost_native=cost,
                original_cost_native=original_cost,
                cost_base_adjustment_native=adjustment_cost,
                proceeds_native=proceeds,
                pnl_native=proceeds - cost,
                acquisition_trade_id=lot.trade_id,
                disposal_trade_id=t.trade_id,
                adjustments=applied_adjustments,
            ))
            lot.quantity_remaining -= consumed
            remaining -= consumed
            if lot.quantity_remaining == 0:
                lots.pop(0)

    open_lots: list[OpenLot] = []
    for (sym, _ccy), lots in open_by_key.items():
        for lot in lots:
            open_lots.append(OpenLot(
                symbol=sym,
                currency=lot.currency,
                open_date=lot.open_date,
                quantity_remaining=lot.quantity_remaining,
                cost_per_share_native=lot.cost_per_share_native,
                original_cost_per_share_native=lot.original_cost_per_share_native,
                cost_base_adjustment_per_share_native=(
                    lot.cost_per_share_native - lot.original_cost_per_share_native
                ),
                adjustments=tuple(lot.adjustments_per_share),
            ))

    return FifoResult(realized=realized, open_lots=open_lots)


def is_cgt_discount_eligible(acquisition_date: date, disposal_date: date) -> bool:
    """Return whether a disposal is on or after the acquisition's calendar-year anniversary."""
    try:
        anniversary = acquisition_date.replace(year=acquisition_date.year + 1)
    except ValueError:  # 29 February has no anniversary in a non-leap year.
        anniversary = acquisition_date.replace(year=acquisition_date.year + 1, day=28)
    return disposal_date >= anniversary


def cgt_aud_values_for_closed_lot(
    lot: ClosedLot,
    fx_rate_for: Callable[[str, str, date], Optional[Decimal]],
) -> CgtAudValues:
    """Convert cost and proceeds independently at their respective transaction dates."""
    def convert(amount: Decimal, on: date) -> Optional[Decimal]:
        if lot.currency.upper() == "AUD":
            return amount.quantize(Decimal("0.01"))
        rate = fx_rate_for(lot.currency.upper(), "AUD", on)
        return (amount * Decimal(rate)).quantize(Decimal("0.01")) if rate is not None else None

    original_cost_aud = convert(lot.original_cost_native, lot.open_date)
    converted_adjustments = [
        convert(adjustment.amount_native, adjustment.effective_date)
        for adjustment in lot.adjustments
    ]
    proceeds_aud = convert(lot.proceeds_native, lot.close_date)
    if original_cost_aud is None or proceeds_aud is None or any(
        value is None for value in converted_adjustments
    ):
        return CgtAudValues(None, None, None, None, fx_missing=True)
    adjustment_aud = sum(
        (value for value in converted_adjustments if value is not None),
        Decimal("0"),
    ).quantize(Decimal("0.01"))
    cost_base_aud = original_cost_aud + adjustment_aud
    return CgtAudValues(
        cost_base_aud=cost_base_aud,
        proceeds_aud=proceeds_aud,
        gain_aud=proceeds_aud - cost_base_aud,
        cost_base_adjustment_aud=adjustment_aud,
        fx_missing=False,
    )


def compute_open_quantity_series(
    trades: Iterable[Trade],
    start: date,
    end: date,
) -> dict[str, dict[date, Decimal]]:
    """
    For each symbol, return a per-day mapping of end-of-day open quantity
    over the inclusive range [start, end].

    Buys add to the running quantity on their trade_date; sells subtract
    (no FIFO matching needed — we only care about totals here). On any day
    with no activity the prior day's quantity carries forward. The series
    starts at 0 on `start` and is forward-filled.

    Note: dates earlier than `start` are still applied to the running total
    (so a holding bought before `start` shows its full quantity on `start`).
    """
    by_symbol: dict[str, list[Trade]] = {}
    for t in trades:
        by_symbol.setdefault(t.symbol, []).append(t)

    out: dict[str, dict[date, Decimal]] = {}
    for symbol, sym_trades in by_symbol.items():
        sym_trades = sorted(sym_trades, key=lambda t: t.trade_date)
        # Apply trades strictly before `start` to seed the running quantity.
        running = Decimal("0")
        idx = 0
        while idx < len(sym_trades) and sym_trades[idx].trade_date < start:
            t = sym_trades[idx]
            running += t.quantity if t.side == "buy" else -t.quantity
            idx += 1

        series: dict[date, Decimal] = {}
        cur = start
        while cur <= end:
            while idx < len(sym_trades) and sym_trades[idx].trade_date == cur:
                t = sym_trades[idx]
                running += t.quantity if t.side == "buy" else -t.quantity
                idx += 1
            series[cur] = running
            cur += timedelta(days=1)
        out[symbol] = series
    return out


def realized_pnl_from_trades(
    trades: Iterable[Trade],
    base_currency: str,
    fx_service,
) -> list[dict]:
    """
    Run FIFO and enrich each closed lot with base-currency P&L.

    `fx_service` must implement `get_exchange_rate(src, dst, on: date) -> Decimal | None`
    (matches `app.services.exchange_rate_service.ExchangeRateService`).

    Groups closed lots by symbol; per-lot FX is taken on the lot's close_date.
    Lots whose FX lookup fails contribute 0 to `realized_base` and are flagged
    via a `fx_missing` boolean on the lot dict.
    """
    fifo = compute_fifo(trades)

    by_symbol: dict[str, list[ClosedLot]] = {}
    for lot in fifo.realized:
        by_symbol.setdefault(lot.symbol, []).append(lot)

    out: list[dict] = []
    for symbol, lots in by_symbol.items():
        symbol_currency = lots[0].currency
        realized_native_total = Decimal("0")
        realized_base_total = Decimal("0")
        lot_dicts = []
        for lot in lots:
            rate = fx_service.get_exchange_rate(lot.currency, base_currency, lot.close_date)
            if rate is None:
                pnl_base = Decimal("0")
                fx_missing = True
            else:
                pnl_base = (lot.pnl_native * rate).quantize(Decimal("0.01"))
                fx_missing = False
            realized_native_total += lot.pnl_native
            realized_base_total += pnl_base
            lot_dicts.append({
                "open_date": lot.open_date.isoformat(),
                "close_date": lot.close_date.isoformat(),
                "quantity": lot.quantity,
                "cost_native": lot.cost_native,
                "proceeds_native": lot.proceeds_native,
                "pnl_native": lot.pnl_native,
                "pnl_base": pnl_base,
                "fx_missing": fx_missing,
            })
        out.append({
            "symbol": symbol,
            "currency": symbol_currency,
            "realized_native": realized_native_total,
            "realized_base": realized_base_total,
            "lots_closed": lot_dicts,
        })
    return out


def unrealized_pnl_from_trades(
    trades: Iterable[Trade],
    base_currency: str,
    fx_service,
    latest_prices: dict[str, Decimal],
    as_of_date: date,
) -> list[dict]:
    """
    Run FIFO; for each remaining open lot group by symbol; compute:
      cost_basis_native  = sum(qty_remaining * cost_per_share)
      market_value_native = sum(qty_remaining) * latest_price[symbol]
      unrealized_native   = market_value_native - cost_basis_native
      *_base via fx_service.get_exchange_rate(symbol_ccy, base_currency, as_of_date)

    Symbols with no entry in `latest_prices` are skipped (caller logs them).
    Symbols whose FX lookup fails set `fx_missing=True` and base values to 0.
    """
    fifo = compute_fifo(trades)

    by_symbol: dict[str, list[OpenLot]] = {}
    for lot in fifo.open_lots:
        by_symbol.setdefault(lot.symbol, []).append(lot)

    out: list[dict] = []
    for symbol, lots in by_symbol.items():
        price = latest_prices.get(symbol)
        if price is None:
            continue
        symbol_currency = lots[0].currency
        quantity = sum((l.quantity_remaining for l in lots), Decimal("0"))
        cost_basis_native = sum(
            (l.quantity_remaining * l.cost_per_share_native for l in lots),
            Decimal("0"),
        )
        market_value_native = quantity * price
        unrealized_native = market_value_native - cost_basis_native

        rate = fx_service.get_exchange_rate(symbol_currency, base_currency, as_of_date)
        if rate is None:
            fx_missing = True
            cost_basis_base = Decimal("0")
            market_value_base = Decimal("0")
            unrealized_base = Decimal("0")
        else:
            fx_missing = False
            cost_basis_base = (cost_basis_native * rate).quantize(Decimal("0.01"))
            market_value_base = (market_value_native * rate).quantize(Decimal("0.01"))
            unrealized_base = (unrealized_native * rate).quantize(Decimal("0.01"))

        out.append({
            "symbol": symbol,
            "currency": symbol_currency,
            "quantity": quantity,
            "cost_basis_native": cost_basis_native,
            "cost_basis_base": cost_basis_base,
            "market_value_native": market_value_native,
            "market_value_base": market_value_base,
            "unrealized_native": unrealized_native,
            "unrealized_base": unrealized_base,
            "fx_missing": fx_missing,
        })
    return out
