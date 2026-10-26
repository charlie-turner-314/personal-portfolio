"""Portfolio display basis from dated lots; never substitute today's FX."""
from collections import defaultdict
from decimal import Decimal

from app.models import BrokerTrade, InvestmentCostBaseAdjustment
from app.services.pnl_service import Trade, CostBaseAdjustment, compute_fifo


class InvestmentCostBasis:
    def __init__(self, db, account_ids, fx, target):
        self.fx = fx
        self.target = target
        self.rates = {}
        self.trades = defaultdict(list)
        self.adjustments = defaultdict(list)
        for row in db.query(BrokerTrade).filter(BrokerTrade.account_id.in_(account_ids)).all():
            self.trades[(row.account_id, row.symbol, row.instrument_type)].append(row)
        for row in db.query(InvestmentCostBaseAdjustment).filter(InvestmentCostBaseAdjustment.account_id.in_(account_ids)).all():
            self.adjustments[row.holding_id].append(row)

    def convert(self, amount, currency, on):
        if currency == self.target:
            return amount
        if on is None:
            return None
        key = (currency, self.target, on)
        if key not in self.rates:
            self.rates[key] = self.fx.get_exchange_rate(currency, self.target, on)
        rate = self.rates[key]
        return amount * Decimal(rate) if rate is not None else None

    def for_holding(self, holding, on):
        rows = [row for row in self.trades[(holding.account_id, holding.symbol, holding.instrument_type)] if row.trade_date <= on]
        if not rows:
            if holding.source != "manual" or holding.avg_cost is None:
                return None, "unavailable"
            value = self.convert(Decimal(holding.avg_cost) * Decimal(holding.quantity), holding.currency, holding.as_of_date)
            return (value.quantize(Decimal("0.01")) if value is not None else None), "manual_opening_estimate"
        if any(row.valuation_missing for row in rows):
            return None, "incomplete_lots"
        result = compute_fifo([
            Trade(symbol=row.symbol, trade_date=row.trade_date, side=row.side, quantity=Decimal(row.quantity), price=Decimal(row.price), currency=row.currency, fees=Decimal(row.fees or 0), trade_id=str(row.id), sort_key=str(row.id), occurred_at=row.occurred_at, acquisition_date=row.acquisition_date)
            for row in rows
        ], [CostBaseAdjustment(symbol=holding.symbol, effective_date=row.effective_date, amount=Decimal(row.amount_native), currency=row.currency, adjustment_id=str(row.id), sort_key=str(row.id)) for row in self.adjustments[holding.id] if row.effective_date <= on])
        if sum((lot.quantity_remaining for lot in result.open_lots), Decimal(0)) != holding.quantity:
            return None, "incomplete_lots"
        total = Decimal(0)
        for lot in result.open_lots:
            per_unit = self.convert(lot.original_cost_per_share_native, lot.currency, lot.open_date)
            adjustments = [self.convert(item.amount_native, lot.currency, item.effective_date) for item in lot.adjustments]
            if per_unit is None or any(value is None for value in adjustments):
                return None, "missing_historical_fx"
            total += lot.quantity_remaining * (per_unit + sum(adjustments, Decimal(0)))
        return total.quantize(Decimal("0.01")), "recorded_lots"
