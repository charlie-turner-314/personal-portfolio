from datetime import date, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.db_helpers import clear_request_user_id, set_request_user_id
from app.integrations.binance_adapter import (
    BinanceAuthError,
    BinanceBalance,
    BinanceHistoryResult,
    BinancePermissionError,
    BinanceTransientError,
)
from app.models import (
    Account,
    AccountBalance,
    BrokerConnection,
    Holding,
    HoldingValuation,
    InvestmentActivity,
    InvestmentIngestionRun,
    InvestmentSourceRecord,
    PriceSnapshot,
    User,
)
from app.routes.investments import (
    create_broker_connection,
    update_binance_configuration,
    update_coinspot_credentials,
)
from app.schemas import BinanceTradeSymbolsUpdate, BrokerConnectionCreate, CoinSpotCredentialsUpdate
from app.services.credentials_crypto import decrypt, encrypt, generate_key
from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
)
from app.services.investment_sync_service import InvestmentSyncService


@pytest.fixture(autouse=True)
def credential_key(monkeypatch):
    monkeypatch.setenv("PERSONAL_PORTFOLIO_SECRET_KEY", generate_key())


class _AudFx:
    def convert(self, amount, _src, _dst, _on):
        return amount


def _history(symbol: str, start: date, end: date) -> BinanceHistoryResult:
    occurred_at = datetime(2026, 1, 1, 10, 0)
    records = (
        SourceRecordEnvelope(
            occurred_at=occurred_at,
            provider_record_id="deposit:btc-1",
            raw_payload={"id": "btc-1", "amount": "0.5", "coin": symbol},
            activities=(CanonicalActivityInput(
                activity_type="deposit", occurred_at=occurred_at,
                asset_symbol=symbol, asset_type="crypto", quantity=Decimal("0.5"),
                direction="in",
            ),),
        ),
    )
    warnings = (
        "Binance trade history is symbol-scoped. Add sold-out historical pairs for completeness.",
    )
    return BinanceHistoryResult(
        batch=InvestmentActivityBatch(
            provider="binance", ingestion_type="api_sync",
            normalization_version="binance-spot-v1", records=records,
            cursor={"history_through": end.isoformat(), "trade_symbols": [f"{symbol}USDT"]},
            source_name=f"Binance {start} to {end}", warnings=warnings,
        ),
        pending_records=0,
        windows_requested=8,
        trade_symbols=(f"{symbol}USDT",),
        missing_product_warnings=warnings,
    )


class _BinanceFixtureAdapter:
    def __init__(self, symbol: str):
        self.symbol = symbol
        self.history_calls = []
        self.verified = 0
        self.closed = 0

    def verify_read_only(self):
        self.verified += 1

    def fetch_balances(self):
        return (
            BinanceBalance(self.symbol, Decimal("0.5"), Decimal("200"), Decimal("100")),
        )

    def fetch_history(self, *, start, end, configured_trade_symbols, current_assets):
        self.history_calls.append((start, end, tuple(configured_trade_symbols), tuple(current_assets)))
        return _history(self.symbol, start, end)

    def close(self):
        self.closed += 1


def _seed_connection(db_session, *, user_id, symbol):
    user = User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD")
    account = Account(
        id=uuid4(), user_id=user_id, name="Binance", account_type="investment_brokerage",
        currency="AUD", provider="binance",
    )
    connection = BrokerConnection(
        id=uuid4(), user_id=user_id, account_id=account.id, provider="binance",
        credentials_encrypted=encrypt({
            "api_key": "key", "api_secret": "secret", "history_start_date": "2026-01-01",
            "trade_symbols": [f"{symbol}USDT"],
        }),
        read_only_verified_at=datetime(2026, 1, 1), health_details={},
    )
    db_session.add_all([user, account, connection])
    db_session.commit()
    return account, connection


def _cleanup(db_session, *, user_id, symbols=()):
    db_session.rollback()
    if symbols:
        db_session.query(PriceSnapshot).filter(PriceSnapshot.symbol.in_(symbols)).delete(
            synchronize_session=False
        )
    db_session.query(User).filter(User.id == user_id).delete(synchronize_session=False)
    db_session.commit()


def test_initial_and_incremental_binance_sync_are_idempotent_and_reconciled(db_session):
    suffix = uuid4().hex[:8].upper()
    user_id = f"binance-sync-{suffix.lower()}"
    symbol = f"BN{suffix}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = _BinanceFixtureAdapter(symbol)
    service = InvestmentSyncService(
        db=db_session, fx=_AudFx(),
        binance_adapter_factory=lambda _creds: adapter,
    )
    try:
        service.sync_account(account.id, on=date(2026, 1, 10))
        service.sync_account(account.id, on=date(2026, 1, 10))
        db_session.refresh(connection)

        assert [call[:2] for call in adapter.history_calls] == [
            (date(2026, 1, 1), date(2026, 1, 10)),
            (date(2026, 1, 8), date(2026, 1, 10)),
        ]
        assert connection.sync_cursor == {
            "history_through": "2026-01-10", "trade_symbols": [f"{symbol}USDT"],
        }
        assert connection.last_sync_status == "ok"
        assert connection.health_details["balances_reconciled"] is True
        assert connection.health_details["skipped_duplicate_records"] == 1
        assert connection.health_details["trade_symbols"] == [f"{symbol}USDT"]
        assert connection.health_details["missing_product_warnings"]
        assert adapter.closed == 2
        assert db_session.query(InvestmentSourceRecord).filter_by(account_id=account.id).count() == 1
        assert db_session.query(InvestmentActivity).filter_by(account_id=account.id).count() == 1
        assert db_session.query(InvestmentIngestionRun).filter_by(account_id=account.id).count() == 2
        holding = db_session.query(Holding).filter_by(account_id=account.id, symbol=symbol).one()
        assert Decimal(holding.quantity) == Decimal("0.5")
        assert holding.source == "binance_api"
        valuation = db_session.query(HoldingValuation).filter_by(holding_id=holding.id).one()
        assert Decimal(valuation.value_user_currency) == Decimal("100")
        balance = db_session.query(AccountBalance).filter_by(account_id=account.id).one()
        assert Decimal(balance.balance_in_account_currency) == Decimal("100")
    finally:
        _cleanup(db_session, user_id=user_id, symbols=[symbol])


