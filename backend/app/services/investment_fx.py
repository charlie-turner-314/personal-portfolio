"""Strict currency conversion shared by scheduled and interactive investment sync."""
from app.services.exchange_rate_service import ExchangeRateService


class MissingInvestmentFx(ValueError):
    pass


class InvestmentFxAdapter:
    def __init__(self, db):
        self._svc = ExchangeRateService(db=db)

    def convert(self, amount, src, dst, on):
        if src.upper() == dst.upper():
            return amount
        result = self._svc.convert_amount(
            amount=amount, from_currency=src, to_currency=dst, for_date=on,
        )
        if result is None:
            raise MissingInvestmentFx(f"FX unavailable: {src}/{dst} on {on}")
        return result
