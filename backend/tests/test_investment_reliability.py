from datetime import date, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from tests.test_investments_routes import db, client  # noqa: F401
from app.models import Account, AccountBalance, Holding, HoldingValuation, InvestmentIncomeEvent, PriceSnapshot
from app.services.holding_valuation_service import HoldingValuationService
from app.services.investment_fx import InvestmentFxAdapter, MissingInvestmentFx


def position(db, symbol="VAS.AX", quantity="10"):
    account = Account(id=uuid4(), user_id="u1", name="Australian portfolio", account_type="investment_manual", currency="AUD")
    db.add(account); db.flush()
    holding = Holding(id=uuid4(), user_id="u1", account_id=account.id, symbol=symbol, currency="AUD", instrument_type="equity", quantity=Decimal(quantity), source="manual")
    db.add(holding); db.commit()
    return account, holding


def test_missing_fx_is_not_identity_conversion():
    with patch("app.services.investment_fx.ExchangeRateService") as service:
        service.return_value.convert_amount.return_value = None
        fx = InvestmentFxAdapter(MagicMock())
        assert fx.convert(Decimal("10"), "AUD", "AUD", date(2026, 10, 26)) == 10
        with pytest.raises(MissingInvestmentFx, match="USD/AUD"):
            fx.convert(Decimal("10"), "USD", "AUD", date(2026, 10, 26))


def test_unpriced_position_preserves_valid_balance_and_never_creates_zero(client, db):
    account, holding = position(db)
    db.add(AccountBalance(account_id=account.id, date=datetime(2026, 10, 25), balance_in_account_currency=1000, balance_in_functional_currency=1000))
    db.commit()
    HoldingValuationService(db, fx=MagicMock()).compute(account.id, date(2026, 10, 26))
    assert db.query(HoldingValuation).count() == 0
    assert db.query(AccountBalance).one().balance_in_account_currency == 1000
    assert "Price unavailable" in holding.last_price_error
    response = client.get("/api/investments/portfolio/summary").json()
    assert response["valuation_status"] == "unavailable"
    assert response["unavailable_holdings"] == 1


def test_confirmed_zero_quote_is_valid_and_records_currency(client, db):
    account, holding = position(db)
    db.add(PriceSnapshot(symbol=holding.symbol, date=date(2026, 10, 26), close=0, currency="AUD", provider="yahoo-v2")); db.commit()
    fx = MagicMock(); fx.convert.return_value = Decimal(0)
    HoldingValuationService(db, fx).compute(account.id, date(2026, 10, 26))
    valuation = db.query(HoldingValuation).one()
    assert valuation.price == 0
    assert valuation.value_currency == "EUR"  # actor reporting currency differs from account
    assert valuation.quote_currency == "AUD"
    assert holding.last_price_error is None


def test_quantity_edit_queues_revaluation(client, db):
    _, holding = position(db)
    with patch("app.routes.investments._run_sync_in_process") as sync:
        response = client.patch(f"/api/investments/holdings/{holding.id}", json={"quantity": "12.5"})
    assert response.status_code == 200, response.text
    sync.assert_called_once_with(holding.account_id)


def test_delete_cannot_cascade_income_and_archive_preserves_it(client, db):
    account, holding = position(db)
    event = InvestmentIncomeEvent(user_id="u1", account_id=account.id, holding_id=holding.id, event_type="dividend", pay_date=date(2026, 10, 1), currency="AUD", cash_received=25)
    db.add(event); db.commit()
    response = client.delete(f"/api/investments/holdings/{holding.id}")
    assert response.status_code == 409, response.text
    with patch("app.routes.investments._run_sync_in_process"):
        response = client.post(f"/api/investments/holdings/{holding.id}/archive")
    assert response.status_code == 204, response.text
    assert db.query(InvestmentIncomeEvent).one().cash_received == 25
    assert db.get(Holding, holding.id).archived_at is not None
    assert client.get("/api/investments/portfolio/summary").json()["total_value"] == "0"


