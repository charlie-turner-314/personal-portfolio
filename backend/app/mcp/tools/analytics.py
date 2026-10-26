"""Analytics tools share the same permitted financial facts as API reports."""

from typing import Optional
from app.mcp.dependencies import get_db
from app.services.financial_activity import FinancialActivity, reporting_uuid, ZERO
from app.services.financial_values import net_worth, cash_reconciliation
from app.services.financial_activity_views import (
    json_numbers,
    category_breakdown,
    monthly_cashflow,
)


def get_spending_by_category(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    account_id: Optional[str] = None,
    include_uncategorized: bool = False,
    person_ids: Optional[list[str]] = None,
    scope: str = "my",
) -> list[dict]:
    """Consumption (including refunds), using dated economic shares by default.
    Household view counts each permitted record once; capital is separate.
    """
    with get_db() as db:
        summary = FinancialActivity(
            db, user_id, scope=scope, person_ids=person_ids
        ).summarize(
            from_date=from_date,
            to_date=to_date,
            account_ids=[account_id] if account_id else None,
        )
        return category_breakdown(
            summary, "consumption", include_uncategorized=include_uncategorized
        )


def get_income_by_category(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    account_id: Optional[str] = None,
    person_ids: Optional[list[str]] = None,
    scope: str = "my",
) -> list[dict]:
    """Classified income, excluding ownership/boundary transfers and capital."""
    with get_db() as db:
        summary = FinancialActivity(
            db, user_id, scope=scope, person_ids=person_ids
        ).summarize(
            from_date=from_date,
            to_date=to_date,
            account_ids=[account_id] if account_id else None,
        )
        return category_breakdown(summary, "income")


def get_monthly_cashflow(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    person_ids: Optional[list[str]] = None,
    scope: str = "my",
) -> list[dict]:
    """Monthly income minus consumption; net is saving before capital/transfers."""
    with get_db() as db:
        return monthly_cashflow(
            FinancialActivity(
                db, user_id, scope=scope, person_ids=person_ids
            ).summarize(from_date=from_date, to_date=to_date)
        )


def get_financial_summary(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    person_ids: Optional[list[str]] = None,
    scope: str = "my",
) -> dict:
    """Income/consumption, capital and boundary movements, plus current recorded
    cash/net-worth values. Period flows never manufacture a recorded balance.
    My view is the default; household/selected-people attribution is explicit.
    """
    with get_db() as db:
        activity = FinancialActivity(db, user_id, scope=scope, person_ids=person_ids)
        summary = activity.summarize(from_date=from_date, to_date=to_date)
        values = net_worth(activity)
        known = {
            "total_income": summary["income"],
            "total_expenses": summary["expenses"],
            "savings_from_income": summary["savings_from_income"],
            "net_cashflow": summary["explained_cash_flow"],
        }
        movements = {
            key: summary[key]
            for key in (
                "investments",
                "loan_principal",
                "other_capital",
                "boundary_transfers_in",
                "boundary_transfers_out",
                "ownership_transfers_in",
                "ownership_transfers_out",
                "explained_cash_flow",
            )
        }
        return json_numbers(
            {
                "period": {"from_date": from_date, "to_date": to_date},
                **values,
                "activity_scope": summary["scope"],
                "activity_accounts": summary["accounts"],
                **{
                    key: value if summary["complete"] else None
                    for key, value in known.items()
                },
                **{
                    key: value if summary["complete"] else None
                    for key, value in movements.items()
                },
                "known_activity": known | movements,
                "activity_complete": summary["complete"],
                "missing_conversions": summary["missing_conversions"],
                "savings_rate": (
                    (
                        summary["savings_from_income"] / summary["income"] * 100
                        if summary["income"] > ZERO
                        else ZERO
                    )
                    if summary["complete"]
                    else None
                ),
                "reconciliation": cash_reconciliation(
                    activity,
                    from_date=from_date,
                    to_date=to_date,
                    explained=summary["explained_cash_flow"],
                    complete=summary["complete"],
                ),
            }
        )


def get_top_merchants(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    limit: int = 10,
    category_id: Optional[str] = None,
    uncategorized: bool = False,
    person_ids: Optional[list[str]] = None,
    scope: str = "my",
) -> list[dict]:
    """Rank permitted consumption, preserving refunds and unknown conversion."""
    if category_id and uncategorized:
        raise ValueError("category_id and uncategorized are mutually exclusive")
    selected = str(reporting_uuid(category_id)) if category_id else None
    with get_db() as db:
        summary = FinancialActivity(
            db, user_id, scope=scope, person_ids=person_ids
        ).summarize(from_date=from_date, to_date=to_date)
        merchants = {}
        for entry in summary["entries"] + summary["unknown_entries"]:
            if (
                entry["kind"] != "consumption"
                or (selected and entry["category_id"] != selected)
                or (uncategorized and entry["category_id"] != "uncategorized")
            ):
                continue
            name = entry["merchant"] or entry["description"] or "Unknown merchant"
            row = merchants.setdefault(
                name,
                {"merchant": name, "total": ZERO, "known_total": ZERO, "ids": set()},
            )
            row["ids"].add(entry["id"])
            if entry["amount"] is None:
                row["total"] = None
            else:
                row["known_total"] += entry["amount"]
                if row["total"] is not None:
                    row["total"] += entry["amount"]
        return json_numbers(
            [
                {key: value for key, value in row.items() if key != "ids"}
                | {
                    "count": len(row["ids"]),
                    "currency": summary["currency"],
                    "scope": summary["scope"],
                    "accounts": summary["accounts"],
                    "complete": row["total"] is not None,
                }
                for row in sorted(
                    merchants.values(),
                    key=lambda row: (
                        row["total"] is not None,
                        -row["known_total"],
                        row["merchant"],
                    ),
                )[: min(max(1, limit), 50)]
            ]
        )
