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

from sqlalchemy.orm import Session, joinedload

from app.models import (
    Account,
    CgtAllocation,
    InvestmentCryptoTransfer,
    InvestmentCostBaseAdjustment,
    InvestmentIncomeEvent,
    Transaction,
    TransactionLink,
)


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


def _absolute_sum_by_currency(rows: Iterable[dict], field: str) -> list[dict]:
    """Sum recorded amounts as positive income/expense magnitudes by currency."""
    normalized = []
    for row in rows:
        normalized.append({**row, field: _number(abs(Decimal(row.get(field) or "0")))})
    return _sum_by_currency(normalized, field)


def _expense_categories(rows: Iterable[dict]) -> list[dict]:
    """Group recorded expense rows without inferring deductible tax treatment."""
    groups: dict[tuple[str, str], dict] = {}
    for row in rows:
        if row["transaction_type"] != "debit":
            continue
        name = row["category_name"] or "Uncategorized"
        key = (name, row["currency"])
        group = groups.setdefault(key, {"category_name": name, "currency": row["currency"], "amount": Decimal("0"), "source_ids": []})
        group["amount"] += abs(Decimal(row["amount"] or "0"))
        group["source_ids"].append(row["source_id"])
    return [
        {**group, "amount": _number(group["amount"])}
        for _, group in sorted(groups.items())
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
        "franked_amount": _number(event.franked_amount), "unfranked_amount": _number(event.unfranked_amount),
        "foreign_income": _number(event.foreign_income or Decimal("0")),
        "foreign_tax_paid": _number(event.foreign_tax_paid or Decimal("0")),
        "tfn_withholding": _number(event.tfn_withholding or Decimal("0")),
        "amit_amma_components": event.amit_amma_components,
        "source_reference": event.source_id, "annual_statement_reference": event.annual_statement_reference,
        "is_drp": bool(event.is_drp), "reconciliation_status": event.reconciliation_status,
        "matched_transaction_id": str(event.matched_transaction_id) if event.matched_transaction_id else None,
        "component_sources": event.component_sources or {},
        "asset_quantity": _number(getattr(event, "asset_quantity", None)),
        "aud_market_value": _number(getattr(event, "aud_market_value", None)),
        "valuation_source": getattr(event, "valuation_source", None),
        "valuation_timestamp": (
            event.valuation_timestamp.isoformat()
            if getattr(event, "valuation_timestamp", None) else None
        ),
        "valuation_missing": bool(getattr(event, "valuation_missing", False)),
    } for event in income_events]

    def is_crypto_income(row: dict) -> bool:
        return row["event_type"] in {"staking_reward", "airdrop"} or (
            row["event_type"] == "interest" and row["asset_quantity"] is not None
        )

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
        "cost_base_native": _number(row.cost_base_native), "proceeds_native": _number(row.proceeds_native),
        "cost_base_adjustment_native": _number(row.cost_base_adjustment_native),
        "gain_aud": _number(row.gain_aud), "fx_missing": bool(row.fx_missing),
        "cost_base_aud": _number(row.cost_base_aud), "proceeds_aud": _number(row.proceeds_aud),
        "cost_base_adjustment_aud": _number(row.cost_base_adjustment_aud),
        "adjustment_ids": row.adjustment_ids or [], "instrument_type": row.instrument_type,
        "acquisition_valuation_source": getattr(row, "acquisition_valuation_source", None),
        "disposal_valuation_source": getattr(row, "disposal_valuation_source", None),
        "acquisition_valuation_timestamp": (
            row.acquisition_valuation_timestamp.isoformat()
            if getattr(row, "acquisition_valuation_timestamp", None) else None
        ),
        "disposal_valuation_timestamp": (
            row.disposal_valuation_timestamp.isoformat()
            if getattr(row, "disposal_valuation_timestamp", None) else None
        ),
        "acquisition_economic_type": getattr(row, "acquisition_economic_type", "trade"),
        "disposal_economic_type": getattr(row, "disposal_economic_type", "trade"),
        "discount_eligible": bool(row.discount_eligible), "calculation_version": row.calculation_version,
        "assumptions": row.assumptions or [],
    } for row in cgt_events]

    cost_base_adjustments = (
        db.query(InvestmentCostBaseAdjustment)
        .join(Account, Account.id == InvestmentCostBaseAdjustment.account_id)
        .filter(
            Account.user_id == user_id,
            InvestmentCostBaseAdjustment.effective_date >= start.date(),
            InvestmentCostBaseAdjustment.effective_date < end.date(),
        )
        .order_by(
            InvestmentCostBaseAdjustment.effective_date,
            InvestmentCostBaseAdjustment.id,
        )
        .all()
    )
    cost_base_rows = [{
        "source_id": str(row.id),
        "source_activity_id": str(row.source_activity_id),
        "income_event_id": str(row.income_event_id) if row.income_event_id else None,
        "account_id": str(row.account_id),
        "holding_id": str(row.holding_id),
        "effective_date": row.effective_date.isoformat(),
        "currency": row.currency,
        "amount_native": _number(row.amount_native),
        "amount_aud": _number(row.amount_aud),
        "valuation_source": row.valuation_source,
        "calculation_version": row.calculation_version,
        "assumptions": row.assumptions or [],
    } for row in cost_base_adjustments]

    crypto_transfers = (
        db.query(InvestmentCryptoTransfer)
        .filter(
            InvestmentCryptoTransfer.user_id == user_id,
            InvestmentCryptoTransfer.occurred_at >= start,
            InvestmentCryptoTransfer.occurred_at < end,
        )
        .order_by(InvestmentCryptoTransfer.occurred_at, InvestmentCryptoTransfer.id)
        .all()
    )
    crypto_transfer_rows = [{
        "source_id": str(row.id),
        "source_activity_id": str(row.source_activity_id),
        "account_id": str(row.account_id),
        "matched_transfer_id": str(row.matched_transfer_id) if row.matched_transfer_id else None,
        "direction": row.direction,
        "asset_symbol": row.asset_symbol,
        "quantity": _number(row.quantity),
        "occurred_at": row.occurred_at.isoformat(),
        "transaction_hash": row.transaction_hash,
        "status": row.status,
        "match_method": row.match_method,
        "reason": row.reason,
        "assumptions": row.assumptions or [],
    } for row in crypto_transfers]

    # TransactionLink membership is excluded as the data model does not say which
    # linked cash amount should survive a reimbursement.  The source is counted
    # as excluded instead of guessing.
    linked_ids = {
        transaction_id for (transaction_id,) in db.query(TransactionLink.transaction_id)
        .filter(TransactionLink.user_id == user_id).all()
    }
    matched_income_transaction_ids = {
        event.matched_transaction_id for event in income_events if event.matched_transaction_id
    }
    transactions = (
        db.query(Transaction)
        .options(joinedload(Transaction.property))
        .filter(Transaction.user_id == user_id, Transaction.booked_at >= start, Transaction.booked_at < end)
        .order_by(Transaction.booked_at, Transaction.id).all()
    )
    transaction_rows, excluded = [], []
    for transaction in transactions:
        if transaction.internal_transfer_id is not None:
            excluded.append({"source_id": str(transaction.id), "reason": "internal_transfer"})
            continue
        if transaction.id in matched_income_transaction_ids:
            excluded.append({"source_id": str(transaction.id), "reason": "investment_income_match"})
            continue
        if not transaction.include_in_analytics:
            excluded.append({"source_id": str(transaction.id), "reason": "analytics_excluded"})
            continue
        if transaction.id in linked_ids:
            excluded.append({"source_id": str(transaction.id), "reason": "reimbursement_link"})
            continue
        category = transaction.category or transaction.category_system
        is_rental = bool(transaction.property and transaction.property.is_rental)
        transaction_rows.append({
            "source_id": str(transaction.id), "account_id": str(transaction.account_id),
            "booked_at": transaction.booked_at.isoformat(), "transaction_type": transaction.transaction_type,
            "amount": _number(transaction.amount), "functional_amount": _number(transaction.functional_amount),
            "currency": transaction.currency, "category_id": str(category.id) if category else None,
            "category_name": category.name if category else None,
            "category_type": category.category_type if category else None,
            "property_id": str(transaction.property_id) if transaction.property_id else None,
            "tax_treatment": "unclassified", "interest_treatment": "unavailable",
            "rental_treatment": "recorded_property_cashflow" if is_rental else ("unavailable" if transaction.property_id else "not_property_linked"),
            "is_rental_property": is_rental,
        })

    cgt_known = [row for row in cgt_rows if not row["fx_missing"] and row["gain_aud"] is not None]
    gains = sum((max(Decimal(row["gain_aud"]), Decimal("0")) for row in cgt_known), Decimal("0"))
    losses = sum((max(-Decimal(row["gain_aud"]), Decimal("0")) for row in cgt_known), Decimal("0"))
    rental_rows = [row for row in transaction_rows if row["is_rental_property"]]
    rental_income_rows = [row for row in rental_rows if row["transaction_type"] == "credit"]
    rental_expense_rows = [row for row in rental_rows if row["transaction_type"] == "debit"]
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
            "tfn_withholding_by_currency": _sum_by_currency(income_rows, "tfn_withholding"),
            "unreconciled_source_ids": [
                row["source_id"] for row in income_rows
                if row["reconciliation_status"] != "confirmed"
            ],
            "crypto_ordinary_income_aud": _number(sum(
                (
                    Decimal(row["aud_market_value"])
                    for row in income_rows
                    if is_crypto_income(row)
                    and row["aud_market_value"] is not None
                ),
                Decimal("0"),
            )),
            "crypto_ordinary_income_source_ids": [
                row["source_id"] for row in income_rows
                if is_crypto_income(row)
                and row["aud_market_value"] is not None
            ],
            "crypto_missing_valuation_source_ids": [
                row["source_id"] for row in income_rows
                if is_crypto_income(row)
                and row["valuation_missing"]
            ],
        },
        "cgt": {"rows": cgt_rows, "gross_gains_aud": _number(gains), "capital_losses_aud": _number(losses),
                "gross_gain_source_ids": [row["source_id"] for row in cgt_known if Decimal(row["gain_aud"]) > 0],
                "capital_loss_source_ids": [row["source_id"] for row in cgt_known if Decimal(row["gain_aud"]) < 0],
                "missing_fx_source_ids": [row["source_id"] for row in cgt_rows if row["fx_missing"]],
                "cost_base_adjustments": cost_base_rows,
                "cost_base_adjustment_total_aud": _number(sum(
                    (Decimal(row["amount_aud"]) for row in cost_base_rows if row["amount_aud"] is not None),
                    Decimal("0"),
                )),
                "cost_base_adjustment_missing_fx_source_ids": [
                    row["source_id"] for row in cost_base_rows if row["amount_aud"] is None
                ]},
        "transactions": {"rows": transaction_rows, "excluded_rows": excluded,
                         "cashflow_by_currency": _sum_by_currency(transaction_rows, "amount"),
                         "expense_by_currency": _absolute_sum_by_currency((row for row in transaction_rows if row["transaction_type"] == "debit"), "amount"),
                         "income_by_currency": _absolute_sum_by_currency((row for row in transaction_rows if row["transaction_type"] == "credit"), "amount"),
                         "expense_categories": _expense_categories(transaction_rows),
                         "rental_income_by_currency": _absolute_sum_by_currency(rental_income_rows, "amount"),
                         "rental_expense_by_currency": _absolute_sum_by_currency(rental_expense_rows, "amount")},
        "crypto_transfers": {
            "rows": crypto_transfer_rows,
            "unresolved_source_ids": [
                row["source_id"] for row in crypto_transfer_rows
                if row["status"] in {"pending", "ambiguous"}
            ],
        },
        "assumptions": [
            "Informational report only; it does not calculate tax payable, deductions, offsets, or taxable income.",
            "Transaction categories are labels only. Deductibility and interest treatment are unclassified or unavailable unless separately modelled. Rental rows are recorded cashflow for properties marked as rental; allocation, ownership, depreciation, and private-use treatment are not calculated.",
            "Transfers, analytics-excluded transactions, and reimbursement-linked transactions are excluded by default.",
            "CGT rows with missing transaction-date FX are excluded from AUD gain/loss totals.",
            "Recorded AMIT/AMMA shortfalls increase cost base and excesses decrease it on their recorded effective dates.",
            "Bank transactions linked to investment-income events are excluded from transaction cashflow totals to avoid duplicate economic income.",
            "Matched owned-wallet crypto transfers preserve lot basis and are excluded from CGT; crypto paid as a network fee remains a disposal.",
            "Staking, airdrop, and crypto-interest ordinary income uses receipt-time AUD market value only when provenance is recorded.",
            "Imported airdrop rows are treated as ordinary-income airdrops; other airdrop circumstances can require different tax treatment and should be reviewed.",
        ],
    }


