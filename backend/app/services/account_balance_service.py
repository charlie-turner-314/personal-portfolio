"""Persist supplied observations separately from transaction-derived estimates.

Legacy rows retain their original values and cannot prove reconciliation.
Only calculated rows may be replaced by recalculation. Later estimates use the
latest recorded native balance plus subsequent, individually converted activity.
"""

from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Dict, Optional, List, Set
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.models import Account, Transaction, User, AccountBalance
from app.services.balance_observations import (
    as_date,
    convert_balance_amount,
    snapshot_native,
)


class AccountBalanceService:
    def __init__(self, db: Session):
        self.db = db

    def _accounts(self, user_id, account_ids):
        query = self.db.query(Account).filter(
            Account.user_id == user_id, Account.consolidated_into_account_id.is_(None)
        )
        if account_ids is not None:
            query = query.filter(Account.id.in_(account_ids))
        return query.all()

    def _currency(self, user_id):
        user = self.db.get(User, user_id)
        return user.functional_currency if user and user.functional_currency else "EUR"

    def _estimates(self, account, start, end):
        """Yield end-of-day native values; unknown FX contaminates until an anchor."""
        transactions = (
            self.db.query(Transaction)
            .filter(
                Transaction.account_id == account.id,
                func.date(Transaction.booked_at) <= end,
            )
            .order_by(Transaction.booked_at)
            .all()
        )
        daily = {}
        for transaction in transactions:
            day = as_date(transaction.booked_at)
            amount = convert_balance_amount(
                self.db, transaction.amount, transaction.currency, account.currency, day
            )
            previous = daily.get(day, Decimal("0"))
            daily[day] = (
                previous + amount
                if previous is not None and amount is not None
                else None
            )
        # Unknown legacy values are preserved, but usable native values may anchor
        # estimates. This does not grant them independent reconciliation status.
        anchors = {}
        for row in (
            self.db.query(AccountBalance)
            .filter(
                AccountBalance.account_id == account.id,
                AccountBalance.balance_source != "calculated",
                func.date(AccountBalance.date) <= end,
            )
            .order_by(AccountBalance.date)
            .all()
        ):
            anchors[as_date(row.date)] = snapshot_native(self.db, row, account)
        earliest = min([start, *daily, *anchors])
        running = Decimal(str(account.starting_balance or 0))
        day = earliest
        while day <= end:
            if day in anchors:
                running = anchors[day]
            elif day in daily:
                amount = daily[day]
                running = (
                    running + amount
                    if running is not None and amount is not None
                    else None
                )
            if day >= start:
                yield day, running
            day += timedelta(days=1)

    def calculate_account_balances(
        self, user_id: str, account_ids: Optional[list] = None
    ) -> Dict:
        currency = self._currency(user_id)
        today = date.today()
        accounts = self._accounts(user_id, account_ids)
        for account in accounts:
            native = next(self._estimates(account, today, today))[1]
            account.functional_balance = convert_balance_amount(
                self.db, native, account.currency, currency, today
            )
        self.db.commit()
        return {"accounts_updated": len(accounts), "accounts_failed": 0}

    def calculate_account_timeseries(
        self,
        user_id: str,
        account_ids: Optional[list] = None,
        skip_dates: Optional[Dict[str, Set[date]]] = None,
    ) -> Dict:
        currency = self._currency(user_id)
        accounts = self._accounts(user_id, account_ids)
        days = stored = 0
        today = date.today()
        for account in accounts:
            first = (
                self.db.query(func.min(Transaction.booked_at))
                .filter(Transaction.account_id == account.id)
                .scalar()
            )
            start = as_date(first or account.created_at or today)
            for day, native in self._estimates(account, start, today):
                days += 1
                # A skip hint never establishes provenance. Persistent source wins.
                if skip_dates and day in skip_dates.get(str(account.id), set()):
                    continue
                existing = (
                    self.db.query(AccountBalance)
                    .filter(
                        AccountBalance.account_id == account.id,
                        func.date(AccountBalance.date) == day,
                    )
                    .order_by(AccountBalance.date.desc())
                    .first()
                )
                if existing is not None and existing.balance_source != "calculated":
                    continue
                row = existing or AccountBalance(
                    account_id=account.id,
                    date=datetime.combine(day, datetime.min.time()),
                )
                row.balance_in_account_currency = native
                row.balance_in_functional_currency = convert_balance_amount(
                    self.db, native, account.currency, currency, day
                )
                row.balance_source = "calculated"
                row.account_currency = account.currency
                row.functional_currency = currency
                self.db.add(row)
                stored += 1
            # Compute current units afresh; a historical functional value may have
            # been denominated in a previous user preference.
            native = next(self._estimates(account, today, today))[1]
            account.functional_balance = convert_balance_amount(
                self.db, native, account.currency, currency, today
            )
        self.db.commit()
        return {
            "accounts_processed": len(accounts),
            "accounts_failed": 0,
            "total_days_processed": days,
            "total_records_stored": stored,
        }

    def import_daily_balances(
        self, account_id: str, daily_balances: List[Dict], functional_currency: str
    ) -> Dict:
        account = self.db.get(Account, account_id)
        if account is None:
            return {"error": "Account not found", "imported_dates": set()}
        imported = set()
        # Validate the complete batch before changing any rows. Missing is not zero.
        parsed = [
            (date.fromisoformat(item["date"]), Decimal(str(item["balance"])))
            for item in daily_balances
        ]
        if any(not value.is_finite() for _, value in parsed):
            raise ValueError("Balance must be finite")
        for day, native in parsed:
            stamp = datetime.combine(day, datetime.min.time())
            row = (
                self.db.query(AccountBalance)
                .filter(
                    AccountBalance.account_id == account.id,
                    AccountBalance.date == stamp,
                )
                .first()
            )
            row = row or AccountBalance(account_id=account.id, date=stamp)
            row.balance_in_account_currency = native
            row.balance_in_functional_currency = convert_balance_amount(
                self.db, native, account.currency, functional_currency, day
            )
            row.balance_source = "statement"
            row.account_currency = account.currency
            row.functional_currency = functional_currency
            self.db.add(row)
            imported.add(day)
        self.db.commit()
        return {"imported_dates": imported, "records_stored": len(parsed)}
