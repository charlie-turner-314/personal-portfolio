"""Recorded cash and permitted net-worth values, independent of activity sums."""

from datetime import date
from decimal import Decimal
from sqlalchemy import func
from app.models import (
    AccountBalance,
    Holding,
    HoldingValuation,
    Property,
    Vehicle,
    SuperAccount,
    Transaction,
)
from app.services.balance_observations import INDEPENDENT_BALANCE_SOURCES
from app.services.financial_access import property_access, account_access
from app.services.financial_activity import FinancialActivity, ZERO, decimal
from app.services.net_worth_service import is_liability_account_type

CASH_TYPES = {"checking", "savings", "cash"}


def recorded_account_balance(
    activity: FinancialActivity, account, *, on=None, exact=False
):
    observation = on or date.today()
    share = activity.share(account, observation)
    if share == ZERO:
        return ZERO
    query = activity.db.query(AccountBalance).filter(
        AccountBalance.account_id == account.id,
        account_access(AccountBalance.account_id, activity.actor),
    )
    query = (
        query.filter(func.date(AccountBalance.date) == observation)
        if exact
        else query.filter(func.date(AccountBalance.date) <= observation)
    )
    if exact:
        query = query.filter(
            AccountBalance.balance_source.in_(INDEPENDENT_BALANCE_SOURCES),
            AccountBalance.account_currency.isnot(None),
        )
    snapshot = query.order_by(AccountBalance.date.desc()).first()
    if snapshot is not None:
        snapshot_date = snapshot.date.date()
        native_currency = snapshot.account_currency or account.currency
        full = activity.convert(
            snapshot.balance_in_account_currency, native_currency, snapshot_date
        )
        # Historical functional values may predate a currency preference change.
        # Unlabelled legacy conversions cannot supply an assumed unit.
        if full is None and snapshot.functional_currency:
            full = activity.convert(
                snapshot.balance_in_functional_currency,
                snapshot.functional_currency,
                snapshot_date,
            )
    elif on is None and not exact:
        full = activity.convert(
            account.functional_balance,
            activity.currency_for(account.user_id),
            observation,
        )
    else:
        full = None
    return full * share if full is not None else None


def account_net_worth_value(activity: FinancialActivity, account):
    today = date.today()
    share = activity.share(account, today)
    if share == ZERO:
        return ZERO
    holdings = (
        activity.db.query(Holding)
        .filter(
            Holding.account_id == account.id,
            account_access(Holding.account_id, activity.actor),
        )
        .all()
    )
    if holdings:
        full = ZERO
        for holding in holdings:
            latest = (
                activity.db.query(HoldingValuation)
                .filter(
                    HoldingValuation.holding_id == holding.id,
                    HoldingValuation.date <= today,
                )
                .order_by(HoldingValuation.date.desc())
                .first()
            )
            if latest is None:
                return None
            value = activity.convert(
                latest.value_user_currency,
                activity.currency_for(account.user_id),
                latest.date,
            )
            if value is None:
                return None
            full += value
    else:
        full = activity.convert(
            account.functional_balance, activity.currency_for(account.user_id), today
        )
        if (
            full is None
            and account.functional_balance is None
            and not activity.db.query(Transaction.id)
            .filter(Transaction.account_id == account.id)
            .first()
        ):
            full = activity.convert(account.starting_balance, account.currency, today)
    return full * share if full is not None else None


