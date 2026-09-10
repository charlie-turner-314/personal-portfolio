from decimal import Decimal
import uuid

import pytest

from app.models import (
    Account,
    BrokerTrade,
    Holding,
    InvestmentActivity,
    InvestmentIncomeEvent,
    InvestmentIngestionRun,
    InvestmentSourceRecord,
    User,
)
from app.services import investment_activity_service
from app.services.investment_activity_service import ActivityApplicationError, revert_run
from app.services.investment_csv_import_service import (
    apply_investment_csv,
    parse_investment_csv,
    preview_investment_csv,
)


MAPPING = {
    "occurred_at": "Date",
    "activity_type": "Type",
    "asset_symbol": "Symbol",
    "asset_type": "Asset type",
    "quantity": "Quantity",
    "price": "Price",
    "gross_amount": "Gross",
    "net_amount": "Net",
    "currency": "Currency",
    "fee_amount": "Fee",
    "fee_currency": "Fee currency",
    "tax_amount": "Tax",
    "tax_currency": "Tax currency",
    "source_reference": "Reference",
}


@pytest.fixture
def investment_account(db_session):
    user = User(
        id=f"csv-investment-{uuid.uuid4()}",
        email=f"{uuid.uuid4()}@csv-investment.test",
        functional_currency="AUD",
    )
    account = Account(
        user_id=user.id,
        name="CSV Investments",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    db_session.add_all([user, account])
    db_session.commit()
    yield user, account
    db_session.rollback()
    db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).delete()
    db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).delete()
    db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.account_id == account.id).delete()
    db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).delete()
    db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).delete()
    db_session.query(Holding).filter(Holding.account_id == account.id).delete()
    db_session.delete(account)
    db_session.delete(user)
    db_session.commit()


def _content() -> str:
    return """Reference,Date,Type,Symbol,Asset type,Quantity,Price,Gross,Net,Currency,Fee,Fee currency,Tax,Tax currency
buy-1,2025-01-02,Purchase,VAS,shares,10,100,,,AUD,9.50,AUD,,
sell-1,2025-02-03,Sale,VAS,equity,2,110,,,AUD,5,AUD,,
income-1,2025-02-20,Dividend,VAS,equity,,,20,18,AUD,,,2,AUD
fee-1,2025-02-21,Fee,AUD,cash,,,,,AUD,3.25,AUD,,
"""


def _options(content: str | None = None) -> dict:
    return {
        "file_name": "statement.csv",
        "file_content": content or _content(),
        "provider": "Generic Broker",
        "mapping": MAPPING,
        "date_format": "AUTO",
        "amount_format": "DOT_DECIMAL",
        "default_asset_type": "equity",
        "default_currency": "AUD",
    }


def test_parser_normalizes_trades_income_fees_and_mixed_currencies():
    content = """Reference;Date;Type;Symbol;Asset type;Quantity;Price;Gross;Net;Currency;Fee;Fee currency;Tax;Tax currency
b1;31/01/2025;Buy;VAS;ETF;10;100,50;;;AUD;9,50;AUD;;
d1;01/02/2025;Distribution;VGS;fund;;;25,75;20,00;USD;;;5,75;USD
f1;02/02/2025;Commission;USD;cash;;;;;USD;2,25;USD;;
"""
    parsed = parse_investment_csv(**{
        **_options(content),
        "date_format": "DD-MM-YYYY",
        "amount_format": "COMMA_DECIMAL",
    })

    assert len(parsed.batch.records) == 3
    buy = parsed.batch.records[0].activities[0]
    distribution = parsed.batch.records[1].activities[0]
    fee = parsed.batch.records[2].activities[0]
    assert (buy.activity_type, buy.asset_type, buy.price, buy.fee_amount) == (
        "buy", "fund", Decimal("100.50"), Decimal("9.50")
    )
    assert (distribution.activity_type, distribution.currency, distribution.tax_amount) == (
        "distribution", "USD", Decimal("5.75")
    )
    assert fee.activity_type == "fee" and fee.fee_amount == Decimal("2.25")


