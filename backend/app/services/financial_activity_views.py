"""Safe presentation adapters shared by analytics API and MCP tools."""

from decimal import Decimal
from app.services.financial_activity import ZERO


def json_numbers(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {key: json_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_numbers(item) for item in value]
    return value


def category_breakdown(summary, kind, *, include_uncategorized=True):
    grouped = {}
    for row in summary["categories"]:
        if row["kind"] != kind or (
            not include_uncategorized and row["id"] == "uncategorized"
        ):
            continue
        grouped[row["id"]] = {
            "category_id": None if row["id"] == "uncategorized" else row["id"],
            "category_name": row["name"],
            "category_color": row["color"],
            "total": row["amount"],
            "known_total": row["amount"],
            "_ids": set(row["transaction_ids"]),
            "_merchants": set(row["merchants"]),
        }
    for row in summary["unknown_entries"]:
        if row["kind"] != kind or (
            not include_uncategorized and row["category_id"] == "uncategorized"
        ):
            continue
        item = grouped.setdefault(
            row["category_id"],
            {
                "category_id": (
                    None
                    if row["category_id"] == "uncategorized"
                    else row["category_id"]
                ),
                "category_name": row["category_name"],
                "category_color": row["color"],
                "known_total": ZERO,
                "_ids": set(),
                "_merchants": set(),
            },
        )
        item["total"] = None
        item["_ids"].add(row["id"])
        if row["merchant"]:
            item["_merchants"].add(row["merchant"])
    return json_numbers(
        [
            {
                **{key: value for key, value in row.items() if not key.startswith("_")},
                "count": len(row["_ids"]),
                "merchant_count": len(row["_merchants"]),
                "currency": summary["currency"],
                "scope": summary["scope"],
                "accounts": summary["accounts"],
                "complete": row["total"] is not None,
            }
            for row in sorted(
                grouped.values(),
                key=lambda row: (
                    row["total"] is not None,
                    -row["known_total"],
                    str(row["category_id"]),
                ),
            )
        ]
    )


def monthly_cashflow(summary):
    months = {}
    for day in summary["daily"]:
        row = months.setdefault(day["date"][:7], {"income": ZERO, "expenses": ZERO})
        row["income"] += day["income"]
        row["expenses"] += day["expenses"]
    missing = {day[:7] for day in summary["missing_dates"]}
    for month in missing:
        months.setdefault(month, {"income": ZERO, "expenses": ZERO})
    return json_numbers(
        [
            {
                "month": month,
                "income": None if month in missing else row["income"],
                "expenses": None if month in missing else row["expenses"],
                "net": None if month in missing else row["income"] - row["expenses"],
                "currency": summary["currency"],
                "scope": summary["scope"],
                "accounts": summary["accounts"],
                "complete": month not in missing,
            }
            for month, row in sorted(months.items())
        ]
    )
