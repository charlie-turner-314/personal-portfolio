from datetime import datetime, timedelta
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
    InvestmentCryptoTransfer,
    InvestmentCryptoTransferLot,
    InvestmentIncomeEvent,
    User,
)
from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    apply_batch,
    revert_run,
)
from app.services.tax_report_service import build_australian_tax_report


@pytest.fixture(scope="module", autouse=True)
def crypto_accounting_tables():
    Base.metadata.create_all(bind=engine)


@pytest.fixture
def crypto_accounts(db_session):
    user = User(
        id=f"crypto-user-{uuid.uuid4()}",
        email=f"{uuid.uuid4()}@crypto.test",
        functional_currency="AUD",
    )
    source = Account(
        user_id=user.id,
        name="Source Exchange",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    destination = Account(
        user_id=user.id,
        name="Owned Wallet",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    db_session.add_all([user, source, destination])
    db_session.flush()
    return user, source, destination


def _apply(
    db_session,
    *,
    user: User,
    account: Account,
    reference: str,
    activity: CanonicalActivityInput,
):
    return apply_batch(
        db_session,
        user_id=user.id,
        account_id=account.id,
        batch=InvestmentActivityBatch(
            provider="crypto_fixture",
            ingestion_type="csv_import",
            source_name="sanitized-crypto.csv",
            records=(SourceRecordEnvelope(
                occurred_at=activity.occurred_at,
                provider_record_id=reference,
                raw_payload={"reference": reference},
                activities=(activity,),
            ),),
        ),
        commit=False,
    )


def _activity(
    activity_type: str,
    occurred_at: datetime,
    symbol: str,
    *,
    quantity: str,
    price: str | None = None,
    currency: str | None = "AUD",
    **kwargs,
) -> CanonicalActivityInput:
    return CanonicalActivityInput(
        activity_type=activity_type,
        occurred_at=occurred_at,
        asset_symbol=symbol,
        asset_type="crypto",
        quantity=quantity,
        price=price,
        currency=currency,
        **kwargs,
    )


def _holding(db_session, account: Account, symbol: str) -> Holding:
    return db_session.query(Holding).filter(
        Holding.account_id == account.id,
        Holding.symbol == symbol,
        Holding.instrument_type == "crypto",
    ).one()


def test_crypto_swap_creates_linked_disposal_and_acquisition_with_cgt(
    db_session, crypto_accounts
):
    user, account, _ = crypto_accounts
    bought_at = datetime(2025, 1, 2, 9, 30)
    swapped_at = datetime(2025, 2, 3, 14, 45)
    _apply(
        db_session,
        user=user,
        account=account,
        reference="btc-buy",
        activity=_activity("buy", bought_at, "BTC", quantity="2", price="10000"),
    )
    _apply(
        db_session,
        user=user,
        account=account,
        reference="btc-eth-swap",
        activity=_activity(
            "crypto_swap",
            swapped_at,
            "BTC",
            quantity="1",
            price=None,
            currency=None,
            counter_asset_symbol="ETH",
            counter_quantity="10",
            aud_value="15000",
            valuation_source="exchange_execution_report",
            valuation_timestamp=swapped_at,
            external_group_id="swap-order-7",
        ),
    )

    assert _holding(db_session, account, "BTC").quantity == Decimal("1.00000000")
    assert _holding(db_session, account, "ETH").quantity == Decimal("10.00000000")
    swap_legs = db_session.query(BrokerTrade).filter(
        BrokerTrade.account_id == account.id,
        BrokerTrade.event_group_id == "swap-order-7",
    ).order_by(BrokerTrade.economic_type).all()
    assert {row.economic_type for row in swap_legs} == {"swap_acquisition", "swap_disposal"}
    assert {row.aud_value for row in swap_legs} == {Decimal("15000.000000000000000000")}

    allocation = db_session.query(CgtAllocation).filter(
        CgtAllocation.account_id == account.id,
        CgtAllocation.symbol == "BTC",
    ).one()
    assert allocation.cost_base_aud == Decimal("10000.00000000")
    assert allocation.proceeds_aud == Decimal("15000.00000000")
    assert allocation.gain_aud == Decimal("5000.00000000")
    assert allocation.disposal_economic_type == "swap_disposal"
    assert allocation.disposal_valuation_source == "exchange_execution_report"


def test_rewards_are_separate_income_and_missing_values_remain_explicit(
    db_session, crypto_accounts
):
    user, account, _ = crypto_accounts
    received_at = datetime(2025, 8, 1, 11, 0)
    _apply(
        db_session,
        user=user,
        account=account,
        reference="eth-stake-1",
        activity=_activity(
            "staking_reward",
            received_at,
            "ETH",
            quantity="0.5",
            price=None,
            currency=None,
            aud_value="1000",
            valuation_source="exchange_spot_price",
            valuation_timestamp=received_at,
        ),
    )
    _apply(
        db_session,
        user=user,
        account=account,
        reference="sol-airdrop-missing",
        activity=_activity(
            "airdrop",
            received_at + timedelta(hours=1),
            "SOL",
            quantity="3",
            price=None,
            currency=None,
        ),
    )
    _apply(
        db_session,
        user=user,
        account=account,
        reference="eth-earn-interest",
        activity=_activity(
            "interest",
            received_at + timedelta(hours=2),
            "ETH",
            quantity="0.1",
            price="2200",
            currency="AUD",
        ),
    )

    income = db_session.query(InvestmentIncomeEvent).filter(
        InvestmentIncomeEvent.account_id == account.id
    ).order_by(InvestmentIncomeEvent.event_type).all()
    assert [(row.event_type, row.asset_quantity) for row in income] == [
        ("airdrop", Decimal("3.000000000000000000")),
        ("interest", Decimal("0.100000000000000000")),
        ("staking_reward", Decimal("0.500000000000000000")),
    ]
    staking = next(row for row in income if row.event_type == "staking_reward")
    assert staking.aud_market_value == Decimal("1000.000000000000000000")
    assert staking.reconciliation_status == "confirmed"
    airdrop = next(row for row in income if row.event_type == "airdrop")
    assert airdrop.aud_market_value is None
    assert airdrop.valuation_missing is True
    assert airdrop.reconciliation_status == "provisional"
    interest = next(row for row in income if row.event_type == "interest")
    assert interest.aud_market_value == Decimal("220.000000000000000000")
    assert interest.valuation_source == "reported_aud_price"
    assert _holding(db_session, account, "ETH").quantity == Decimal("0.60000000")
    assert _holding(db_session, account, "SOL").quantity == Decimal("3.00000000")
    report = build_australian_tax_report(db_session, user.id, 2025)
    assert report["investment_income"]["crypto_ordinary_income_aud"] == "1220.000000000000000000"
    assert report["investment_income"]["crypto_missing_valuation_source_ids"] == [
        str(airdrop.id)
    ]


def test_swap_without_market_value_updates_units_but_not_tax_totals(
    db_session, crypto_accounts
):
    user, account, _ = crypto_accounts
    bought_at = datetime(2025, 5, 1, 9, 0)
    swapped_at = bought_at + timedelta(days=1)
    _apply(
        db_session, user=user, account=account, reference="missing-swap-seed",
        activity=_activity("buy", bought_at, "BTC", quantity="1", price="10000"),
    )
    _apply(
        db_session, user=user, account=account, reference="missing-swap",
        activity=_activity(
            "crypto_swap", swapped_at, "BTC", quantity="0.25", price=None,
            currency=None, counter_asset_symbol="ETH", counter_quantity="2",
        ),
    )

    assert _holding(db_session, account, "BTC").quantity == Decimal("0.75000000")
    eth = _holding(db_session, account, "ETH")
    assert eth.quantity == Decimal("2.00000000")
    assert eth.avg_cost is None
    allocation = db_session.query(CgtAllocation).filter(
        CgtAllocation.account_id == account.id,
        CgtAllocation.symbol == "BTC",
    ).one()
    assert allocation.fx_missing is True
    assert allocation.cost_base_aud is None
    assert allocation.proceeds_aud is None
    assert allocation.gain_aud is None


def test_fiat_and_crypto_fees_affect_the_correct_asset_and_remain_auditable(
    db_session, crypto_accounts
):
    user, account, _ = crypto_accounts
    bought_at = datetime(2025, 3, 1, 8, 0)
    _apply(
        db_session,
        user=user,
        account=account,
        reference="btc-seed",
        activity=_activity("buy", bought_at, "BTC", quantity="1", price="10000"),
    )
    _apply(
        db_session,
        user=user,
        account=account,
        reference="eth-buy-fees",
        activity=_activity(
            "buy",
            bought_at + timedelta(days=1),
            "ETH",
            quantity="1",
            price="2000",
            fee_amount="10",
            fee_currency="AUD",
        ),
    )
    fee_at = bought_at + timedelta(days=2)
    _apply(
        db_session,
        user=user,
        account=account,
        reference="eth-buy-btc-fee",
        activity=_activity(
            "buy",
            fee_at,
            "ETH",
            quantity="1",
            price="2100",
            fee_amount="0.01",
            fee_currency="BTC",
            fee_aud_value="100",
            fee_valuation_source="exchange_execution_report",
            fee_valuation_timestamp=fee_at,
        ),
    )

    assert _holding(db_session, account, "BTC").quantity == Decimal("0.99000000")
    assert _holding(db_session, account, "ETH").quantity == Decimal("2.00000000")
    eth_buys = db_session.query(BrokerTrade).filter(
        BrokerTrade.account_id == account.id,
        BrokerTrade.symbol == "ETH",
        BrokerTrade.side == "buy",
    ).order_by(BrokerTrade.occurred_at).all()
    assert eth_buys[0].fees == Decimal("10.00000000")
    fee_trade = db_session.query(BrokerTrade).filter(
        BrokerTrade.account_id == account.id,
        BrokerTrade.economic_type == "network_fee",
    ).one()
    assert fee_trade.symbol == "BTC"
    assert fee_trade.aud_value == Decimal("100.000000000000000000")
    fee_cgt = db_session.query(CgtAllocation).filter(
        CgtAllocation.disposal_trade_id == fee_trade.id
    ).one()
    assert fee_cgt.disposal_economic_type == "network_fee"


def test_owned_account_transfer_preserves_partial_fifo_lots_and_original_dates(
    db_session, crypto_accounts
):
    user, source, destination = crypto_accounts
    first_at = datetime(2024, 1, 1, 9, 0)
    second_at = datetime(2024, 2, 1, 9, 0)
    transfer_at = datetime(2025, 1, 5, 12, 0)
    _apply(
        db_session, user=user, account=source, reference="lot-1",
        activity=_activity("buy", first_at, "BTC", quantity="1", price="10000"),
    )
    _apply(
        db_session, user=user, account=source, reference="lot-2",
        activity=_activity("buy", second_at, "BTC", quantity="2", price="20000"),
    )
    outbound_run = _apply(
        db_session, user=user, account=source, reference="wallet-out",
        activity=_activity(
            "withdrawal", transfer_at, "BTC", quantity="1.5", price=None,
            currency=None, external_group_id="chain-tx-1",
        ),
    )
    assert outbound_run["pending_transfers"] == 1
    _apply(
        db_session, user=user, account=destination, reference="wallet-in",
        activity=_activity(
            "deposit", transfer_at + timedelta(minutes=15), "BTC", quantity="1.5",
            price=None, currency=None, external_group_id="chain-tx-1",
        ),
    )

    assert _holding(db_session, source, "BTC").quantity == Decimal("1.50000000")
    assert _holding(db_session, destination, "BTC").quantity == Decimal("1.50000000")
    transfer_rows = db_session.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.user_id == user.id
    ).all()
    assert {row.status for row in transfer_rows} == {"matched"}
    assert {row.match_method for row in transfer_rows} == {"transaction_hash"}
    carried = db_session.query(InvestmentCryptoTransferLot).order_by(
        InvestmentCryptoTransferLot.acquisition_date
    ).all()
    assert [(row.quantity, row.acquisition_date, row.cost_base_aud) for row in carried] == [
        (Decimal("1.000000000000000000"), first_at.date(), Decimal("10000.000000000000000000")),
        (Decimal("0.500000000000000000"), second_at.date(), Decimal("10000.000000000000000000")),
    ]
    assert db_session.query(CgtAllocation).filter(
        CgtAllocation.account_id == source.id
    ).count() == 0
    report = build_australian_tax_report(db_session, user.id, 2024)
    assert len(report["crypto_transfers"]["rows"]) == 2
    assert report["crypto_transfers"]["unresolved_source_ids"] == []

    sold_at = datetime(2025, 3, 1, 10, 0)
    _apply(
        db_session, user=user, account=destination, reference="wallet-sale",
        activity=_activity("sell", sold_at, "BTC", quantity="1.5", price="20000"),
    )
    allocations = db_session.query(CgtAllocation).filter(
        CgtAllocation.account_id == destination.id
    ).order_by(CgtAllocation.acquisition_date).all()
    assert [row.acquisition_date for row in allocations] == [first_at.date(), second_at.date()]
    assert sum((row.cost_base_aud for row in allocations), Decimal("0")) == Decimal("20000.00000000")
    assert sum((row.gain_aud for row in allocations), Decimal("0")) == Decimal("10000.00000000")


def test_transfer_rebuild_is_deterministic_after_backfill(db_session, crypto_accounts):
    user, source, destination = crypto_accounts
    later_buy = datetime(2025, 1, 2, 9, 0)
    transfer_at = datetime(2025, 1, 3, 12, 0)
    _apply(
        db_session, user=user, account=source, reference="later-lot",
        activity=_activity("buy", later_buy, "BTC", quantity="2", price="20000"),
    )
    _apply(
        db_session, user=user, account=source, reference="transfer-out",
        activity=_activity(
            "withdrawal", transfer_at, "BTC", quantity="1", price=None,
            currency=None, external_group_id="backfill-chain-tx",
        ),
    )
    _apply(
        db_session, user=user, account=destination, reference="transfer-in",
        activity=_activity(
            "deposit", transfer_at + timedelta(minutes=5), "BTC", quantity="1",
            price=None, currency=None, external_group_id="backfill-chain-tx",
        ),
    )
    assert _holding(db_session, destination, "BTC").avg_cost == Decimal("20000.00000000")

    earlier_buy = datetime(2025, 1, 1, 9, 0)
    backfill_activity = _activity(
        "buy", earlier_buy, "BTC", quantity="1", price="10000"
    )
    _apply(
        db_session, user=user, account=source, reference="earlier-backfill",
        activity=backfill_activity,
    )
    assert _holding(db_session, destination, "BTC").avg_cost == Decimal("10000.00000000")
    assert _holding(db_session, source, "BTC").quantity == Decimal("2.00000000")
    assert _holding(db_session, source, "BTC").avg_cost == Decimal("20000.00000000")

    duplicate = _apply(
        db_session, user=user, account=source, reference="earlier-backfill",
        activity=backfill_activity,
    )
    assert duplicate["inserted_records"] == 0
    assert _holding(db_session, destination, "BTC").avg_cost == Decimal("10000.00000000")


def test_exact_hash_wins_over_fallback_and_revert_restores_pending_state(
    db_session, crypto_accounts
):
    user, source, destination = crypto_accounts
    other_destination = Account(
        user_id=user.id,
        name="Second Owned Wallet",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    db_session.add(other_destination)
    db_session.flush()
    bought_at = datetime(2025, 4, 1, 9, 0)
    moved_at = datetime(2025, 4, 2, 9, 0)
    _apply(
        db_session, user=user, account=source, reference="match-seed",
        activity=_activity("buy", bought_at, "ETH", quantity="3", price="2000"),
    )
    _apply(
        db_session, user=user, account=source, reference="exact-out",
        activity=_activity(
            "withdrawal", moved_at, "ETH", quantity="1", price=None,
            currency=None, external_group_id="exact-chain-hash",
        ),
    )
    exact_run = _apply(
        db_session, user=user, account=destination, reference="exact-in",
        activity=_activity(
            "deposit", moved_at + timedelta(hours=1), "ETH", quantity="1",
            price=None, currency=None, external_group_id="exact-chain-hash",
        ),
    )
    nearby_run = _apply(
        db_session, user=user, account=other_destination, reference="nearby-in",
        activity=_activity(
            "deposit", moved_at + timedelta(hours=2), "ETH", quantity="1",
            price=None, currency=None,
        ),
    )
    exact = db_session.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.account_id == destination.id
    ).one()
    nearby = db_session.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.account_id == other_destination.id
    ).one()
    assert exact.status == "matched"
    assert exact.match_method == "transaction_hash"
    assert nearby.status == "pending"

    revert_run(
        db_session,
        user_id=user.id,
        run_id=nearby_run["run_id"],
        commit=False,
    )
    reverted = revert_run(
        db_session,
        user_id=user.id,
        run_id=exact_run["run_id"],
        commit=False,
    )
    assert reverted["removed_crypto_transfers"] == 1
    remaining = db_session.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.account_id == source.id
    ).one()
    assert remaining.status == "pending"
    assert db_session.query(BrokerTrade).filter(
        BrokerTrade.economic_type.in_(("transfer_out", "transfer_in"))
    ).count() == 0
    assert _holding(db_session, source, "ETH").quantity == Decimal("3.00000000")