_DICTIONARY = [
    ("source_id", "Primary source record ID for audit traceability."),
    ("source_reference", "Statement/import-provided reference where available."),
    ("tax_treatment", "Always unclassified unless a dedicated tax treatment is modelled."),
    ("interest_treatment", "Unavailable: no canonical interest classification is inferred."),
    ("rental_treatment", "Unavailable for property-linked records; no rental allocation is inferred."),
    ("fx_missing", "True when CGT transaction-date AUD conversion is incomplete."),
    ("reconciliation_status", "Whether cash activity has been confirmed by a final statement or needs review."),
    ("component_sources", "Immutable activity references that supplied each recorded income component."),
    ("cost_base_adjustment_native", "Signed AMIT/AMMA adjustment included in the allocation cost base."),
    ("adjustment_ids", "Cost-base adjustment records included in the allocation."),
    ("economic_type", "Derived crypto leg type, distinguishing swaps, rewards, fees, and owned transfers."),
    ("valuation_missing", "True when event-time AUD market value is absent; tax totals do not infer a value."),
    ("crypto_transfer_status", "Matched owned transfers carry basis; pending or ambiguous movements require review."),
]


def tax_report_zip(report: dict) -> bytes:
    """Serialize report sections and their source fields as a portable audit ZIP."""
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name, rows in (("investment_income", report["investment_income"]["rows"]),
                           ("cgt_allocations", report["cgt"]["rows"]),
                           ("cost_base_adjustments", report["cgt"].get("cost_base_adjustments", [])),
                           ("crypto_transfers", report.get("crypto_transfers", {}).get("rows", [])),
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
