"""Australian financial-year tax-report data and audit export.

This service deliberately reports recorded facts.  It does not turn category
names into tax advice or infer deductible, interest, or rental treatment.
"""
from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO, StringIO
from typing import Iterable
from zipfile import ZIP_DEFLATED, ZipFile

from sqlalchemy.orm import Session

from app.models import Account, CgtAllocation, InvestmentIncomeEvent, Transaction, TransactionLink


def financial_year_bounds(year: int) -> tuple[datetime, datetime]:
    return datetime(year, 7, 1), datetime(year + 1, 7, 1)


def _number(value: Decimal | None) -> str | None:
    return None if value is None else format(Decimal(value), "f")


def _sum_by_currency(rows: Iterable[dict], field: str) -> list[dict]:
    totals: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    source_ids: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        totals[row["currency"]] += Decimal(row.get(field) or "0")
        source_ids[row["currency"]].append(row["source_id"])
    return [
        {"currency": currency, "amount": _number(amount), "source_ids": source_ids[currency]}
        for currency, amount in sorted(totals.items())
    ]


def build_australian_tax_report(db: Session, user_id: str, financial_year_start: int) -> dict:
    """Build an auditable FY pack from recorded source events and transactions."""
    start, end = financial_year_bounds(financial_year_start)
    income_events = (
        db.query(InvestmentIncomeEvent)
        .filter(InvestmentIncomeEvent.user_id == user_id,
                InvestmentIncomeEvent.pay_date >= start.date(),
                InvestmentIncomeEvent.pay_date < end.date())
        .order_by(InvestmentIncomeEvent.pay_date, InvestmentIncomeEvent.id)
        .all()
    )
    income_rows = [{
        "source_id": str(event.id), "account_id": str(event.account_id), "holding_id": str(event.holding_id),
        "event_type": event.event_type, "pay_date": event.pay_date.isoformat(), "currency": event.currency,
        "cash_income": _number(event.cash_received), "franking_credits": _number(event.franking_credit or Decimal("0")),
        "foreign_income": _number(event.foreign_income or Decimal("0")),
        "foreign_tax_paid": _number(event.foreign_tax_paid or Decimal("0")),
        "source_reference": event.source_id, "is_drp": bool(event.is_drp),
    } for event in income_events]

    cgt_events = (
        db.query(CgtAllocation)
        .join(Account, Account.id == CgtAllocation.account_id)
        .filter(Account.user_id == user_id, CgtAllocation.disposal_date >= start.date(), CgtAllocation.disposal_date < end.date())
        .order_by(CgtAllocation.disposal_date, CgtAllocation.id)
        .all()
    )
    cgt_rows = [{
        "source_id": str(row.id), "account_id": str(row.account_id), "acquisition_trade_id": str(row.acquisition_trade_id),
        "disposal_trade_id": str(row.disposal_trade_id), "symbol": row.symbol,
        "acquisition_date": row.acquisition_date.isoformat(), "disposal_date": row.disposal_date.isoformat(),
        "currency": row.currency, "quantity": _number(row.quantity), "gain_native": _number(row.gain_native),
        "gain_aud": _number(row.gain_aud), "fx_missing": bool(row.fx_missing),
        "discount_eligible": bool(row.discount_eligible), "calculation_version": row.calculation_version,
        "assumptions": row.assumptions or [],
    } for row in cgt_events]

    # TransactionLink membership is excluded as the data model does not say which
    # linked cash amount should survive a reimbursement.  The source is counted
    # as excluded instead of guessing.
    linked_ids = {
        transaction_id for (transaction_id,) in db.query(TransactionLink.transaction_id)
        .filter(TransactionLink.user_id == user_id).all()
    }
    transactions = (
        db.query(Transaction)
        .filter(Transaction.user_id == user_id, Transaction.booked_at >= start, Transaction.booked_at < end)
        .order_by(Transaction.booked_at, Transaction.id).all()
    )
    transaction_rows, excluded = [], []
    for transaction in transactions:
        if transaction.internal_transfer_id is not None:
            excluded.append({"source_id": str(transaction.id), "reason": "internal_transfer"})
            continue
        if not transaction.include_in_analytics:
            excluded.append({"source_id": str(transaction.id), "reason": "analytics_excluded"})
            continue
        if transaction.id in linked_ids:
            excluded.append({"source_id": str(transaction.id), "reason": "reimbursement_link"})
            continue
        category = transaction.category or transaction.category_system
        transaction_rows.append({
            "source_id": str(transaction.id), "account_id": str(transaction.account_id),
            "booked_at": transaction.booked_at.isoformat(), "transaction_type": transaction.transaction_type,
            "amount": _number(transaction.amount), "functional_amount": _number(transaction.functional_amount),
            "currency": transaction.currency, "category_id": str(category.id) if category else None,
            "category_name": category.name if category else None,
            "category_type": category.category_type if category else None,
            "property_id": str(transaction.property_id) if transaction.property_id else None,
            "tax_treatment": "unclassified", "interest_treatment": "unavailable",
            "rental_treatment": "unavailable" if transaction.property_id else "not_property_linked",
        })

    cgt_known = [row for row in cgt_rows if not row["fx_missing"] and row["gain_aud"] is not None]
    gains = sum((max(Decimal(row["gain_aud"]), Decimal("0")) for row in cgt_known), Decimal("0"))
    losses = sum((max(-Decimal(row["gain_aud"]), Decimal("0")) for row in cgt_known), Decimal("0"))
    return {
        "financial_year_start": financial_year_start,
        "financial_year_end": financial_year_start + 1,
        "period": {"start": start.date().isoformat(), "end_exclusive": end.date().isoformat()},
        "investment_income": {
            "rows": income_rows,
            "cash_income_by_currency": _sum_by_currency(income_rows, "cash_income"),
            "franking_credits_by_currency": _sum_by_currency(income_rows, "franking_credits"),
            "foreign_income_by_currency": _sum_by_currency(income_rows, "foreign_income"),
            "foreign_tax_paid_by_currency": _sum_by_currency(income_rows, "foreign_tax_paid"),
        },
        "cgt": {"rows": cgt_rows, "gross_gains_aud": _number(gains), "capital_losses_aud": _number(losses),
                "gross_gain_source_ids": [row["source_id"] for row in cgt_known if Decimal(row["gain_aud"]) > 0],
                "capital_loss_source_ids": [row["source_id"] for row in cgt_known if Decimal(row["gain_aud"]) < 0],
                "missing_fx_source_ids": [row["source_id"] for row in cgt_rows if row["fx_missing"]]},
        "transactions": {"rows": transaction_rows, "excluded_rows": excluded,
                         "cashflow_by_currency": _sum_by_currency(transaction_rows, "amount"),
                         "expense_by_currency": _sum_by_currency((row for row in transaction_rows if row["transaction_type"] == "debit"), "amount"),
                         "income_by_currency": _sum_by_currency((row for row in transaction_rows if row["transaction_type"] == "credit"), "amount")},
        "assumptions": [
            "Informational report only; it does not calculate tax payable, deductions, offsets, or taxable income.",
            "Transaction categories are labels only. Deductibility, interest, rental allocation, ownership, depreciation, and private-use treatment are unclassified or unavailable unless separately modelled.",
            "Transfers, analytics-excluded transactions, and reimbursement-linked transactions are excluded by default.",
            "CGT rows with missing transaction-date FX are excluded from AUD gain/loss totals.",
        ],
    }


