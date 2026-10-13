"""Focused Australian FY report boundary, exclusion, and total coverage."""
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

from app.services.tax_report_service import (
    build_australian_tax_report,
    financial_year_bounds,
    tax_report_zip,
)


class _Query:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *args):
        return self

    def join(self, *args):
        return self

    def options(self, *args):
        return self

    def order_by(self, *args):
        return self

    def all(self):
        return self.rows


class _Db:
    def __init__(self, query_rows):
        self.query_rows = iter(query_rows)

    def query(self, *args):
        return _Query(next(self.query_rows))


def _transaction(id, amount, transaction_type, *, rental=False, excluded=False, linked=False):
    return SimpleNamespace(
        id=id,
        account_id="account-1",
        booked_at=datetime(2025, 7, 1),
        transaction_type=transaction_type,
        amount=Decimal(amount),
        functional_amount=None,
        currency="AUD",
        category=SimpleNamespace(id="category-1", name="Rates", category_type="expense"),
        category_system=None,
        property_id="property-1" if rental else None,
        property=SimpleNamespace(is_rental=True) if rental else None,
        internal_transfer_id="transfer-1" if excluded else None,
        include_in_analytics=True,
    )


def test_financial_year_bounds_include_july_1_and_exclude_next_july_1():
    start, end = financial_year_bounds(2025)

    assert start == datetime(2025, 7, 1)
    assert end == datetime(2026, 7, 1)
    assert start <= datetime(2025, 7, 1) < end
    assert not start <= datetime(2026, 7, 1) < end


def test_report_excludes_transfers_and_reimbursements_and_groups_recorded_totals():
    retained_income = _transaction("rent-income", "1200", "credit", rental=True)
    retained_expense = _transaction("rent-expense", "-250", "debit", rental=True)
    transfer = _transaction("transfer", "500", "credit", excluded=True)
    reimbursed = _transaction("reimbursed", "-40", "debit")
    db = _Db([[], [], [], [], [("reimbursed",)], [retained_income, retained_expense, transfer, reimbursed]])

    report = build_australian_tax_report(db, "user-1", 2025)

    transactions = report["transactions"]
    assert [row["source_id"] for row in transactions["rows"]] == ["rent-income", "rent-expense"]
    assert {row["reason"] for row in transactions["excluded_rows"]} == {"internal_transfer", "reimbursement_link"}
    assert transactions["cashflow_by_currency"] == [{"currency": "AUD", "amount": "950", "source_ids": ["rent-income", "rent-expense"]}]
    assert transactions["rental_income_by_currency"][0]["amount"] == "1200"
    assert transactions["rental_expense_by_currency"][0]["amount"] == "250"
    assert transactions["expense_categories"][0]["category_name"] == "Rates"


def test_csv_pack_contains_data_dictionary_and_source_csvs():
    archive = ZipFile(BytesIO(tax_report_zip({
        "investment_income": {"rows": []}, "cgt": {"rows": []},
        "transactions": {"rows": [], "excluded_rows": []},
    })))

    assert {"investment_income.csv", "cgt_allocations.csv", "transactions.csv", "excluded_transactions.csv", "data_dictionary.csv"} <= set(archive.namelist())
    assert "tax_treatment" in archive.read("data_dictionary.csv").decode()


def test_report_exposes_statement_components_adjustments_and_excludes_matched_cash():
    cash = _transaction("cash-credit", "50", "credit")
    income = SimpleNamespace(
        id="income-1", account_id="investment-1", holding_id="holding-1",
        event_type="distribution", pay_date=date(2025, 6, 30), currency="AUD",
        cash_received=Decimal("50"), franked_amount=Decimal("30"),
        unfranked_amount=Decimal("20"), franking_credit=Decimal("12.86"),
        foreign_income=Decimal("4"), foreign_tax_paid=Decimal("0.60"),
        tfn_withholding=Decimal("1.25"),
        amit_amma_components={"capital_gains_discounted": "8"},
        source_id="cash-source", annual_statement_reference="AMMA-2025",
        is_drp=False, reconciliation_status="confirmed",
        matched_transaction_id="cash-credit", component_sources={"franking_credit": [{"kind": "annual_statement"}]},
    )
    adjustment = SimpleNamespace(
        id="adjustment-1", source_activity_id="activity-1", income_event_id="income-1",
        account_id="investment-1", holding_id="holding-1", effective_date=date(2025, 6, 30),
        currency="AUD", amount_native=Decimal("100"), amount_aud=Decimal("100"),
        valuation_source="identity", calculation_version="amit-v1", assumptions=["recorded"],
    )
    db = _Db([[income], [], [adjustment], [], [], [cash]])

    report = build_australian_tax_report(db, "user-1", 2024)

    row = report["investment_income"]["rows"][0]
    assert row["franked_amount"] == "30"
    assert row["tfn_withholding"] == "1.25"
    assert row["amit_amma_components"] == {"capital_gains_discounted": "8"}
    assert report["investment_income"]["tfn_withholding_by_currency"][0]["amount"] == "1.25"
    assert report["cgt"]["cost_base_adjustments"][0]["amount_native"] == "100"
    assert report["cgt"]["cost_base_adjustment_total_aud"] == "100"
    assert report["transactions"]["rows"] == []
    assert report["transactions"]["excluded_rows"] == [
        {"source_id": "cash-credit", "reason": "investment_income_match"}
    ]