def test_private_manual_prices_use_per_holding_identity(client, db):
    _, first = position(db)
    _, second = position(db)
    with patch("app.routes.investments._run_sync_in_process"):
        for holding, price in [(first, "100.25"), (second, "120.75")]:
            response = client.post(f"/api/investments/holdings/{holding.id}/prices", json={"date": "2026-10-01", "price": price, "currency": "AUD", "source": "Fund statement"})
            assert response.status_code == 200, response.text
    snapshots = db.query(PriceSnapshot).all()
    assert len(snapshots) == 2
    assert first.provider_symbol != second.provider_symbol
    assert {row.close for row in snapshots} == {Decimal("100.25"), Decimal("120.75")}


def test_summary_retains_native_account_currency_and_capability(client, db):
    account, _ = position(db)
    response = client.get("/api/investments/portfolio/summary").json()
    row = next(row for row in response["accounts"] if row["id"] == str(account.id))
    assert row["currency"] == "AUD"
    assert row["can_add_holdings"] is True


def test_history_seeds_before_range_and_carries_each_account_forward(client, db):
    from app.models import User
    db.query(User).filter_by(id="u1").one().functional_currency = "AUD"
    first, _ = position(db, symbol="VAS.AX")
    second, _ = position(db, symbol="BHP.AX")
    for account, day, amount in [(first, 23, 100), (second, 24, 200), (first, 26, 110)]:
        db.add(AccountBalance(account_id=account.id, date=datetime(2026, 10, day), account_currency="AUD", balance_in_account_currency=amount, balance_in_functional_currency=amount))
    db.commit()
    response = client.get("/api/investments/portfolio/history?from=2026-10-25&to=2026-10-26")
    assert response.status_code == 200, response.text
    assert response.json() == [{"date": "2026-10-25", "value": "300.00"}, {"date": "2026-10-26", "value": "310.00"}]


def test_reporting_years_and_income_keep_all_native_currencies(client, db):
    account, holding = position(db)
    for day, currency, amount in [(date(2025, 6, 30), "AUD", 10), (date(2025, 7, 1), "AUD", 20), (date(2025, 7, 2), "USD", 30)]:
        db.add(InvestmentIncomeEvent(user_id="u1", account_id=account.id, holding_id=holding.id, event_type="dividend", pay_date=day, currency=currency, cash_received=amount))
    db.commit()
    response = client.get("/api/investments/reporting-years")
    assert response.status_code == 200, response.text
    assert {2024, 2025}.issubset(set(response.json()))
    response = client.get("/api/investments/income-events/summary?financial_year_start=2025")
    assert response.status_code == 200, response.text
    assert {(row["currency"], row["cash_income"]) for row in response.json()} == {("AUD", "20.00"), ("USD", "30.00")}


def test_symbol_search_outage_is_not_a_manufactured_match(client):
    with patch("app.routes.investments.get_price_provider") as provider:
        provider.return_value.search_symbols.side_effect = RuntimeError("Unavailable")
        response = client.get("/api/investments/symbols/search?q=VAS")
    assert response.status_code == 503, response.text


def test_manual_asset_types_and_currency_validation(client):
    from app.schemas import HoldingCreate, ManualAccountCreate
    from pydantic import ValidationError
    assert ManualAccountCreate(name="Shares").base_currency == "AUD"
    for kind in ["fund", "crypto"]:
        assert HoldingCreate(symbol="FUND", quantity="0.125", instrument_type=kind, currency="AUD").quantity == Decimal("0.125")
    with pytest.raises(ValidationError):
        HoldingCreate(symbol="FUND", quantity="-1", instrument_type="fund", currency="AUD")
    with pytest.raises(ValidationError):
        HoldingCreate(symbol="FUND", quantity="1", instrument_type="fund", currency="AUDD")