_DICTIONARY = [
    ("source_id", "Primary source record ID for audit traceability."),
    ("source_reference", "Statement/import-provided reference where available."),
    ("tax_treatment", "Always unclassified unless a dedicated tax treatment is modelled."),
    ("interest_treatment", "Unavailable: no canonical interest classification is inferred."),
    ("rental_treatment", "Unavailable for property-linked records; no rental allocation is inferred."),
    ("fx_missing", "True when CGT transaction-date AUD conversion is incomplete."),
]


def tax_report_zip(report: dict) -> bytes:
    """Serialize report sections and their source fields as a portable audit ZIP."""
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name, rows in (("investment_income", report["investment_income"]["rows"]),
                           ("cgt_allocations", report["cgt"]["rows"]),
                           ("transactions", report["transactions"]["rows"]),
                           ("excluded_transactions", report["transactions"]["excluded_rows"])):
            fields = sorted({key for row in rows for key in row}) or ["source_id"]
            text = StringIO(newline="")
            writer = csv.DictWriter(text, fieldnames=fields)
            writer.writeheader()
            for row in rows:
                writer.writerow({key: json.dumps(value) if isinstance(value, (list, dict)) else value for key, value in row.items()})
            archive.writestr(f"{name}.csv", text.getvalue())
        dictionary = StringIO(newline="")
        writer = csv.writer(dictionary)
        writer.writerow(["field", "meaning"])
        writer.writerows(_DICTIONARY)
        archive.writestr("data_dictionary.csv", dictionary.getvalue())
        archive.writestr("summary.json", json.dumps(report, default=str, indent=2))
    return output.getvalue()
