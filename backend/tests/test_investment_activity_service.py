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
    InvestmentReconciliationItem,
    InvestmentSourceRecord,
    Transaction,
    User,
)
from app.services import investment_activity_service as service
from app.services.investment_activity_service import (
    ActivityApplicationError,
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    apply_batch,
    revert_run,
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


def test_later_api_source_does_not_duplicate_equivalent_csv_activity(
    db_session, investment_account
):
    user, account = investment_account
    csv = _batch(provider="statement_csv")
    api = InvestmentActivityBatch(
        provider="statement_csv",
        ingestion_type="api_sync",
        source_name="automatic sync",
        records=tuple(
            SourceRecordEnvelope(
                occurred_at=record.occurred_at + timedelta(seconds=30),
                provider_record_id=f"api-{record.provider_record_id}",
                raw_payload={"api_id": f"api-{record.provider_record_id}"},
                activities=tuple(
                    service.replace(activity, occurred_at=activity.occurred_at + timedelta(seconds=30))
                    for activity in record.activities
                ),
            )
            for record in csv.records
        ),
    )

    first = apply_batch(db_session, user_id=user.id, account_id=account.id, batch=csv)
    second = apply_batch(db_session, user_id=user.id, account_id=account.id, batch=api)

    assert first["inserted_activities"] == 2
    assert second["inserted_activities"] == 0
    assert second["skipped_duplicate_records"] == 2
    assert second["skipped_cross_source_records"] == 2
    assert db_session.query(InvestmentActivity).filter_by(account_id=account.id).count() == 2
    observations = [
        item for item in db_session.query(InvestmentSourceRecord).filter_by(
            account_id=account.id, provider="statement_csv"
        ).all()
        if "cross_source_duplicate_of_source_record_id" in item.source_metadata
    ]
    assert len(observations) == 2
    assert all(
        item.source_metadata["cross_source_duplicate_of_source_record_id"]
        for item in observations
    )


def test_cross_source_dedupe_claims_an_existing_record_only_once_per_batch(
    db_session, investment_account
):
    user, account = investment_account
    csv_record = _batch(provider="statement_csv").records[0]
    csv = InvestmentActivityBatch(
        provider="statement_csv",
        ingestion_type="csv_import",
        source_name="statement.csv",
        records=(csv_record,),
    )
    api_records = tuple(
        SourceRecordEnvelope(
            occurred_at=csv_record.occurred_at + timedelta(seconds=30),
            provider_record_id=f"api-fill-{index}",
            raw_payload={"api_id": f"api-fill-{index}"},
            activities=tuple(
                service.replace(
                    activity,
                    occurred_at=activity.occurred_at + timedelta(seconds=30),
                )
                for activity in csv_record.activities
            ),
        )
        for index in range(2)
    )
    api = InvestmentActivityBatch(
        provider="statement_csv",
        ingestion_type="api_sync",
        source_name="automatic sync",
        records=api_records,
    )

    apply_batch(db_session, user_id=user.id, account_id=account.id, batch=csv)
    result = apply_batch(db_session, user_id=user.id, account_id=account.id, batch=api)

    assert result["inserted_records"] == 1
    assert result["inserted_activities"] == 1
    assert result["skipped_duplicate_records"] == 1
    assert result["skipped_cross_source_records"] == 1
    assert db_session.query(BrokerTrade).filter_by(account_id=account.id).count() == 2
    holding = db_session.query(Holding).filter_by(
        account_id=account.id,
        symbol="VAS",
    ).one()
    assert holding.quantity == Decimal("20.00000000")


def test_brokerage_cash_deposit_reconciles_to_owned_bank_debit(
    db_session, investment_account
):
    user, investment = investment_account
    bank = Account(
        user_id=user.id,
        name="Owned Bank",
        account_type="checking",
        currency="AUD",
        is_active=True,
    )
    debit = Transaction(
        user_id=user.id,
        account=bank,
        external_id="broker-funding",
        transaction_type="debit",
        amount=Decimal("-1000"),
        currency="AUD",
        booked_at=datetime(2025, 8, 4, 9),
        pending=False,
    )
    db_session.add_all([bank, debit])
    db_session.flush()
    batch = InvestmentActivityBatch(
        provider="broker_cash_csv",
        ingestion_type="csv_import",
        records=(SourceRecordEnvelope(
            occurred_at=datetime(2025, 8, 4, 10),
            provider_record_id="deposit-1",
            raw_payload={"reference": "deposit-1"},
            activities=(CanonicalActivityInput(
                activity_type="deposit",
                occurred_at=datetime(2025, 8, 4, 10),
                asset_symbol="AUD",
                asset_type="cash",
                quantity="1000",
                currency="AUD",
                direction="in",
            ),),
        ),),
    )

    apply_batch(db_session, user_id=user.id, account_id=investment.id, batch=batch)

    item = db_session.query(InvestmentReconciliationItem).filter_by(
        account_id=investment.id
    ).one()
    assert item.status == "resolved"
    assert item.details["workflow"] == "investment_cash_transfer"
    assert item.details["confidence"] == "high"
    assert item.resolution["transaction_id"] == str(debit.id)


def test_reverting_one_cash_transfer_side_reopens_the_surviving_match(
    db_session, investment_account
):
    user, source = investment_account
    destination = Account(
        user_id=user.id,
        name="Second Investment Account",
        account_type="investment_manual",
        currency="AUD",
        is_active=True,
    )
    db_session.add(destination)
    db_session.flush()
    moved_at = datetime(2025, 8, 4, 10)

    def cash_batch(reference: str, activity_type: str, direction: str):
        return InvestmentActivityBatch(
            provider="cash_transfer_csv",
            ingestion_type="csv_import",
            records=(SourceRecordEnvelope(
                occurred_at=moved_at,
                provider_record_id=reference,
                raw_payload={"reference": reference},
                activities=(CanonicalActivityInput(
                    activity_type=activity_type,
                    occurred_at=moved_at,
                    asset_symbol="AUD",
                    asset_type="cash",
                    quantity="1000",
                    currency="AUD",
                    direction=direction,
                ),),
            ),),
        )

    apply_batch(
        db_session,
        user_id=user.id,
        account_id=source.id,
        batch=cash_batch("cash-out", "withdrawal", "out"),
    )
    inbound_run = apply_batch(
        db_session,
        user_id=user.id,
        account_id=destination.id,
        batch=cash_batch("cash-in", "deposit", "in"),
    )
    surviving_activity = db_session.query(InvestmentActivity).filter_by(
        account_id=source.id,
        activity_type="withdrawal",
    ).one()
    surviving_item = db_session.query(InvestmentReconciliationItem).filter_by(
        source_activity_id=surviving_activity.id,
        kind="cash_match",
    ).one()
    assert surviving_item.status == "resolved"

    revert_run(
        db_session,
        user_id=user.id,
        run_id=inbound_run["run_id"],
    )

    db_session.refresh(surviving_item)
    assert surviving_item.status == "pending"
    assert surviving_item.resolution is None
    assert surviving_item.resolved_at is None
    assert surviving_item.details["candidate_activity_ids"] == []
    assert "reverted" in surviving_item.reason.lower()


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