def net_worth(activity: FinancialActivity, *, account_ids=None):
    accounts = [
        account for account in activity.coverage(account_ids) if account.is_active
    ]
    excluded_super = {
        row[0]
        for row in activity.db.query(SuperAccount.account_id).filter(
            SuperAccount.account_id.in_([account.id for account in accounts]),
            SuperAccount.include_in_net_worth.is_(False),
        )
    }
    entries, missing, gross, debt = [], [], ZERO, ZERO
    cash, cash_missing = ZERO, False
    for account in accounts:
        balance = recorded_account_balance(activity, account)
        if account.account_type in CASH_TYPES:
            if balance is None:
                cash_missing = True
            else:
                cash += balance
        value = account_net_worth_value(activity, account)
        included = account.id not in excluded_super
        if included:
            if value is None:
                missing.append(str(account.id))
            elif value < ZERO or is_liability_account_type(account.account_type):
                debt += abs(value)
            else:
                gross += value
        entries.append(
            {
                "id": str(account.id),
                "name": account.name,
                "balance": balance,
                "value": value,
                "currency": activity.currency,
                "account_type": account.account_type,
                "included_in_net_worth": included,
            }
        )
    # Account filtering is intentionally an account-only net-worth boundary.
    # A linked private property must not be brought in through a mortgage.
    if not account_ids:
        resources = [
            ("property", row)
            for row in activity.db.query(Property).filter(
                property_access(Property.id, activity.actor),
                Property.is_active.is_(True),
            )
        ]
        resources += [
            ("vehicle", row)
            for row in activity.db.query(Vehicle).filter(
                Vehicle.user_id == activity.actor, Vehicle.is_active.is_(True)
            )
        ]
        for kind, resource in resources:
            share = activity.share(resource, date.today(), kind)
            full = activity.convert(
                resource.current_value,
                resource.currency or activity.currency_for(resource.user_id),
                date.today(),
            )
            value = (
                ZERO if share == ZERO else full * share if full is not None else None
            )
            if value is None:
                missing.append(str(resource.id))
            elif value < ZERO:
                debt += abs(value)
            else:
                gross += value
            entries.append(
                {
                    "id": str(resource.id),
                    "name": resource.name,
                    "value": value,
                    "currency": activity.currency,
                    "source": kind,
                }
            )
    return {
        "gross_assets": None if missing else gross,
        "total_liabilities": None if missing else debt,
        "net_worth": None if missing else gross - debt,
        "known_gross_assets": gross,
        "known_total_liabilities": debt,
        "total_balance": None if cash_missing else cash,
        "missing_values": missing,
        "accounts": [row for row in entries if "account_type" in row],
        "assets": [row for row in entries if "source" in row],
        "currency": activity.currency,
        "balance_as_of": date.today().isoformat(),
        "scope": activity.scope_label,
    }


def cash_reconciliation(
    activity: FinancialActivity,
    *,
    from_date=None,
    to_date=None,
    account_ids=None,
    explained=None,
    complete=True
):
    from datetime import timedelta
    from app.services.financial_activity import reporting_date

    start, end = reporting_date(from_date), reporting_date(to_date, end=True)
    unavailable = {
        "recorded_change": None,
        "difference": None,
        "status": "unavailable",
        "missing_accounts": 0,
    }
    if start is None or end is None:
        return unavailable | {"reason": "Exact opening and closing dates are required."}
    change, missing, count = ZERO, 0, 0
    for account in activity.coverage(account_ids):
        if not account.is_active or account.account_type not in CASH_TYPES:
            continue
        opening_day = start.date() - timedelta(days=1)
        if (
            activity.share(account, opening_day) == ZERO
            and activity.share(account, end.date()) == ZERO
        ):
            continue
        count += 1
        opening = recorded_account_balance(
            activity, account, on=opening_day, exact=True
        )
        closing = recorded_account_balance(activity, account, on=end.date(), exact=True)
        if opening is None or closing is None:
            missing += 1
        else:
            change += closing - opening
    if not count or missing:
        return unavailable | {
            "missing_accounts": missing,
            "reason": "Every included economic cash share needs an exact boundary observation.",
        }
    difference = (
        (change - explained).quantize(Decimal("0.01"))
        if complete and explained is not None
        else None
    )
    return {
        "recorded_change": change,
        "difference": difference,
        "missing_accounts": 0,
        "status": (
            "incomplete"
            if difference is None
            else "matched" if difference == ZERO else "difference"
        ),
    }
