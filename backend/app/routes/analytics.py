"""Analytics endpoints use the shared financial activity and observation model."""

from typing import Optional
from datetime import datetime
from uuid import UUID
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.db_helpers import get_user_id
from app.models import Transaction
from app.services.financial_activity import FinancialActivity, ZERO, reporting_date
from app.services.financial_values import recorded_account_balance
from app.services.financial_activity_views import json_numbers, monthly_cashflow

router = APIRouter()


def selected_summary(summary, category_id=None, uncategorized=False):
    if category_id is None and not uncategorized:
        return summary
    selected = str(category_id) if category_id else "uncategorized"
    entries = [
        entry for entry in summary["entries"] if entry["category_id"] == selected
    ]
    unknown = [
        entry
        for entry in summary["unknown_entries"]
        if entry["category_id"] == selected
    ]
    daily = {}
    for entry in entries:
        if entry["kind"] not in ("income", "consumption"):
            continue
        day = daily.setdefault(
            entry["date"], {"date": entry["date"], "income": ZERO, "expenses": ZERO}
        )
        day["income" if entry["kind"] == "income" else "expenses"] += entry["amount"]
    return summary | {
        "daily": list(daily.values()),
        "entries": entries,
        "unknown_entries": unknown,
        "missing_dates": sorted({entry["date"] for entry in unknown}),
    }


@router.get("/cashflow/monthly")
def get_monthly_cashflow(
    from_date: Optional[datetime] = Query(None, alias="from"),
    to_date: Optional[datetime] = Query(None, alias="to"),
    category_id: Optional[UUID] = None,
    account_id: Optional[UUID] = None,
    uncategorized: Optional[bool] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    scope: str = "my",
    person_ids: Optional[list[UUID]] = Query(None),
):
    """Classified income versus consumption. Capital and transfers are separate.
    My view is economic share; Household view counts permitted records once.
    """
    actor = get_user_id(user_id)
    summary = FinancialActivity(
        db, actor, scope=scope, person_ids=person_ids
    ).summarize(
        from_date=from_date,
        to_date=to_date,
        account_ids=[account_id] if account_id else None,
    )
    return monthly_cashflow(selected_summary(summary, category_id, uncategorized))


def movement_sankey(summary):
    incoming, outgoing = [], []
    for category in summary["categories"]:
        amount = category["amount"]
        if not amount:
            continue
        source = category["kind"] == "income"
        if amount < ZERO:
            source = not source
        node = {
            "name": (
                category["name"]
                if amount > ZERO
                else (
                    "Refunds: "
                    if category["kind"] == "consumption"
                    else "Income reversals: "
                )
                + category["name"]
            ),
            "category_id": (
                None if category["id"] == "uncategorized" else category["id"]
            ),
            "total": abs(amount),
        }
        (incoming if source else outgoing).append(node)
    for name, key in (
        ("Investments", "investments"),
        ("Loan principal", "loan_principal"),
        ("Other capital", "other_capital"),
    ):
        amount = summary[key]
        if amount:
            (outgoing if amount > ZERO else incoming).append(
                {
                    "name": name if amount > ZERO else "Returned: " + name,
                    "total": abs(amount),
                }
            )
    if summary["transfers_in"]:
        incoming.append({"name": "Transfers in", "total": summary["transfers_in"]})
    if summary["transfers_out"]:
        outgoing.append({"name": "Transfers out", "total": summary["transfers_out"]})
    total_in = sum((node["total"] for node in incoming), ZERO)
    total_out = sum((node["total"] for node in outgoing), ZERO)
    if total_in > total_out:
        outgoing.append(
            {"name": "Calculated net inflow", "total": total_in - total_out}
        )
    if total_out > total_in:
        incoming.append(
            {"name": "Calculated net outflow", "total": total_out - total_in}
        )
    total = max(total_in, total_out)
    nodes = incoming + outgoing
    links = (
        [
            {
                "source": i,
                "target": len(incoming) + j,
                "value": left["total"] * right["total"] / total,
            }
            for i, left in enumerate(incoming)
            for j, right in enumerate(outgoing)
        ]
        if total
        else []
    )
    return json_numbers(
        {
            "nodes": nodes,
            "links": links,
            "totalIncome": summary["income"] if summary["complete"] else None,
            "totalExpenses": summary["expenses"] if summary["complete"] else None,
            "savings": summary["savings_from_income"] if summary["complete"] else None,
            "currency": summary["currency"],
            "scope": summary["scope"],
            "accounts": summary["accounts"],
            "complete": summary["complete"],
            "missing_conversions": summary["missing_conversions"],
            "explanation": "Proportional included movements; ribbons do not trace funding. Calculated net inflow/outflow is arithmetic, not a recorded cash balance change.",
        }
    )


