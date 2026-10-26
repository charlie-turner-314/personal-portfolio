"""Newsletter projections from the same permitted financial facts as reports."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session
from app.models import Report
from app.services.financial_activity import FinancialActivity, ZERO, summarize_activity
from app.services.financial_values import (
    CASH_TYPES,
    account_net_worth_value,
    recorded_account_balance,
)
from app.services.net_worth_service import is_liability_account_type
from app.services.report_horizon import horizon_start, period_label


def money(value):
    return None if value is None else format(value.quantize(Decimal("0.01")), "f")


def build_report_payload(db: Session, report: Report) -> dict:
    activity = FinancialActivity(db, report.user_id)
    covered = activity.coverage(report.account_ids)
    now = datetime.utcnow()
    rows, coverage = activity.rows(
        from_date=horizon_start(report.frequency, now),
        to_date=now,
        account_ids=report.account_ids,
    )
    summary = summarize_activity(rows)
    base_url = (
        os.environ.get("FRONTEND_URL")
        or os.environ.get("APP_URL", "http://localhost:3000")
    ).rstrip("/")
    accounts = []
    cash = ZERO
    missing_cash = False
    for account in covered:
        if not account.is_active:
            continue
        value = (
            recorded_account_balance(activity, account)
            if account.account_type in CASH_TYPES
            else account_net_worth_value(activity, account)
        )
        owed = (
            is_liability_account_type(account.account_type)
            or value is not None
            and value < ZERO
        )
        if account.account_type in CASH_TYPES:
            if value is None:
                missing_cash = True
            else:
                cash += value
        logo = account.logo
        accounts.append(
            {
                "id": str(account.id),
                "name": account.name,
                "institution": account.institution,
                "balance": money(abs(value) if owed and value is not None else value),
                "currency": activity.currency,
                "balance_label": (
                    "Balance owed"
                    if owed
                    else (
                        "Recorded balance"
                        if account.account_type in CASH_TYPES
                        else "Account value"
                    )
                ),
                "logo_url": (
                    f"{base_url}{logo.logo_url}"
                    if logo and logo.logo_url and logo.status == "found"
                    else None
                ),
            }
        )
    transactions = _transactions(report, rows, summary, activity.currency)
    coverage_note = (
        "Activity account coverage: "
        + (
            ", ".join(
                account["name"] + (" (closed)" if not account["active"] else "")
                for account in coverage
            )
            or "No permitted accounts"
        )
        + ". Other private accounts are excluded."
    )
    if missing_cash:
        coverage_note += " Some recorded cash balances are unavailable; the complete cash total is withheld."
    if summary["missing_conversions"]:
        coverage_note += " Some movement amounts await currency conversion. Unavailable amounts remain visible and cannot be ranked by value."
    return {
        "report_name": report.name,
        "generated_at": now.isoformat() + "Z",
        "period_label": period_label(report.frequency),
        "scope_label": f"My view for {(report.user.name if report.user else None) or 'the report owner'} · economic share at each transaction date. Current cash balances use active cash accounts.",
        "coverage_note": coverage_note,
        "activity_accounts": coverage,
        "total_balance": None if missing_cash else money(cash),
        "total_currency": activity.currency,
        "accounts": accounts,
        "transactions": transactions,
    }


def _transactions(report, rows, summary, currency):
    by_id = {row["id"]: row for row in rows}
    amounts = {}
    purpose = {"EXPENSE": "consumption", "INCOME": "income"}.get(
        report.transaction_direction
    )
    if purpose:
        for entry in summary["entries"] + summary["unknown_entries"]:
            if entry["kind"] != purpose:
                continue
            value = entry["amount"]
            if value is not None and purpose == "consumption":
                value = -value
            if entry["id"] not in amounts:
                amounts[entry["id"]] = ZERO
            if value is None:
                amounts[entry["id"]] = None
            elif amounts[entry["id"]] is not None:
                amounts[entry["id"]] += value
    else:
        # ALL/INFLOW/OUTFLOW list attributed bank movements, not a second
        # income or consumption query. Both permitted transfer legs may appear.
        amounts = {row["id"]: row["transfer_amount"] for row in rows}
    items = []
    for identifier, amount in amounts.items():
        row = by_id[identifier]
        if amount == ZERO:
            continue
        direction = (
            "out"
            if (amount if amount is not None else row["native_amount"]) < ZERO
            else "in"
        )
        if report.transaction_direction == "INFLOW" and direction != "in":
            continue
        if report.transaction_direction == "OUTFLOW" and direction != "out":
            continue
        items.append(
            {
                "id": identifier,
                "description": row["merchant"] or row["description"] or "Transaction",
                "date": row["date"],
                "amount": money(abs(amount)) if amount is not None else None,
                "currency": currency,
                "direction": direction,
                "original_amount": money(row["native_amount"]),
                "original_currency": row["native_currency"],
                "amount_label": (
                    "Consumption allocation"
                    if purpose == "consumption"
                    else (
                        "Income allocation"
                        if purpose == "income"
                        else "Attributed bank movement"
                    )
                ),
                "_signed": amount,
                "_booked_at": row["booked_at"],
            }
        )
    if report.transaction_mode == "RECENT":
        items.sort(key=lambda row: (row["_booked_at"], row["id"]), reverse=True)
    else:
        items.sort(
            key=lambda row: (
                row["_signed"] is not None,
                -abs(row["_signed"] or ZERO),
                row["id"],
            )
        )
    direction_word = {
        "ALL": "transactions",
        "EXPENSE": "consumption allocations",
        "INCOME": "income allocations",
        "INFLOW": "inflows",
        "OUTFLOW": "outflows",
    }.get(report.transaction_direction, "transactions")
    mode_label = (
        f"Last {report.transaction_count} transactions"
        if report.transaction_mode == "RECENT"
        else f"Top {report.transaction_count} {direction_word}"
    )
    return {
        "mode_label": mode_label,
        "items": [
            {key: value for key, value in row.items() if not key.startswith("_")}
            for row in items[: report.transaction_count]
        ],
    }


def report_snapshot_fingerprint(payload):
    # Generation time is informational. Every financial value, included record,
    # permission boundary and display projection participates in the comparison.
    relevant = {
        key: value
        for key, value in payload.items()
        if key not in ("generated_at", "manage_url")
    }
    return hashlib.sha256(
        json.dumps(
            relevant, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


def assert_report_snapshot_current(db, report, payload):
    fresh = build_report_payload(db, report)
    if report_snapshot_fingerprint(fresh) != report_snapshot_fingerprint(payload):
        raise RuntimeError(
            "Report data or access changed during rendering. Refresh and retry the report."
        )
