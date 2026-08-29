"""Focused serialization coverage for the CGT audit export."""
import csv
from datetime import date
from decimal import Decimal
from io import StringIO
from types import SimpleNamespace

from app.routes.investments import _cgt_export_csv


def test_cgt_export_includes_audit_and_missing_fx_columns():
    row = SimpleNamespace(
        id="allocation-1",
        account_id="account-1",
        acquisition_trade_id="buy-1",
        disposal_trade_id="sell-1",
        symbol="BHP",
        acquisition_date=date(2024, 1, 10),
        disposal_date=date(2025, 7, 10),
        quantity=Decimal("10"),
        currency="USD",
        cost_base_native=Decimal("1000"),
        proceeds_native=Decimal("1500"),
        gain_native=Decimal("500"),
        cost_base_aud=None,
        proceeds_aud=None,
        gain_aud=None,
        fx_missing=True,
        discount_eligible=True,
        calculation_version="fifo-v1",
        assumptions=["Corporate actions are not calculated."],
    )

    csv_text = _cgt_export_csv([row])

    exported = list(csv.DictReader(StringIO(csv_text)))

    assert len(exported) == 1
    assert exported[0]["acquisition_trade_id"] == "buy-1"
    assert exported[0]["cost_base_aud"] == ""
    assert exported[0]["fx_missing"] == "true"
    assert exported[0]["discount_eligible"] == "true"
    assert exported[0]["assumptions"] == "Corporate actions are not calculated."
