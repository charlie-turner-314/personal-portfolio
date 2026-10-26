"""Actual migrated PostgreSQL tests; no real data or external bank calls."""

import os
from datetime import date, datetime, timedelta
from decimal import Decimal as D
from uuid import uuid4
import pytest
from sqlalchemy import text
from app.models import Account, AccountBalance, ExchangeRate, Transaction, User
from app.services.account_balance_service import AccountBalanceService
from app.services.financial_activity import FinancialActivity
from app.services.financial_values import recorded_account_balance


@pytest.fixture
def balances(db_session, monkeypatch):
    if os.getenv(
        "HOUSEHOLD_TEST_ISOLATED"
    ) != "yes" or "household_model_test" not in os.getenv("DATABASE_URL", ""):
        pytest.skip("Dedicated synthetic database required")
    db = db_session
    actor = "balances-" + str(uuid4())
    user = User(id=actor, email=actor + "@example.test", functional_currency="XBB")
    db.add(user)
    db.flush()
    account = Account(
        user_id=actor,
        name="Synthetic cash",
        account_type="checking",
        currency="XAA",
        starting_balance=D(100),
        created_at=datetime.combine(
            date.today() - timedelta(days=2), datetime.min.time()
        ),
    )
    db.add(account)
    db.flush()
    monkeypatch.setattr(db, "commit", db.flush)
    return db, actor, account, AccountBalanceService(db)


def snapshot(db, account, day, value, source="manual", currency="XAA"):
    row = AccountBalance(
        account_id=account.id,
        date=datetime.combine(day, datetime.min.time()),
        balance_in_account_currency=value,
        balance_in_functional_currency=D(99999),
        balance_source=source,
        account_currency=currency,
        functional_currency="XCC",
    )
    db.add(row)
    db.flush()
    return row


def transaction(db, actor, account, day, amount, currency="XAA"):
    db.add(
        Transaction(
            user_id=actor,
            account_id=account.id,
            amount=D(amount),
            currency=currency,
            booked_at=datetime.combine(day, datetime.min.time()),
            description="Synthetic movement",
            transaction_type="credit",
        )
    )
    db.flush()


def test_calculation_preserves_legacy_and_supplied_rows_and_anchors_later_estimates(
    balances,
):
    db, actor, account, service = balances
    day = date.today() - timedelta(days=2)
    legacy = snapshot(db, account, day, D(500), "legacy", None)
    observed = snapshot(db, account, day + timedelta(days=1), D(800), "statement")
    transaction(db, actor, account, day, 90)
    transaction(db, actor, account, date.today(), 30)
    for _ in range(2):
        service.calculate_account_timeseries(actor)
    db.refresh(legacy)
    db.refresh(observed)
    assert (legacy.balance_in_account_currency, legacy.balance_source) == (
        D(500),
        "legacy",
    )
    assert (observed.balance_in_account_currency, observed.balance_source) == (
        D(800),
        "statement",
    )
    rows = (
        db.query(AccountBalance)
        .filter_by(account_id=account.id)
        .order_by(AccountBalance.date)
        .all()
    )
    assert len(rows) == 3
    assert rows[-1].balance_in_account_currency == D(830)
    assert rows[-1].balance_source == "calculated"
    assert rows[-1].balance_in_functional_currency is None
    assert account.functional_balance is None


def test_each_movement_uses_its_own_dated_currency_not_raw_sum(balances):
    db, actor, account, service = balances
    day = date.today() - timedelta(days=1)
    db.add_all(
        [
            ExchangeRate(
                date=datetime.combine(day, datetime.min.time()),
                base_currency="XCC",
                target_currency="XAA",
                rate=D(2),
            ),
            ExchangeRate(
                date=datetime.combine(date.today(), datetime.min.time()),
                base_currency="XCC",
                target_currency="XAA",
                rate=D(3),
            ),
            ExchangeRate(
                date=datetime.combine(day, datetime.min.time()),
                base_currency="XAA",
                target_currency="XBB",
                rate=D(4),
            ),
        ]
    )
    db.flush()
    transaction(db, actor, account, day, 10, "XCC")
    transaction(db, actor, account, date.today(), 10, "XCC")
    service.calculate_account_timeseries(actor)
    today = (
        db.query(AccountBalance)
        .filter_by(
            account_id=account.id,
            date=datetime.combine(date.today(), datetime.min.time()),
        )
        .one()
    )
    assert today.balance_in_account_currency == D(150)
    assert today.balance_in_functional_currency == D(600)
    assert (today.account_currency, today.functional_currency) == ("XAA", "XBB")


def test_missing_movement_conversion_stays_unknown_until_supplied_anchor(balances):
    db, actor, account, service = balances
    day = date.today() - timedelta(days=1)
    transaction(db, actor, account, day, 10, "XDD")
    service.calculate_account_timeseries(actor)
    assert all(
        row.balance_in_account_currency is None
        for row in db.query(AccountBalance).filter_by(account_id=account.id)
    )
    service.import_daily_balances(
        account.id, [{"date": day.isoformat(), "balance": "450"}], "XBB"
    )
    service.calculate_account_timeseries(actor)
    rows = (
        db.query(AccountBalance)
        .filter_by(account_id=account.id)
        .order_by(AccountBalance.date)
        .all()
    )
    assert [row.balance_in_account_currency for row in rows] == [D(450), D(450)]
    assert [row.balance_source for row in rows] == ["statement", "calculated"]


@pytest.mark.parametrize("source", ["calculated", "legacy", "valuation"])
def test_derived_or_unverified_snapshots_never_prove_reconciliation(balances, source):
    db, actor, account, _ = balances
    db.get(User, actor).functional_currency = "XAA"
    snapshot(db, account, date.today(), D(500), source)
    activity = FinancialActivity(db, actor)
    assert recorded_account_balance(activity, account, exact=True) is None
    assert recorded_account_balance(activity, account) == D(500)