@pytest.mark.parametrize(
    ("failure", "status", "has_retry"),
    [
        (BinanceAuthError("bad key"), "needs_reauth", False),
        (BinanceTransientError("busy"), "pending", True),
    ],
)
def test_binance_failure_state_is_recoverable(db_session, failure, status, has_retry):
    suffix = uuid4().hex[:8].upper()
    user_id = f"binance-failure-{suffix.lower()}"
    symbol = f"BF{suffix}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = MagicMock()
    adapter.verify_read_only.side_effect = failure
    service = InvestmentSyncService(
        db=db_session, fx=MagicMock(),
        binance_adapter_factory=lambda _creds: adapter,
        valuation_service=MagicMock(),
    )
    try:
        with pytest.raises(type(failure)):
            service.sync_account(account.id, on=date(2026, 1, 10))
        db_session.refresh(connection)
        assert connection.last_sync_status == status
        assert connection.consecutive_failures == 1
        assert (connection.next_retry_at is not None) is has_retry
        assert (connection.read_only_verified_at is None) is isinstance(failure, BinanceAuthError)
    finally:
        _cleanup(db_session, user_id=user_id)


def test_binance_connection_validates_before_encrypted_persistence_and_can_recover(db_session):
    suffix = uuid4().hex[:8]
    user_id = f"binance-route-{suffix}"
    db_session.add(User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD"))
    db_session.commit()
    payload = BrokerConnectionCreate(
        provider="binance", api_key="API_KEY_VALUE", api_secret="API_SECRET_VALUE",
        history_start_date=date(2024, 1, 1), trade_symbols=["btcusdt", "ETHUSDT"],
        account_name="Binance Main", base_currency="AUD",
    )
    context = set_request_user_id(user_id)
    try:
        with patch("app.routes.investments.BinanceAdapter.verify_read_only") as verify:
            result = create_broker_connection(payload, BackgroundTasks(), db=db_session)
        verify.assert_called_once()
        connection = db_session.query(BrokerConnection).filter_by(id=result["connection_id"]).one()
        assert "API_KEY_VALUE" not in connection.credentials_encrypted
        assert decrypt(connection.credentials_encrypted) == {
            "api_key": "API_KEY_VALUE", "api_secret": "API_SECRET_VALUE",
            "history_start_date": "2024-01-01", "trade_symbols": ["BTCUSDT", "ETHUSDT"],
        }

        with patch("app.routes.investments.BinanceAdapter.verify_read_only") as verify:
            update_coinspot_credentials(
                connection.id,
                CoinSpotCredentialsUpdate(
                    api_key="NEW_KEY", api_secret="NEW_SECRET", trade_symbols=["ETHUSDT"],
                ),
                BackgroundTasks(), db=db_session,
            )
        verify.assert_called_once()
        db_session.refresh(connection)
        assert decrypt(connection.credentials_encrypted)["trade_symbols"] == ["ETHUSDT"]
        assert connection.last_sync_status == "pending"
        assert connection.consecutive_failures == 0

        update_binance_configuration(
            connection.id,
            BinanceTradeSymbolsUpdate(trade_symbols=["btcusdt", "BNBBTC"]),
            BackgroundTasks(), db=db_session,
        )
        db_session.refresh(connection)
        updated = decrypt(connection.credentials_encrypted)
        assert updated["api_key"] == "NEW_KEY"
        assert updated["trade_symbols"] == ["BTCUSDT", "BNBBTC"]
        assert connection.health_details["configured_trade_symbols"] == ["BTCUSDT", "BNBBTC"]
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)


def test_non_read_only_binance_key_does_not_create_account(db_session):
    suffix = uuid4().hex[:8]
    user_id = f"binance-invalid-{suffix}"
    db_session.add(User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD"))
    db_session.commit()
    payload = BrokerConnectionCreate(
        provider="binance", api_key="bad", api_secret="bad",
        account_name="Rejected", base_currency="AUD",
    )
    context = set_request_user_id(user_id)
    try:
        with patch(
            "app.routes.investments.BinanceAdapter.verify_read_only",
            side_effect=BinancePermissionError("trading enabled"),
        ), pytest.raises(HTTPException) as error:
            create_broker_connection(payload, BackgroundTasks(), db=db_session)
        assert error.value.status_code == 400
        assert "least privilege" in error.value.detail
        assert db_session.query(Account).filter_by(user_id=user_id).count() == 0
        assert db_session.query(BrokerConnection).filter_by(user_id=user_id).count() == 0
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)
