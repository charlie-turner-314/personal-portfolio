"""Focused Australian FY report boundary, exclusion, and total coverage."""
from datetime import datetime
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
    db = _Db([[], [], [("reimbursed",)], [retained_income, retained_expense, transfer, reimbursed]])

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