def test_explicit_units_survive_changed_currency_preference(balances):
    db, actor, account, _ = balances
    snapshot(db, account, date.today(), None, "manual")
    # A labelled XCC functional amount cannot masquerade as XBB.
    activity = FinancialActivity(db, actor)
    assert recorded_account_balance(activity, account, exact=True) is None
    db.add(
        ExchangeRate(
            date=datetime.combine(date.today(), datetime.min.time()),
            base_currency="XCC",
            target_currency="XBB",
            rate=D(2),
        )
    )
    db.flush()
    assert recorded_account_balance(
        FinancialActivity(db, actor), account, exact=True
    ) == D(199998)


def test_statement_replacement_archives_original_and_missing_input_is_not_zero(
    balances,
):
    db, actor, account, service = balances
    old = snapshot(db, account, date.today(), D(400), "legacy", None)
    with pytest.raises(KeyError):
        service.import_daily_balances(
            account.id, [{"date": date.today().isoformat()}], "XBB"
        )
    db.refresh(old)
    assert old.balance_in_account_currency == D(400)
    service.import_daily_balances(
        account.id, [{"date": date.today().isoformat(), "balance": "550"}], "XBB"
    )
    db.refresh(old)
    assert old.balance_source == "statement"
    assert old.balance_in_functional_currency is None
    archived = (
        db.execute(
            text(
                "SELECT snapshot->>'balance_in_account_currency' FROM account_balance_revisions WHERE balance_row_id=:id"
            ),
            {"id": old.id},
        )
        .scalars()
        .all()
    )
    assert "400.00" in archived


def test_database_guard_blocks_derived_replacement_and_same_day_duplicate(balances):
    db, _, account, _ = balances
    observed = snapshot(db, account, date.today(), D(400), "statement")
    # Raw SQL exercises the shared guard used by Python and frontend writers.
    db.execute(
        text(
            "UPDATE account_balances SET balance_source='calculated', balance_in_account_currency=999 WHERE id=:id"
        ),
        {"id": observed.id},
    )
    db.execute(
        text(
            "INSERT INTO account_balances(account_id,date,balance_source,account_currency,balance_in_account_currency) VALUES(:account, CURRENT_DATE + interval '12 hours','calculated','XAA',999)"
        ),
        {"account": account.id},
    )
    db.refresh(observed)
    assert observed.balance_in_account_currency == D(400)
    assert observed.balance_source == "statement"
    assert db.query(AccountBalance).filter_by(account_id=account.id).count() == 1


def test_migration_preserves_values_repeats_and_recovers_after_new_writes(db_session):
    from pathlib import Path

    if os.getenv(
        "HOUSEHOLD_TEST_ISOLATED"
    ) != "yes" or "household_model_test" not in os.getenv("DATABASE_URL", ""):
        pytest.skip("Dedicated synthetic database required")
    db = db_session
    schema = "balance_migration_" + uuid4().hex
    db.execute(text(f'CREATE SCHEMA "{schema}"'))
    db.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
    db.execute(
        text(
            "CREATE TABLE accounts(id uuid PRIMARY KEY); CREATE TABLE account_balances(id uuid PRIMARY KEY,account_id uuid REFERENCES accounts(id),date timestamp NOT NULL,balance_in_account_currency numeric NOT NULL,balance_in_functional_currency numeric NOT NULL,UNIQUE(account_id,date))"
        )
    )
    account, row = uuid4(), uuid4()
    db.execute(text("INSERT INTO accounts VALUES(:a)"), {"a": account})
    db.execute(
        text("INSERT INTO account_balances VALUES(:r,:a,'2026-01-01',123.45,987.65)"),
        {"a": account, "r": row},
    )
    migration = Path("/app/balance-provenance-migration.sql").read_text()
    for _ in range(2):
        db.execute(text(migration))
        values = db.execute(
            text(
                "SELECT balance_in_account_currency,balance_in_functional_currency,balance_source,account_currency,functional_currency FROM account_balances"
            )
        ).one()
        assert tuple(values) == (D("123.45"), D("987.65"), "legacy", None, None)
        assert (
            db.execute(text("SELECT count(*) FROM account_balance_revisions")).scalar()
            == 1
        )
    with pytest.raises(RuntimeError):
        with db.begin_nested():
            db.execute(
                text(
                    "UPDATE account_balances SET balance_in_account_currency=999,balance_source='manual',account_currency='AUD'"
                )
            )
            raise RuntimeError("Simulated failed write")
    assert db.execute(
        text("SELECT balance_in_account_currency FROM account_balances")
    ).scalar() == D("123.45")
    db.execute(
        text(
            "UPDATE account_balances SET balance_in_account_currency=555,balance_source='manual',account_currency='AUD'"
        )
    )
    assert (
        db.execute(text("SELECT count(*) FROM account_balance_revisions")).scalar() == 2
    )
    # Recovery restores original values from the revision while retaining both
    # the post-upgrade write and its audit revision. No destructive down migration.
    db.execute(
        text(
            "UPDATE account_balances SET balance_in_account_currency=(SELECT (snapshot->>'balance_in_account_currency')::numeric FROM account_balance_revisions ORDER BY id LIMIT 1), balance_source='legacy',account_currency=NULL"
        )
    )
    assert db.execute(
        text("SELECT balance_in_account_currency FROM account_balances")
    ).scalar() == D("123.45")
    assert (
        db.execute(text("SELECT count(*) FROM account_balance_revisions")).scalar() == 3
    )