@router.get("/sankey")
def get_sankey_data(
    from_date: Optional[datetime] = Query(None, alias="from"),
    to_date: Optional[datetime] = Query(None, alias="to"),
    account_id: Optional[UUID] = None,
    uncategorized: Optional[bool] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    scope: str = "my",
    person_ids: Optional[list[UUID]] = Query(None),
):
    actor = get_user_id(user_id)
    summary = FinancialActivity(
        db, actor, scope=scope, person_ids=person_ids
    ).summarize(
        from_date=from_date,
        to_date=to_date,
        account_ids=[account_id] if account_id else None,
    )
    if uncategorized:
        # Category filtering cannot recategorize or infer a transfer's purpose.
        from app.services.financial_activity import summarize_activity

        rows, accounts = FinancialActivity(
            db, actor, scope=scope, person_ids=person_ids
        ).rows(
            from_date=from_date,
            to_date=to_date,
            account_ids=[account_id] if account_id else None,
        )
        filtered = summarize_activity(
            [row for row in rows if row["category_id"] == "uncategorized"]
        )
        summary = filtered | {
            "currency": summary["currency"],
            "scope": summary["scope"],
            "accounts": accounts,
        }
    return movement_sankey(summary)


@router.get("/account-balances")
def get_account_balances(
    from_date: Optional[datetime] = Query(None, alias="from"),
    to_date: Optional[datetime] = Query(None, alias="to"),
    category_id: Optional[UUID] = None,
    account_id: Optional[UUID] = None,
    uncategorized: Optional[bool] = None,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    scope: str = "my",
    person_ids: Optional[list[UUID]] = Query(None),
):
    """Independent recorded balances, never back-calculated from transactions.
    Category/date filters may select account coverage; they do not turn a
    category's net movements into a bank balance. Historical gaps stay unknown.
    """
    actor = get_user_id(user_id)
    activity = FinancialActivity(db, actor, scope=scope, person_ids=person_ids)
    accounts = activity.coverage([account_id] if account_id else None)
    end = reporting_date(to_date, end=True)
    if category_id or uncategorized:
        from app.services.financial_access import account_access

        query = db.query(Transaction.account_id).filter(
            account_access(Transaction.account_id, actor)
        )
        effective = func.coalesce(
            Transaction.category_id, Transaction.category_system_id
        )
        query = (
            query.filter(effective == category_id)
            if category_id
            else query.filter(effective.is_(None))
        )
        if from_date:
            query = query.filter(Transaction.booked_at >= reporting_date(from_date))
        if end:
            query = query.filter(Transaction.booked_at <= end)
        included = {row[0] for row in query.distinct()}
        accounts = [account for account in accounts if account.id in included]
    return json_numbers(
        [
            {
                "account_id": str(account.id),
                "name": account.name,
                "balance": recorded_account_balance(
                    activity, account, on=end.date() if end else None
                ),
                "currency": activity.currency,
                "account_type": account.account_type,
                "scope": activity.scope_label,
                "balance_as_of": (
                    end.date().isoformat()
                    if end
                    else datetime.utcnow().date().isoformat()
                ),
                "observation": "recorded; historical missing values are unavailable",
            }
            for account in accounts
            if account.is_active
        ]
    )
