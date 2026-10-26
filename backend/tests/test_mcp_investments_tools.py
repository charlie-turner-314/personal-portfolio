from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.database import Base, engine
from app.models import (
    User, Account, Holding, HoldingValuation, BrokerConnection, AccountBalance,
)
from app.mcp.tools import investments as inv_tools


@pytest.fixture
def db():
    # Use the supported database and real grant tables. Savepoints keep commits
    # in API/service code isolated from other tests.
    Base.metadata.create_all(engine)
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


def test_list_holdings_returns_per_account_holdings(db):
    user = User(id="u1", email="u@example.com", functional_currency="EUR")
    acc = Account(id=uuid4(), user_id="u1", name="m", account_type="investment_manual", currency="EUR")
    h = Holding(id=uuid4(), user_id="u1", account_id=acc.id, symbol="AAPL",
                currency="USD", instrument_type="equity", quantity=Decimal("10"), source="manual")
    db.add(user); db.flush()
    db.add(acc); db.flush()
    db.add(h); db.flush()
    db.add(HoldingValuation(holding_id=h.id, date=date(2026, 4, 18),
                            quantity=Decimal("10"), price=Decimal("234.56"),
                            value_user_currency=Decimal("2199.07"), is_stale=False))
    db.commit()
    out = inv_tools.list_holdings_impl(db=db, user_id="u1")
    assert len(out) == 1
    assert out[0]["symbol"] == "AAPL"
    assert out[0]["current_value_user_currency"] == "2199.07"


def test_get_portfolio_summary_aggregates(db):
    user = User(id="u1", email="u@example.com", functional_currency="EUR")
    a1 = Account(id=uuid4(), user_id="u1", name="m", account_type="investment_manual", currency="EUR", is_active=True)
    a2 = Account(id=uuid4(), user_id="u1", name="b", account_type="investment_brokerage", currency="EUR", is_active=True)
    h1 = Holding(id=uuid4(), user_id="u1", account_id=a1.id, symbol="X", currency="EUR", instrument_type="equity", quantity=Decimal("1"), source="manual")
    h2 = Holding(id=uuid4(), user_id="u1", account_id=a2.id, symbol="Y", currency="EUR", instrument_type="equity", quantity=Decimal("1"), source="ibkr_flex")
    db.add(user); db.flush()
    db.add_all([a1, a2]); db.flush()
    db.add_all([h1, h2]); db.flush()
    db.add(HoldingValuation(holding_id=h1.id, date=date(2026, 4, 18), quantity=Decimal("1"), price=Decimal("100"), value_user_currency=Decimal("100")))
    db.add(HoldingValuation(holding_id=h2.id, date=date(2026, 4, 18), quantity=Decimal("1"), price=Decimal("200"), value_user_currency=Decimal("200")))
    db.commit()
    out = inv_tools.get_portfolio_summary_impl(db=db, user_id="u1")
    assert Decimal(out["total_value"]) == Decimal("300")
    assert out["currency"] == "EUR"


def test_list_holdings_resolves_person_share_at_valuation_date(db, monkeypatch):
    user = User(id="u1", email="u@example.com", functional_currency="EUR")
    acc = Account(id=uuid4(), user_id="u1", name="m", account_type="investment_manual", currency="EUR")
    holding = Holding(
        id=uuid4(), user_id="u1", account_id=acc.id, symbol="AAPL",
        currency="USD", instrument_type="equity", quantity=Decimal("1"), source="manual",
    )
    valuation_date = date(2025, 8, 1)
    db.add(user); db.flush()
    db.add(acc); db.flush()
    db.add(holding); db.flush()
    db.add(HoldingValuation(
        holding_id=holding.id, date=valuation_date, quantity=Decimal("1"),
        price=Decimal("100"), value_user_currency=Decimal("100"), is_stale=False,
    ))
    db.commit()

    observed_dates = []
    monkeypatch.setattr(inv_tools, "entity_ids_for_people", lambda *_args: [acc.id])

    def owners_at_date(_db, _entity, _account_id, *, as_of=None):
        observed_dates.append(as_of)
        return [{"person_id": "00000000-0000-4000-8000-000000000001", "share": 0.5}]

    monkeypatch.setattr(inv_tools, "get_owners", owners_at_date)
    out = inv_tools.list_holdings_impl(db, "u1", person_ids=["00000000-0000-4000-8000-000000000001"])

    assert observed_dates == [valuation_date]
    assert Decimal(out[0]["current_value_user_currency"]) == Decimal("50.0")


def test_portfolio_history_resolves_person_share_at_balance_date(db, monkeypatch):
    user = User(id="u1", email="u@example.com", functional_currency="EUR")
    acc = Account(id=uuid4(), user_id="u1", name="m", account_type="investment_manual", currency="EUR")
    balance_date = date(2025, 8, 1)
    db.add(user); db.flush()
    db.add(acc); db.flush()
    db.add(AccountBalance(
        account_id=acc.id,
        date=balance_date,
        balance_in_account_currency=Decimal("100"),
        balance_in_functional_currency=Decimal("100"),
    ))
    db.commit()

    observed_dates = []
    monkeypatch.setattr(inv_tools, "entity_ids_for_people", lambda *_args: [acc.id])

    def owners_at_date(_db, _entity, _account_id, *, as_of=None):
        observed_dates.append(as_of)
        return [{"person_id": "00000000-0000-4000-8000-000000000001", "share": 0.5}]

    monkeypatch.setattr(inv_tools, "get_owners", owners_at_date)
    out = inv_tools.get_portfolio_history_impl(db, "u1", person_ids=["00000000-0000-4000-8000-000000000001"])

    assert observed_dates == [balance_date]
    assert Decimal(out[0]["value_user_currency"]) == Decimal("50.0")