def test_parser_preserves_crypto_market_value_and_fee_provenance():
    content = """Reference,Timestamp,Type,Symbol,Asset type,Quantity,Counter asset,Counter quantity,AUD value,Value source,Value timestamp,Fee,Fee currency,Fee AUD,Fee source,Fee timestamp,Transaction hash
swap-1,2025-01-31 10:15:00,Swap,BTC,crypto,1,ETH,10,15000,execution_report,2025-01-31 10:15:00,0.001,BTC,15,execution_report,2025-01-31 10:15:00,chain-1
reward-1,2025-02-01 11:00:00,Staking reward,ETH,crypto,0.2,,,,,,,,,,,
"""
    mapping = {
        "source_reference": "Reference",
        "occurred_at": "Timestamp",
        "activity_type": "Type",
        "asset_symbol": "Symbol",
        "asset_type": "Asset type",
        "quantity": "Quantity",
        "counter_asset_symbol": "Counter asset",
        "counter_quantity": "Counter quantity",
        "aud_value": "AUD value",
        "valuation_source": "Value source",
        "valuation_timestamp": "Value timestamp",
        "fee_amount": "Fee",
        "fee_currency": "Fee currency",
        "fee_aud_value": "Fee AUD",
        "fee_valuation_source": "Fee source",
        "fee_valuation_timestamp": "Fee timestamp",
        "transaction_hash": "Transaction hash",
    }

    parsed = parse_investment_csv(**{
        **_options(content),
        "mapping": mapping,
        "default_asset_type": "crypto",
    })

    swap = parsed.batch.records[0].activities[0]
    assert swap.activity_type == "crypto_swap"
    assert swap.aud_value == Decimal("15000")
    assert swap.valuation_source == "execution_report"
    assert swap.fee_aud_value == Decimal("15")
    assert swap.fee_valuation_source == "execution_report"
    assert swap.external_group_id == "chain-1"
    assert swap.metadata["transaction_hash"] == "chain-1"
    reward = parsed.batch.records[1].activities[0]
    assert "AUD market value is missing" in reward.warnings[0]


def test_parser_maps_final_statement_tax_and_amma_fields_without_inference():
    content = '''Reference,Date,Type,Symbol,Asset type,Gross,Net,Currency,Franked,Unfranked,Franking,Foreign income,Foreign tax,TFN,AMMA,Increase,Decrease,Adjustment date,Statement ref,Interest
amma-1,2025-06-30,Distribution,VAS,ETF,50,50,AUD,30,20,12.86,4,0.60,1.25,"{""capital_gains_discounted"":""8""}",100,0,2025-06-30,AMMA-2025,3
'''
    mapping = {
        "occurred_at": "Date", "activity_type": "Type", "asset_symbol": "Symbol",
        "asset_type": "Asset type", "gross_amount": "Gross", "net_amount": "Net",
        "currency": "Currency", "source_reference": "Reference",
        "franked_amount": "Franked", "unfranked_amount": "Unfranked",
        "franking_credit": "Franking", "foreign_income": "Foreign income",
        "foreign_tax_paid": "Foreign tax", "tfn_withholding": "TFN",
        "amit_amma_components": "AMMA", "cost_base_increase": "Increase",
        "cost_base_decrease": "Decrease", "cost_base_effective_date": "Adjustment date",
        "annual_statement_reference": "Statement ref",
        "amma_interest": "Interest",
    }

    parsed = parse_investment_csv(**{
        **_options(content),
        "mapping": mapping,
        "income_data_kind": "annual_statement",
    })

    metadata = parsed.batch.records[0].activities[0].metadata
    assert metadata["is_annual_statement"] is True
    assert metadata["franking_credit"] == "12.86"
    assert metadata["foreign_tax_paid"] == "0.6"
    assert metadata["tfn_withholding"] == "1.25"
    assert metadata["amit_amma_components"] == {"capital_gains_discounted": "8", "interest": "3"}
    assert metadata["cost_base_increase"] == "100"
    assert metadata["cost_base_effective_date"] == "2025-06-30"