def test_dated_person_scope_applies_to_value_history_and_income(client, db):
    from app.models import User, Person, AccountOwnershipAllocation
    db.query(User).filter_by(id="u1").one().functional_currency = "AUD"
    account, holding = position(db)
    alice = Person(id=uuid4(), user_id="u1", kind="self", name="Alice")
    bob = Person(id=uuid4(), user_id="u1", kind="member", name="Bob")
    db.add_all([alice, bob]); db.flush()
    for effective, shares in [(date(2026, 1, 1), ("0.25", "0.75")), (date(2026, 10, 26), ("0.6", "0.4"))]:
        for person, share in zip([alice, bob], shares):
            db.add(AccountOwnershipAllocation(account_id=account.id, person_id=person.id, effective_from=effective, share=Decimal(share)))
    db.add(HoldingValuation(holding_id=holding.id, date=date(2026, 10, 26), quantity=10, price=100, value_user_currency=1000, value_currency="AUD", quote_currency="AUD", is_stale=False))
    db.add(AccountBalance(account_id=account.id, date=datetime(2026, 10, 25), account_currency="AUD", balance_in_account_currency=1000, balance_in_functional_currency=1000))
    db.add(InvestmentIncomeEvent(user_id="u1", account_id=account.id, holding_id=holding.id, event_type="dividend", pay_date=date(2026, 10, 25), currency="AUD", cash_received=100))
    db.commit()
    result = client.get(f"/api/investments/portfolio/summary?person_ids={bob.id}")
    assert result.status_code == 200, result.text
    assert Decimal(result.json()["total_value"]) == 400
    rows = client.get(f"/api/investments/holdings?person_ids={bob.id}").json()
    assert Decimal(rows[0]["ownership_share"]) == Decimal("0.4")
    assert Decimal(rows[0]["quantity"]) == 10  # whole-account units are retained
    result = client.get(f"/api/investments/portfolio/history?from=2026-10-25&to=2026-10-26&person_ids={bob.id}")
    assert result.status_code == 200, result.text
    assert [Decimal(row["value"]) for row in result.json()] == [750, 400]
    result = client.get(f"/api/investments/income-events/summary?financial_year_start=2026&person_ids={bob.id}")
    assert result.status_code == 200, result.text
    assert Decimal(result.json()[0]["cash_income"]) == 75
    own = client.get("/api/investments/portfolio/summary?person_ids=self").json()
    assert Decimal(own["total_value"]) == 600
    both = client.get(f"/api/investments/portfolio/summary?person_ids={alice.id},{bob.id}").json()
    assert Decimal(both["total_value"]) == 1000


def test_unknown_or_unavailable_person_scope_is_rejected(client):
    result = client.get(f"/api/investments/portfolio/summary?person_ids={uuid4()}")
    assert result.status_code == 403
    result = client.get("/api/investments/portfolio/summary?person_ids=not-a-person")
    assert result.status_code == 422


def test_manual_sync_persists_completion_and_failure(client, db):
    from app.services.investment_sync_service import InvestmentSyncService
    account, _ = position(db)
    service = InvestmentSyncService(db, fx=MagicMock(), price_service=MagicMock(), valuation_service=MagicMock())
    service.sync_account(account.id, date(2026, 10, 26))
    assert account.investment_sync_state["status"] == "completed"
    with patch.object(service, "_sync_manual", side_effect=RuntimeError("Sensitive provider detail")):
        with pytest.raises(RuntimeError):
            service.sync_account(account.id, date(2026, 10, 26))
    result = client.get("/api/investments/sync-status").json()
    assert result[0]["status"] == "failed"
    assert "Sensitive" not in result[0]["error"]


def test_recorded_basis_converts_each_acquisition_at_its_own_date(client, db):
    from app.models import BrokerTrade
    from app.services.investment_cost_basis import InvestmentCostBasis
    account, holding = position(db, quantity="2")
    holding.currency = "USD"; holding.source = "trade_import"
    for day, price in [(1, 100), (2, 200)]:
        db.add(BrokerTrade(account_id=account.id, symbol=holding.symbol, instrument_type=holding.instrument_type, trade_date=date(2026, 10, day), side="buy", quantity=1, price=price, currency="USD", fees=0, external_id=f"buy-{day}"))
    db.commit()
    fx = MagicMock()
    fx.get_exchange_rate.side_effect = lambda src, dst, day: {date(2026, 10, 1): Decimal("1.5"), date(2026, 10, 2): Decimal("1.6")}.get(day)
    value, kind = InvestmentCostBasis(db, [account.id], fx, "AUD").for_holding(holding, date(2026, 10, 26))
    assert value == Decimal("470.00")
    assert kind == "recorded_lots"


