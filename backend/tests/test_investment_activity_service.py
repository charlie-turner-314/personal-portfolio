from datetime import datetime, timedelta
from decimal import Decimal
import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError

from app.database import Base, engine
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
from app.services import investment_activity_service as service
from app.services.investment_activity_service import (
    ActivityApplicationError,
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    apply_batch,
    source_record_view,
)


@pytest.fixture(scope="module", autouse=True)
def ingestion_tables():
    # Existing development databases predate PPF-45. Creating only missing
    # tables lets service tests run before the migration smoke test.
    Base.metadata.create_all(bind=engine)


@pytest.fixture
def investment_account(db_session):
    user = User(
        id=f"activity-user-{uuid.uuid4()}",
        email=f"{uuid.uuid4()}@activity.test",
        functional_currency="AUD",
    )
    db_session.add(user)
    db_session.flush()
    account = Account(
        user_id=user.id,
        name="Activity Test Account",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    db_session.add(account)
    db_session.commit()

    yield user, account

    db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).delete()
    db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).delete()
    db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.account_id == account.id).delete()
    db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).delete()
    db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).delete()
    db_session.query(Holding).filter(Holding.account_id == account.id).delete()
    db_session.delete(account)
    db_session.delete(user)
    db_session.commit()


def _batch(provider: str = "example_broker") -> InvestmentActivityBatch:
    bought_at = datetime(2025, 7, 1, 10, 15)
    paid_at = bought_at + timedelta(days=30)
    return InvestmentActivityBatch(
        provider=provider,
        ingestion_type="csv_import",
        source_name="sanitized.csv",
        records=(
            SourceRecordEnvelope(
                occurred_at=bought_at,
                provider_record_id="trade-1",
                raw_payload={"trade_id": "trade-1", "api_secret": "must-not-persist"},
                activities=(
                    CanonicalActivityInput(
                        activity_type="buy",
                        occurred_at=bought_at,
                        asset_symbol="vas",
                        asset_name="Vanguard Australian Shares",
                        asset_type="equity",
                        quantity="10",
                        price="100",
                        currency="aud",
                        fee_amount="9.50",
                        fee_currency="aud",
                    ),
                ),
            ),
            SourceRecordEnvelope(
                occurred_at=paid_at,
                provider_record_id="income-1",
                raw_payload={"income_id": "income-1", "gross": "20"},
                activities=(
                    CanonicalActivityInput(
                        activity_type="dividend",
                        occurred_at=paid_at,
                        asset_symbol="VAS",
                        asset_type="equity",
                        gross_amount="20",
                        net_amount="20",
                        currency="AUD",
                        metadata={"franked_amount": "14", "franking_credit": "6"},
                    ),
                ),
            ),
        ),
    )


def test_apply_batch_writes_provenance_and_existing_domain_records_atomically(
    db_session, investment_account
):
    user, account = investment_account

    result = apply_batch(
        db_session,
        user_id=user.id,
        account_id=account.id,
        batch=_batch(),
    )

    assert result == {
        "run_id": result["run_id"],
        "status": "completed",
        "source_records": 2,
        "inserted_records": 2,
        "skipped_duplicate_records": 0,
        "inserted_activities": 2,
        "affected_symbols": ["VAS"],
    }
    source = (
        db_session.query(InvestmentSourceRecord)
        .filter(InvestmentSourceRecord.account_id == account.id, InvestmentSourceRecord.provider_record_id == "trade-1")
        .one()
    )
    assert source.source_payload["api_secret"] == "[REDACTED]"
    assert source.payload_hash
    assert source_record_view(source)["source_payload"]["api_secret"] == "[REDACTED]"

    trade = db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).one()
    assert trade.symbol == "VAS"
    assert trade.fees == Decimal("9.50000000")
    holding = db_session.query(Holding).filter(Holding.account_id == account.id, Holding.symbol == "VAS").one()
    assert holding.quantity == Decimal("10.00000000")
    income = db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).one()
    assert income.cash_received == Decimal("20.00")
    assert income.franking_credit == Decimal("6.00")

    activities = db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).all()
    assert len(activities) == 2
    assert all(activity.applied_at is not None for activity in activities)
    assert {activity.broker_trade_id is not None for activity in activities} == {False, True}
    assert {activity.income_event_id is not None for activity in activities} == {False, True}


def test_reimport_is_deterministically_idempotent(db_session, investment_account):
    user, account = investment_account
    first = apply_batch(db_session, user_id=user.id, account_id=account.id, batch=_batch())
    second = apply_batch(db_session, user_id=user.id, account_id=account.id, batch=_batch())

    assert first["inserted_records"] == 2
    assert second["inserted_records"] == 0
    assert second["skipped_duplicate_records"] == 2
    assert second["inserted_activities"] == 0
    assert db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).count() == 2
    assert db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).count() == 2
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 1
    assert db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).count() == 1
    assert db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.account_id == account.id).count() == 2


def test_downstream_failure_rolls_back_all_economic_and_source_records(
    monkeypatch, db_session, investment_account
):
    user, account = investment_account

    def fail_income(*args, **kwargs):
        raise RuntimeError("provider token=super-secret failed after trade")

    monkeypatch.setattr(service, "_apply_income_activity", fail_income)

    with pytest.raises(ActivityApplicationError, match="failed atomically") as exc_info:
        apply_batch(
            db_session,
            user_id=user.id,
            account_id=account.id,
            batch=_batch(provider="failing_broker"),
        )

    assert exc_info.value.run_id is not None
    assert db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).count() == 0
    assert db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).count() == 0
    assert db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).count() == 0
    assert db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).count() == 0
    assert db_session.query(Holding).filter(Holding.account_id == account.id).count() == 0

    run = db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.id == exc_info.value.run_id).one()
    assert run.status == "failed"
    assert "super-secret" not in run.error
    assert "[REDACTED]" in run.error


def test_same_provider_reference_is_independent_per_account(db_session, investment_account):
    user, first_account = investment_account
    second_account = Account(
        user_id=user.id,
        name="Second Activity Account",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    db_session.add(second_account)
    db_session.commit()
    try:
        first = apply_batch(db_session, user_id=user.id, account_id=first_account.id, batch=_batch())
        second = apply_batch(db_session, user_id=user.id, account_id=second_account.id, batch=_batch())
        assert first["inserted_records"] == 2
        assert second["inserted_records"] == 2
    finally:
        db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == second_account.id).delete()
        db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == second_account.id).delete()
        db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.account_id == second_account.id).delete()
        db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == second_account.id).delete()
        db_session.query(BrokerTrade).filter(BrokerTrade.account_id == second_account.id).delete()
        db_session.query(Holding).filter(Holding.account_id == second_account.id).delete()
        db_session.delete(second_account)
        db_session.commit()


def test_persisted_source_payload_cannot_be_modified(db_session, investment_account):
    user, account = investment_account
    apply_batch(db_session, user_id=user.id, account_id=account.id, batch=_batch())
    source = (
        db_session.query(InvestmentSourceRecord)
        .filter(InvestmentSourceRecord.account_id == account.id)
        .first()
    )

    with pytest.raises(DBAPIError, match="investment source records are immutable"):
        db_session.execute(
            update(InvestmentSourceRecord)
            .where(InvestmentSourceRecord.id == source.id)
            .values(source_payload={"tampered": True})
        )
        db_session.flush()
    db_session.rollback()

    preserved = db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.id == source.id).one()
    assert preserved.source_payload != {"tampered": True}
