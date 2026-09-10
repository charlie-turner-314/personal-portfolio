"""PPF-48 cash/statement reconciliation and AMIT cost-base integration tests."""
from datetime import datetime
from decimal import Decimal
import uuid

import pytest

from app.database import Base, engine
from app.models import (
    Account,
    BrokerTrade,
    CgtAllocation,
    Holding,
    InvestmentActivity,
    InvestmentCostBaseAdjustment,
    InvestmentIncomeEnrichment,
    InvestmentIncomeEvent,
    InvestmentIngestionRun,
    InvestmentReconciliationItem,
    InvestmentSourceRecord,
    Transaction,
    User,
)
from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    apply_batch,
    revert_run,
)
from app.services.investment_income_reconciliation_service import resolve_reconciliation_item


@pytest.fixture(scope="module", autouse=True)
def reconciliation_tables():
    Base.metadata.create_all(bind=engine)


@pytest.fixture
def accounts(db_session):
    user = User(
        id=f"income-reconcile-{uuid.uuid4()}",
        email=f"{uuid.uuid4()}@income-reconcile.test",
        functional_currency="AUD",
    )
    investment = Account(
        user_id=user.id,
        name="ETF account",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    bank = Account(
        user_id=user.id,
        name="Cash account",
        account_type="checking",
        currency="AUD",
        is_active=True,
    )
    db_session.add_all([user, investment, bank])
    db_session.commit()
    yield user, investment, bank

    account_ids = [investment.id, bank.id]
    db_session.query(InvestmentReconciliationItem).filter(InvestmentReconciliationItem.user_id == user.id).delete()
    db_session.query(InvestmentCostBaseAdjustment).filter(InvestmentCostBaseAdjustment.user_id == user.id).delete()
    db_session.query(InvestmentIncomeEnrichment).filter(InvestmentIncomeEnrichment.user_id == user.id).delete()
    db_session.query(InvestmentActivity).filter(InvestmentActivity.user_id == user.id).delete()
    db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.user_id == user.id).delete()
    db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.user_id == user.id).delete()
    db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.user_id == user.id).delete()
    db_session.query(BrokerTrade).filter(BrokerTrade.account_id.in_(account_ids)).delete()
    db_session.query(Holding).filter(Holding.user_id == user.id).delete()
    db_session.query(Transaction).filter(Transaction.user_id == user.id).delete()
    db_session.query(Account).filter(Account.id.in_(account_ids)).delete()
    db_session.delete(user)
    db_session.commit()


def _batch(provider: str, *records: tuple[str, CanonicalActivityInput]) -> InvestmentActivityBatch:
    return InvestmentActivityBatch(
        provider=provider,
        ingestion_type="csv_import",
        source_name=f"{provider}.csv",
        records=tuple(
            SourceRecordEnvelope(
                occurred_at=activity.occurred_at,
                provider_record_id=reference,
                raw_payload={"reference": reference},
                activities=(activity,),
            )
            for reference, activity in records
        ),
    )


def _buy(reference="buy-1"):
    return reference, CanonicalActivityInput(
        activity_type="buy",
        occurred_at=datetime(2024, 7, 1),
        asset_symbol="VAS",
        asset_type="fund",
        quantity="10",
        price="100",
        currency="AUD",
    )


def _cash_distribution(reference="cash-1", *, metadata=None):
    return reference, CanonicalActivityInput(
        activity_type="distribution",
        occurred_at=datetime(2025, 6, 30),
        asset_symbol="VAS",
        asset_type="fund",
        gross_amount="50",
        net_amount="50",
        currency="AUD",
        metadata=metadata or {},
    )


def _annual_statement(reference="amma-1", **overrides):
    metadata = {
        "income_data_kind": "annual_statement",
        "is_annual_statement": True,
        "franked_amount": "30",
        "unfranked_amount": "20",
        "franking_credit": "12.86",
        "foreign_income": "4",
        "foreign_tax_paid": "0.60",
        "tfn_withholding": "1.25",
        "amit_amma_components": {"capital_gains_discounted": "8"},
        "cost_base_increase": "100",
        "cost_base_decrease": "0",
        "cost_base_effective_date": "2025-06-30",
        "annual_statement_reference": "AMMA-2025",
        **overrides,
    }
    return reference, CanonicalActivityInput(
        activity_type="distribution",
        occurred_at=datetime(2025, 6, 30),
        asset_symbol="VAS",
        asset_type="fund",
        gross_amount="50",
        net_amount="50",
        currency="AUD",
        metadata=metadata,
    )


def test_cash_distribution_links_one_bank_credit_without_creating_duplicate_income(
    db_session, accounts
):
    user, investment, bank = accounts
    credit = Transaction(
        user_id=user.id,
        account_id=bank.id,
        external_id="distribution-credit",
        transaction_type="credit",
        amount=Decimal("50"),
        currency="AUD",
        description="VAS distribution",
        booked_at=datetime(2025, 6, 30, 9),
        pending=False,
    )
    db_session.add(credit)
    db_session.commit()

    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch("cash_broker", _buy(), _cash_distribution()),
    )

    event = db_session.query(InvestmentIncomeEvent).filter_by(account_id=investment.id).one()
    assert event.matched_transaction_id == credit.id
    assert event.reconciliation_status == "provisional"
    assert db_session.query(InvestmentReconciliationItem).filter_by(account_id=investment.id).count() == 0