def test_reverting_source_history_removes_dependent_transfer_projection(
    db_session, crypto_accounts
):
    user, source, destination = crypto_accounts
    bought_at = datetime(2025, 6, 1, 9, 0)
    moved_at = bought_at + timedelta(days=1)
    buy_run = _apply(
        db_session, user=user, account=source, reference="revert-source-buy",
        activity=_activity("buy", bought_at, "BTC", quantity="1", price="10000"),
    )
    _apply(
        db_session, user=user, account=source, reference="revert-source-out",
        activity=_activity(
            "withdrawal", moved_at, "BTC", quantity="1", price=None,
            currency=None, external_group_id="revert-source-chain",
        ),
    )
    _apply(
        db_session, user=user, account=destination, reference="revert-source-in",
        activity=_activity(
            "deposit", moved_at + timedelta(minutes=5), "BTC", quantity="1",
            price=None, currency=None, external_group_id="revert-source-chain",
        ),
    )

    reverted = revert_run(
        db_session, user_id=user.id, run_id=buy_run["run_id"], commit=False
    )

    assert reverted["removed_trades"] == 1
    assert db_session.query(BrokerTrade).filter(
        BrokerTrade.economic_type.in_(("transfer_out", "transfer_in"))
    ).count() == 0
    statuses = {
        row.status for row in db_session.query(InvestmentCryptoTransfer).filter(
            InvestmentCryptoTransfer.user_id == user.id
        ).all()
    }
    assert statuses == {"ambiguous"}
    assert _holding(db_session, source, "BTC").quantity == Decimal("0.00000000")
    assert _holding(db_session, destination, "BTC").quantity == Decimal("0.00000000")