def test_parser_rejects_non_object_amma_components():
    parsed = parse_investment_csv(**{
        **_options("Date,Type,Symbol,AMMA\n2025-06-30,Distribution,VAS,[]\n"),
        "mapping": {
            "occurred_at": "Date",
            "activity_type": "Type",
            "asset_symbol": "Symbol",
            "amit_amma_components": "AMMA",
        },
        "income_data_kind": "annual_statement",
    })

    assert parsed.batch.records == ()
    assert "must be a JSON object" in parsed.rejected_rows[0]["reasons"][0]


def test_fund_trade_rebuilds_an_etf_holding(db_session, investment_account):
    user, account = investment_account
    content = _content().splitlines()[0] + "\n" + _content().splitlines()[1].replace(",shares,", ",ETF,") + "\n"
    result = apply_investment_csv(
        db_session,
        user_id=user.id,
        account_id=account.id,
        parse_options=_options(content),
    )
    assert result["inserted_records"] == 1
    trade = db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).one()
    holding = db_session.query(Holding).filter(Holding.account_id == account.id).one()
    assert trade.instrument_type == "etf"
    assert holding.instrument_type == "etf"


def test_parser_excludes_ambiguous_and_malformed_rows_with_actionable_reasons():
    content = """Reference,Date,Type,Symbol,Asset type,Quantity,Price,Gross,Net,Currency,Fee,Fee currency,Tax,Tax currency
a1,02/03/2025,Buy,VAS,equity,10,"1,234",,,AUD,,AUD,,AUD
a2,31/02/2025,Buy,VAS,equity,10,100,,,AUD,,AUD,,AUD
a3,2025-03-05,Mystery,VAS,equity,10,100,,,AUD,,AUD,,AUD
"""
    parsed = parse_investment_csv(**{
        **_options(content),
        "date_format": "AUTO",
        "amount_format": "AUTO",
    })

    assert parsed.batch.records == ()
    assert len(parsed.rejected_rows) == 3
    messages = [" ".join(row["reasons"]) for row in parsed.rejected_rows]
    assert "ambiguous" in messages[0]
    assert "valid calendar date" in messages[1]
    assert "unsupported activity type" in messages[2]


def test_preview_apply_reimport_and_revert_are_scoped_and_idempotent(db_session, investment_account):
    user, account = investment_account
    _, preview = preview_investment_csv(
        db_session, user_id=user.id, account_id=account.id, parse_options=_options()
    )
    assert preview["summary"] == {
        "total_rows": 4,
        "ready_rows": 4,
        "duplicate_rows": 0,
        "rejected_rows": 0,
        "conflict_rows": 0,
        "warning_rows": 0,
    }
    assert preview["unmatched_assets"] == ["AUD", "VAS"]

    first = apply_investment_csv(
        db_session, user_id=user.id, account_id=account.id, parse_options=_options()
    )
    assert first["inserted_records"] == 4
    assert first["inserted_activities"] == 4
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 2
    assert db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).count() == 1
    holding = db_session.query(Holding).filter(Holding.account_id == account.id, Holding.symbol == "VAS").one()
    assert holding.quantity == Decimal("8.00000000")

    _, second_preview = preview_investment_csv(
        db_session, user_id=user.id, account_id=account.id, parse_options=_options()
    )
    assert second_preview["summary"]["duplicate_rows"] == 4
    second = apply_investment_csv(
        db_session, user_id=user.id, account_id=account.id, parse_options=_options()
    )
    assert second["inserted_records"] == 0
    assert second["skipped_duplicate_records"] == 4

    reverted = revert_run(db_session, user_id=user.id, run_id=first["run_id"])
    assert reverted["removed_trades"] == 2
    assert reverted["removed_income_events"] == 1
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 0
    assert db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).count() == 0
    assert db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).count() == 4
    assert db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).count() == 4
    assert revert_run(db_session, user_id=user.id, run_id=first["run_id"])["removed_trades"] == 0