def test_annual_statement_enriches_idempotently_and_adjusts_fifo_cgt_then_reverts(
    db_session, accounts
):
    user, investment, _ = accounts
    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch("cash_broker", _buy(), _cash_distribution()),
    )
    annual = _batch("fund_statement", _annual_statement())
    result = apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=annual,
    )
    duplicate = apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=annual,
    )

    assert duplicate["inserted_activities"] == 0
    assert db_session.query(InvestmentIncomeEvent).filter_by(account_id=investment.id).count() == 1
    event = db_session.query(InvestmentIncomeEvent).filter_by(account_id=investment.id).one()
    assert event.reconciliation_status == "confirmed"
    assert event.franked_amount == Decimal("30.00")
    assert event.tfn_withholding == Decimal("1.25")
    assert event.amit_amma_components == {"capital_gains_discounted": "8"}
    assert event.annual_statement_reference == "AMMA-2025"
    assert len(event.component_sources["franking_credit"]) == 1
    adjustment = db_session.query(InvestmentCostBaseAdjustment).filter_by(account_id=investment.id).one()
    assert adjustment.amount_native == Decimal("100.00000000")
    holding = db_session.query(Holding).filter_by(account_id=investment.id, symbol="VAS").one()
    assert holding.avg_cost == Decimal("110.00000000")

    sell = CanonicalActivityInput(
        activity_type="sell",
        occurred_at=datetime(2025, 7, 10),
        asset_symbol="VAS",
        asset_type="fund",
        quantity="5",
        price="120",
        currency="AUD",
    )
    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch("cash_broker", ("sell-1", sell)),
    )
    allocation = db_session.query(CgtAllocation).filter_by(account_id=investment.id).one()
    assert allocation.cost_base_native == Decimal("550.00000000")
    assert allocation.cost_base_adjustment_native == Decimal("50.00000000")
    assert allocation.cost_base_adjustment_aud == Decimal("50.00000000")
    assert allocation.adjustment_ids == [str(adjustment.id)]

    reverted = revert_run(db_session, user_id=user.id, run_id=result["run_id"])
    assert reverted["removed_income_events"] == 0
    assert reverted["removed_income_enrichments"] == 1
    assert reverted["removed_cost_base_adjustments"] == 1
    db_session.refresh(event)
    assert event.franked_amount is None
    assert event.reconciliation_status == "provisional"
    allocation = db_session.query(CgtAllocation).filter_by(account_id=investment.id).one()
    assert allocation.cost_base_native == Decimal("500.00000000")
    assert allocation.cost_base_adjustment_native == Decimal("0E-8")


def test_statement_conflict_never_overwrites_user_confirmed_value(db_session, accounts):
    user, investment, _ = accounts
    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch(
            "cash_broker",
            _buy(),
            _cash_distribution(metadata={"franked_amount": "25"}),
        ),
    )
    event = db_session.query(InvestmentIncomeEvent).filter_by(account_id=investment.id).one()
    event.reconciliation_status = "confirmed"
    event.user_confirmed_at = datetime.utcnow()
    db_session.commit()

    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch(
            "fund_statement",
            _annual_statement(cost_base_increase="0", franked_amount="30"),
        ),
    )

    db_session.refresh(event)
    assert event.franked_amount == Decimal("25.00")
    assert event.reconciliation_status == "conflict"
    item = db_session.query(InvestmentReconciliationItem).filter_by(
        account_id=investment.id,
        kind="component_conflict",
    ).one()
    assert item.status == "pending"
    assert item.details["conflicts"]["franked_amount"] == {
        "existing": "25.00",
        "statement": "30",
    }

    resolve_reconciliation_item(
        db_session,
        user_id=user.id,
        item_id=item.id,
        action="apply_statement",
    )
    db_session.refresh(event)
    assert event.franked_amount == Decimal("30.00")
    assert event.reconciliation_status == "confirmed"
    assert event.user_confirmed_at is not None
    assert event.component_sources["franked_amount"][-1]["kind"] == "user_resolution"


def test_unmatched_statement_is_reviewed_and_does_not_create_cash_income(db_session, accounts):
    user, investment, _ = accounts
    db_session.add(Holding(
        user_id=user.id,
        account_id=investment.id,
        symbol="VAS",
        currency="AUD",
        instrument_type="etf",
        quantity=Decimal("10"),
        avg_cost=Decimal("100"),
        source="manual",
    ))
    db_session.commit()

    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch("fund_statement", _annual_statement(cost_base_increase="0")),
    )

    assert db_session.query(InvestmentIncomeEvent).filter_by(account_id=investment.id).count() == 0
    item = db_session.query(InvestmentReconciliationItem).filter_by(
        account_id=investment.id,
        kind="annual_statement",
    ).one()
    assert item.status == "pending"


def test_drp_retains_income_and_links_reinvestment_trade(db_session, accounts):
    user, investment, _ = accounts
    drp = CanonicalActivityInput(
        activity_type="drp",
        occurred_at=datetime(2025, 6, 30),
        asset_symbol="VAS",
        asset_type="fund",
        quantity="1.25",
        price="40",
        gross_amount="50",
        currency="AUD",
    )
    apply_batch(
        db_session,
        user_id=user.id,
        account_id=investment.id,
        batch=_batch("cash_broker", _buy(), ("drp-1", drp)),
    )

    event = db_session.query(InvestmentIncomeEvent).filter_by(account_id=investment.id).one()
    trade = db_session.query(BrokerTrade).filter_by(id=event.reinvestment_trade_id).one()
    assert event.is_drp is True
    assert event.cash_received == Decimal("50.00")
    assert trade.side == "buy"
    assert trade.quantity == Decimal("1.25000000")