def test_unlisted_fund_is_distinct_from_legacy_listed_fund_alias():
    from app.services.investment_csv_import_service import _asset_type
    from app.services.investment_activity_service import _instrument_type
    assert _instrument_type(_asset_type("managed fund", "equity")) == "fund"
    assert _instrument_type(_asset_type("ETF", "equity")) == "etf"


def test_edit_can_correct_legacy_eur_manual_currency(client, db):
    _, holding = position(db)
    holding.currency = "EUR"; db.commit()
    with patch("app.routes.investments._run_sync_in_process"):
        result = client.patch(f"/api/investments/holdings/{holding.id}", json={"currency": "AUD"})
    assert result.status_code == 200, result.text
    assert holding.currency == "AUD"


def test_account_creation_and_lost_response_holding_retry_are_idempotent(client, db):
    key = str(uuid4())
    payload = {"name": "AUD portfolio", "base_currency": "AUD", "creation_key": key}
    first = client.post("/api/investments/manual-accounts", json=payload)
    second = client.post("/api/investments/manual-accounts", json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()["account_id"] == second.json()["account_id"]
    account_id = first.json()["account_id"]
    data = {"symbol": "VAS.AX", "quantity": "2.5", "instrument_type": "etf", "currency": "AUD"}
    with patch("app.routes.investments._run_sync_in_process"), patch("app.routes.investments.get_price_provider") as provider:
        provider.return_value.search_symbols.return_value = []
        first = client.post(f"/api/investments/manual-accounts/{account_id}/holdings", json=data)
        second = client.post(f"/api/investments/manual-accounts/{account_id}/holdings", json=data)
    assert first.status_code == second.status_code == 200
    assert first.json()["holding_id"] == second.json()["holding_id"]
    assert db.query(Holding).count() == 1


def test_selected_instrument_resolves_exact_currency_and_type(monkeypatch):
    from app.integrations.price_provider import yahoo_provider
    provider = yahoo_provider.YahooPriceProvider()
    fake = MagicMock()
    fake.Ticker.return_value.info = {"symbol": "BHP.AX", "currency": "AUD", "quoteType": "EQUITY", "longName": "BHP Group"}
    monkeypatch.setattr(yahoo_provider, "yf", fake)
    match = provider.resolve_symbol("BHP.AX")
    assert match.currency == "AUD"
    assert match.instrument_type == "equity"
    fake.Ticker.return_value.info = {"symbol": "BHP.AX"}
    with pytest.raises(ValueError, match="currency unavailable"):
        provider.resolve_symbol("BHP.AX")
    assert provider._quote_terms("TEST", {"currency": "GBp"}) == ("GBP", Decimal("0.01"))


def test_provider_prices_do_not_collide_for_the_same_ticker_and_day(client, db):
    from app.services.price_service import PriceService
    from app.integrations.price_provider.base import PriceQuote
    db.add(PriceSnapshot(symbol="BTC", date=date(2026, 10, 26), close=100000, currency="AUD", provider="coinspot"))
    db.commit()
    provider = MagicMock(); provider.name = "yahoo-v2"
    provider.get_daily_closes.return_value = {"BTC": PriceQuote("BTC", "USD", date(2026, 10, 26), Decimal("40"))}
    service = PriceService(db, provider)
    quotes = service.get_or_fetch(["BTC"], date(2026, 10, 26))
    assert quotes["BTC"].close == 40
    assert db.query(PriceSnapshot).filter_by(symbol="BTC").count() == 2
    assert service.latest_snapshot("BTC", date(2026, 10, 26), "coinspot").close == 100000


def test_stored_currency_survives_owner_reporting_currency_change(client, db):
    from app.models import User, ExchangeRate
    account, holding = position(db)
    db.add(HoldingValuation(holding_id=holding.id, date=date(2026, 10, 26), quantity=10, price=10, value_user_currency=100, value_currency="USD", quote_currency="USD", is_stale=False))
    db.add(ExchangeRate(date=datetime(2026, 10, 26), base_currency="USD", target_currency="AUD", rate=Decimal("1.5")))
    db.query(User).filter_by(id="u1").one().functional_currency = "AUD"
    db.commit()
    result = client.get("/api/investments/holdings")
    assert result.status_code == 200, result.text
    assert Decimal(result.json()[0]["current_value_user_currency"]) == 150
    valuation = db.query(HoldingValuation).one()
    assert valuation.value_currency == "USD"
    assert valuation.value_user_currency == 100


def test_one_disposal_across_three_lots_is_counted_once(client, db):
    from app.services.broker_trade_service import import_trades
    account, holding = position(db, quantity="0")
    trades = [{"symbol": holding.symbol, "instrument_type": "equity", "trade_date": f"2024-01-0{day}", "side": "buy", "quantity": "1", "price": str(day * 10), "currency": "AUD", "fees": "0", "external_id": f"buy-{day}"} for day in [1, 2, 3]]
    trades.append({"symbol": holding.symbol, "instrument_type": "equity", "trade_date": "2026-10-01", "side": "sell", "quantity": "3", "price": "40", "currency": "AUD", "fees": "0", "external_id": "sale"})
    result = import_trades(db, "u1", str(account.id), trades, dry_run=False)
    assert result["inserted"] == 4, result
    response = client.get("/api/investments/cgt/summary?financial_year_start=2026")
    assert response.status_code == 200, response.text
    assert response.json()["disposal_count"] == 1
    assert response.json()["allocation_count"] == 3
    assert Decimal(response.json()["gross_gains_aud"]) == 60


def test_migration_preserves_unknown_currency_and_provider_key_on_replay(client, db):
    from pathlib import Path
    account, holding = position(db)
    legacy = HoldingValuation(holding_id=holding.id, date=date(2026, 10, 20), quantity=10, price=10, value_user_currency=100, is_stale=False)
    db.add(legacy); db.commit()
    root = Path(__file__).resolve().parents[2]
    new_migration = (root / "frontend/lib/db/migrations/0061_investment_reliability.manual.sql").read_text()
    original_migration = (root / "frontend/lib/db/migrations/0019_investments.manual.sql").read_text()
    db.connection().exec_driver_sql(new_migration)
    db.connection().exec_driver_sql(original_migration)
    db.connection().exec_driver_sql(new_migration)
    db.refresh(legacy)
    assert legacy.value_currency is None
    assert legacy.value_user_currency == 100
    result = client.get("/api/investments/holdings").json()
    assert result[0]["current_value_user_currency"] is None
    assert "unverified" in result[0]["valuation_error"]


def test_ibkr_statement_marks_are_used_and_sold_positions_keep_income(client, db):
    from app.models import User
    from app.integrations.ibkr_flex_adapter import ParsedPosition
    from app.services.investment_sync_service import InvestmentSyncService
    account, holding = position(db, symbol="BHP")
    db.query(User).filter_by(id="u1").one().functional_currency = "AUD"
    db.add(InvestmentIncomeEvent(user_id="u1", account_id=account.id, holding_id=holding.id, event_type="dividend", pay_date=date(2026, 10, 1), currency="AUD", cash_received=25))
    db.commit()
    fx = MagicMock(); fx.convert.side_effect = lambda amount, *args: amount
    service = InvestmentSyncService(db, fx=fx)
    service._upsert_positions(account, [ParsedPosition("BHP", "Australian BHP", Decimal(10), "AUD", "equity", Decimal(100), Decimal(110), date(2026, 10, 26))])
    db.commit()
    service.valuation_service.compute(account.id, date(2026, 10, 26))
    valuation = db.query(HoldingValuation).one()
    assert valuation.price == 110
    assert valuation.quote_currency == "AUD"
    assert valuation.quote_source == "IBKR statement"
    assert valuation.value_user_currency == 1100
    service._upsert_positions(account, [])
    db.commit()
    assert db.get(Holding, holding.id).quantity == 0
    assert db.query(InvestmentIncomeEvent).one().cash_received == 25
    assert db.query(HoldingValuation).count() == 1


def test_ibkr_typed_fees_rebuild_cgt_without_overwriting_reported_units(client, db):
    from app.models import CgtAllocation
    from app.integrations.ibkr_flex_adapter import ParsedTrade
    from app.services.investment_sync_service import InvestmentSyncService
    account, holding = position(db, quantity="10")
    holding.instrument_type = "etf"; holding.source = "ibkr_flex"; db.commit()
    service = InvestmentSyncService(db, fx=MagicMock())
    rows = [ParsedTrade("buy", holding.symbol, "buy", Decimal(2), Decimal(100), "AUD", date(2024, 1, 1), "etf", Decimal(2), "AUD"), ParsedTrade("sell", holding.symbol, "sell", Decimal(1), Decimal(120), "AUD", date(2026, 10, 1), "etf", Decimal(2), "AUD")]
    assert service._upsert_trades(account, rows) == 0
    db.flush()
    allocation = db.query(CgtAllocation).one()
    assert allocation.instrument_type == "etf"
    assert allocation.gain_aud == 17
    assert holding.quantity == 10  # broker position is authoritative, not partial history
    assert service._ibkr_position_mismatches(account) == [holding.symbol]


def test_account_sync_lock_survives_session_commits(db):
    from threading import Event, Thread
    from sqlalchemy.orm import Session
    from app.services.investment_lock_service import account_sync_lock
    account_id = uuid4()
    engine = db.get_bind().engine
    attempted, entered = Event(), Event()
    errors = []

    def contender():
        try:
            with Session(engine) as other:
                attempted.set()
                with account_sync_lock(other, account_id):
                    entered.set()
        except Exception as error:
            errors.append(error)

    with account_sync_lock(db, account_id):
        thread = Thread(target=contender, daemon=True)
        thread.start()
        assert attempted.wait(2)
        db.commit()
        assert not entered.wait(0.2), "Session commit must not release the account lock"
    assert entered.wait(2), "Waiting refresh must resume after lock release"
    thread.join(2)
    assert not errors
    assert not thread.is_alive()


@pytest.mark.parametrize("fails", [False, True])
def test_old_refresh_does_not_replace_newer_queued_status(client, db, fails):
    from app.services.investment_sync_service import InvestmentSyncService
    account, _ = position(db)
    newer_id = str(uuid4())
    service = InvestmentSyncService(db, fx=MagicMock())

    def refresh(*args):
        account.investment_sync_state = {"status": "queued", "request_id": newer_id}
        db.commit()
        if fails:
            raise RuntimeError("Synthetic provider failure")

    with patch.object(service, "_sync_manual", side_effect=refresh):
        if fails:
            with pytest.raises(RuntimeError):
                service.sync_account(account.id)
        else:
            service.sync_account(account.id)
    db.refresh(account)
    assert account.investment_sync_state == {"status": "queued", "request_id": newer_id}


def test_linked_household_scope_never_bypasses_account_grants(client, db):
    from app.models import User, Person, HouseholdMembership, HouseholdAccountShare, AccountOwnershipAllocation
    from app.services.investment_scope import InvestmentScope
    account, _ = position(db)
    private, _ = position(db, symbol="PRIVATE")
    db.add(User(id="investment-member", email="investment-member@example.test", functional_currency="AUD"))
    db.flush()
    alias = Person(user_id="u1", linked_user_id="investment-member", kind="member", name="Partner")
    login_self = Person(user_id="investment-member", kind="self", name="Partner login")
    db.add_all([alias, login_self]); db.flush()
    db.add(HouseholdMembership(owner_user_id="u1", member_user_id="investment-member", person_id=alias.id))
    db.add(HouseholdAccountShare(account_id=account.id, member_user_id="investment-member", granted_by_user_id="u1"))
    for row in [account, private]:
        db.add(AccountOwnershipAllocation(account_id=row.id, person_id=alias.id, effective_from=date(2026, 1, 1), share=Decimal("0.4")))
    db.commit()
    for selection in ["self", str(alias.id), str(login_self.id)]:
        scope = InvestmentScope(db, "investment-member", selection)
        assert scope.share(account.id, date(2026, 10, 26)) == Decimal("0.4")
        assert scope.share(private.id, date(2026, 10, 26)) == 0
    db.query(HouseholdAccountShare).filter_by(account_id=account.id).delete(); db.commit()
    scope = InvestmentScope(db, "investment-member", "self")
    assert scope.share(account.id, date(2026, 10, 26)) == 0


def test_incomplete_ibkr_lots_preserve_source_and_do_not_break_portfolio(client, db):
    from app.integrations.ibkr_flex_adapter import ParsedTrade
    from app.models import BrokerTrade, CgtAllocation
    from app.services.investment_sync_service import InvestmentSyncService
    account, holding = position(db, quantity="-1")
    holding.source = "ibkr_flex"
    db.commit()
    trade = ParsedTrade(external_id="short-without-opening-lots", symbol=holding.symbol, trade_date=date(2026, 10, 20), side="sell", quantity=Decimal(1), price=Decimal(100), currency="AUD", instrument_type="equity", fees=Decimal(1), fee_currency="AUD")
    service = InvestmentSyncService(db, fx=MagicMock())
    assert service._upsert_trades(account, [trade]) == 1
    db.commit()
    assert db.query(BrokerTrade).one().valuation_missing is True
    assert db.query(CgtAllocation).count() == 0
    assert holding.quantity == -1
    result = client.get("/api/investments/holdings")
    assert result.status_code == 200, result.text
    assert result.json()[0]["cost_basis_user_currency"] is None


def test_today_change_uses_recorded_native_currency_and_marks_unknown_history(client, db):
    from datetime import timedelta
    from app.models import User
    db.get(User, 'u1').functional_currency = 'AUD'
    account, _ = position(db)
    today = date.today()
    prior = AccountBalance(account_id=account.id, date=today-timedelta(days=1), account_currency='USD', balance_in_account_currency=100, balance_in_functional_currency=999)
    current = AccountBalance(account_id=account.id, date=today, account_currency='AUD', balance_in_account_currency=200, balance_in_functional_currency=888)
    db.add_all([prior, current]); db.commit()
    with patch('app.services.exchange_rate_service.ExchangeRateService.get_exchange_rate', return_value=Decimal('1.5')):
        result = client.get('/api/investments/portfolio/summary')
    assert result.status_code == 200, result.text
    assert Decimal(result.json()['total_value_today_change']) == 50
    prior.account_currency = None; db.commit()
    result = client.get('/api/investments/portfolio/summary')
    assert result.status_code == 200, result.text
    assert result.json()['total_value_today_change'] is None


def test_holdings_read_query_count_does_not_grow_per_position(client, db):
    from sqlalchemy import event
    from app.models import User
    db.get(User, 'u1').functional_currency = 'AUD'
    account, holding = position(db)
    db.add(HoldingValuation(holding_id=holding.id, date=date.today(), quantity=10, price=100, value_user_currency=1000, value_currency='AUD'))
    db.commit()
    queries = []
    def count_sql(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT'):
            queries.append(statement)
    connection = db.get_bind()
    event.listen(connection, 'before_cursor_execute', count_sql)
    try:
        assert client.get('/api/investments/holdings').status_code == 200
        baseline = len(queries)
        for index in range(20):
            row = Holding(user_id='u1', account_id=account.id, symbol=f'BATCH-{index}', currency='AUD', instrument_type='equity', quantity=1, source='manual')
            db.add(row); db.flush()
            db.add(HoldingValuation(holding_id=row.id, date=date.today(), quantity=1, price=10, value_user_currency=10, value_currency='AUD'))
        db.commit(); queries.clear()
        result = client.get('/api/investments/holdings')
        assert result.status_code == 200, result.text
        assert len(result.json()) == 21
        assert len(queries) <= baseline + 2
    finally:
        event.remove(connection, 'before_cursor_execute', count_sql)