def test_selected_rows_and_downstream_failure_rollback(db_session, investment_account, monkeypatch):
    user, account = investment_account
    selected = apply_investment_csv(
        db_session,
        user_id=user.id,
        account_id=account.id,
        parse_options=_options(),
        selected_row_numbers=[2],
    )
    assert selected["inserted_records"] == 1
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 1

    def fail_income(*args, **kwargs):
        raise RuntimeError("import failed after trade")

    monkeypatch.setattr(investment_activity_service, "_apply_income_activity", fail_income)
    failing = _content().replace("buy-1", "buy-2").replace("sell-1", "sell-2").replace("income-1", "income-2")
    with pytest.raises(ActivityApplicationError, match="failed atomically"):
        apply_investment_csv(
            db_session,
            user_id=user.id,
            account_id=account.id,
            parse_options=_options(failing),
        )
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 1
    assert db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).count() == 1


def test_apply_reports_partial_success_when_malformed_rows_are_excluded(db_session, investment_account):
    user, account = investment_account
    content = _content() + "bad-row,31/02/2025,Buy,VAS,equity,1,10,,,AUD,,AUD,,AUD\n"
    result = apply_investment_csv(
        db_session,
        user_id=user.id,
        account_id=account.id,
        parse_options=_options(content),
    )

    assert result["status"] == "partial"
    assert result["inserted_records"] == 4
    assert result["rejected_rows"] == 1
    run = db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.id == result["run_id"]).one()
    assert run.status == "partial"
    assert run.summary["rejected_rows"] == 1


def test_revert_keeps_economic_records_from_another_provider(db_session, investment_account):
    user, account = investment_account
    first = apply_investment_csv(
        db_session,
        user_id=user.id,
        account_id=account.id,
        parse_options=_options(_content().splitlines()[0] + "\n" + _content().splitlines()[1] + "\n"),
    )
    other_options = _options(
        _content().splitlines()[0] + "\n" + _content().splitlines()[1].replace("buy-1", "other-buy").replace(",10,", ",5,") + "\n"
    )
    other_options["provider"] = "another_broker"
    second = apply_investment_csv(
        db_session,
        user_id=user.id,
        account_id=account.id,
        parse_options=other_options,
    )
    assert first["inserted_records"] == second["inserted_records"] == 1
    holding = db_session.query(Holding).filter(Holding.account_id == account.id, Holding.symbol == "VAS").one()
    assert holding.quantity == Decimal("15.00000000")

    revert_run(db_session, user_id=user.id, run_id=first["run_id"])
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 1
    assert holding.quantity == Decimal("5.00000000")


def test_preview_blocks_overwriting_a_position_managed_by_another_source(db_session, investment_account):
    user, account = investment_account
    db_session.add(Holding(
        user_id=user.id,
        account_id=account.id,
        symbol="VAS",
        currency="AUD",
        instrument_type="equity",
        quantity=Decimal("12"),
        avg_cost=Decimal("80"),
        source="manual",
    ))
    db_session.commit()
    one_row = _content().splitlines()[0] + "\n" + _content().splitlines()[1] + "\n"
    _, preview = preview_investment_csv(
        db_session, user_id=user.id, account_id=account.id, parse_options=_options(one_row)
    )
    assert preview["summary"]["ready_rows"] == 0
    assert preview["summary"]["conflict_rows"] == 1
    assert preview["rows"][0]["status"] == "conflict"
    assert "separate account" in preview["rows"][0]["conflict_reason"]
    with pytest.raises(ValueError, match="No rows can be imported"):
        apply_investment_csv(
            db_session, user_id=user.id, account_id=account.id, parse_options=_options(one_row)
        )
