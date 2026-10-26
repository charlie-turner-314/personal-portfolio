"""Balance units and provenance. Estimates never become independent observations."""

from datetime import date, datetime
from decimal import Decimal
from sqlalchemy import func
from app.models import ExchangeRate

INDEPENDENT_BALANCE_SOURCES = ("bank", "statement", "manual")


def as_date(value):
    return value.date() if isinstance(value, datetime) else value


def convert_balance_amount(db, amount, source, target, on: date):
    if amount is None or not source or not target:
        return None
    value = Decimal(str(amount))
    if source == target:
        return value
    for base, quote, inverse in ((source, target, False), (target, source, True)):
        rate = (
            db.query(ExchangeRate)
            .filter(
                ExchangeRate.base_currency == base,
                ExchangeRate.target_currency == quote,
                ExchangeRate.rate > 0,
                func.date(ExchangeRate.date) <= on,
            )
            .order_by(ExchangeRate.date.desc())
            .first()
        )
        if rate is not None:
            return value / rate.rate if inverse else value * rate.rate
    return None


def snapshot_native(db, snapshot, account):
    return convert_balance_amount(
        db,
        snapshot.balance_in_account_currency,
        snapshot.account_currency or account.currency,
        account.currency,
        as_date(snapshot.date),
    )
