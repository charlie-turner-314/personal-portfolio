from datetime import date, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.db_helpers import clear_request_user_id, set_request_user_id
from app.integrations.coinspot_adapter import (
    CoinSpotAuthError,
    CoinSpotBalance,
    CoinSpotHistoryResult,
    CoinSpotTransientError,
)
from app.models import (
    Account,
    AccountBalance,
    BrokerConnection,
    HoldingValuation,
    InvestmentActivity,
    InvestmentIngestionRun,
    InvestmentSourceRecord,
    PriceSnapshot,
    User,
)
from app.routes.investments import (
    create_broker_connection,
    delete_broker_connection,
    update_coinspot_credentials,
)
from app.schemas import BrokerConnectionCreate, CoinSpotCredentialsUpdate
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


def _history(symbol: str, start: date, end: date) -> CoinSpotHistoryResult:
    occurred_at = datetime(2026, 1, 1, 10, 0)
    records = (
        SourceRecordEnvelope(
            occurred_at=datetime(2026, 1, 1, 9, 0),
            provider_record_id="deposit:aud-1",
            raw_payload={"id": "aud-1", "amount": "100", "status": "completed"},
            activities=(CanonicalActivityInput(
                activity_type="deposit",
                occurred_at=datetime(2026, 1, 1, 9, 0),
                asset_symbol="AUD",
                asset_type="cash",
                quantity=Decimal("100"),
                direction="in",
            ),),
        ),
        SourceRecordEnvelope(
            occurred_at=occurred_at,
            provider_record_id="order:buy:1",
            raw_payload={"id": "1", "coin": symbol, "amount": "1"},
            activities=(CanonicalActivityInput(
                activity_type="buy",
                occurred_at=occurred_at,
                asset_symbol=symbol,
                asset_type="crypto",
                quantity=Decimal("1"),
                price=Decimal("100"),
                currency="AUD",
                aud_value=Decimal("100"),
                valuation_source="coinspot_order_history",
                valuation_timestamp=occurred_at,
            ),),
        ),
    )
    return CoinSpotHistoryResult(
        batch=InvestmentActivityBatch(
            provider="coinspot",
            ingestion_type="api_sync",
            normalization_version="coinspot-v2",
            records=records,
            cursor={"history_through": end.isoformat()},
            source_name=f"CoinSpot {start} to {end}",
        ),
        pending_records=0,
        windows_requested=4,
    )


class _CoinSpotFixtureAdapter:
    def __init__(self, symbol: str):
        self.symbol = symbol
        self.history_calls: list[tuple[date, date]] = []
        self.verified = 0

    def verify_read_only(self):
        self.verified += 1

    def fetch_history(self, *, start: date, end: date):
        self.history_calls.append((start, end))
        return _history(self.symbol, start, end)

    def fetch_balances(self):
        return (CoinSpotBalance(
            symbol=self.symbol,
            quantity=Decimal("1"),
            aud_balance=Decimal("100"),
            aud_rate=Decimal("100"),
        ),)


class _AudFx:
    def convert(self, amount, _src, _dst, _on):
        return amount


def _seed_connection(db_session, *, user_id: str, symbol: str):
    user = User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD")
    account = Account(
        id=uuid4(), user_id=user_id, name="CoinSpot", account_type="investment_brokerage",
        currency="AUD", provider="coinspot",
    )
    connection = BrokerConnection(
        id=uuid4(), user_id=user_id, account_id=account.id, provider="coinspot",
        credentials_encrypted=encrypt({
            "api_key": "key", "api_secret": "secret", "history_start_date": "2026-01-01",
        }),
        read_only_verified_at=datetime(2026, 1, 1),
        health_details={},
    )
    db_session.add_all([user, account, connection])
    db_session.commit()
    return account, connection


def _cleanup(db_session, *, user_id: str, symbol: str | None = None):
    db_session.rollback()
    if symbol:
        db_session.query(PriceSnapshot).filter(PriceSnapshot.symbol == symbol).delete(
            synchronize_session=False
        )
    db_session.query(User).filter(User.id == user_id).delete(synchronize_session=False)
    db_session.commit()


def test_initial_and_incremental_coinspot_sync_are_idempotent(db_session):
    suffix = uuid4().hex[:8].upper()
    user_id = f"coinspot-sync-{suffix.lower()}"
    symbol = f"CS{suffix}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = _CoinSpotFixtureAdapter(symbol)
    service = InvestmentSyncService(
        db=db_session,
        fx=_AudFx(),
        coinspot_adapter_factory=lambda _creds: adapter,
    )
    try:
        service.sync_account(account.id, on=date(2026, 1, 10))
        service.sync_account(account.id, on=date(2026, 1, 10))

        db_session.refresh(connection)
        assert adapter.history_calls == [
            (date(2026, 1, 1), date(2026, 1, 10)),
            (date(2026, 1, 8), date(2026, 1, 10)),
        ]
        assert connection.sync_cursor == {"history_through": "2026-01-10"}
        assert connection.last_sync_status == "ok"
        assert connection.read_only_verified_at is not None

        assert connection.health_details["balances_reconciled"] is True
        assert connection.health_details["inserted_records"] == 0
        assert connection.health_details["skipped_duplicate_records"] == 2
        assert db_session.query(InvestmentSourceRecord).filter_by(account_id=account.id).count() == 2
        assert db_session.query(InvestmentActivity).filter_by(account_id=account.id).count() == 2
        assert db_session.query(InvestmentIngestionRun).filter_by(account_id=account.id).count() == 2
        holding = next(item for item in account_holdings(db_session, account.id) if item.symbol == symbol)
        assert Decimal(holding.quantity) == Decimal("1")
        assert holding.source == "coinspot_api"
        valuation = db_session.query(HoldingValuation).filter_by(holding_id=holding.id).one()
        assert Decimal(valuation.price) == Decimal("100")
        assert Decimal(valuation.value_user_currency) == Decimal("100")
        balance = db_session.query(AccountBalance).filter_by(account_id=account.id).one()
        assert Decimal(balance.balance_in_account_currency) == Decimal("100")
    finally:
        _cleanup(db_session, user_id=user_id, symbol=symbol)


def account_holdings(db_session, account_id):
    from app.models import Holding

    return db_session.query(Holding).filter(Holding.account_id == account_id).all()


@pytest.mark.parametrize(
    ("failure", "status", "has_retry"),
    [
        (CoinSpotAuthError("bad key"), "needs_reauth", False),
        (CoinSpotTransientError("busy"), "pending", True),
    ],
)
def test_coinspot_failure_state_is_recoverable(db_session, failure, status, has_retry):
    suffix = uuid4().hex[:8]
    user_id = f"coinspot-failure-{suffix}"
    symbol = f"CF{suffix.upper()}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = MagicMock()
    adapter.verify_read_only.side_effect = failure
    service = InvestmentSyncService(
        db=db_session,
        fx=MagicMock(),
        coinspot_adapter_factory=lambda _creds: adapter,
        valuation_service=MagicMock(),
    )
    try:
        with pytest.raises(type(failure)):
            service.sync_account(account.id, on=date(2026, 1, 10))
        db_session.refresh(connection)
        assert connection.last_sync_status == status
        assert connection.consecutive_failures == 1
        assert (connection.next_retry_at is not None) is has_retry
        assert (connection.read_only_verified_at is None) is isinstance(failure, CoinSpotAuthError)
        assert connection.health_details["failure_kind"] in {"authentication", "transient"}
    finally:
        _cleanup(db_session, user_id=user_id)


def test_coinspot_connection_validates_before_encrypting_and_persisting(db_session):
    suffix = uuid4().hex[:8]
    user_id = f"coinspot-route-{suffix}"
    db_session.add(User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD"))
    db_session.commit()
    payload = BrokerConnectionCreate(
        provider="coinspot",
        api_key="API_KEY_VALUE",
        api_secret="API_SECRET_VALUE",
        history_start_date=date(2024, 7, 1),
        account_name="CoinSpot Main",
        base_currency="AUD",
    )
    context = set_request_user_id(user_id)
    try:
        with patch("app.routes.investments.CoinSpotAdapter.verify_read_only") as verify:
            result = create_broker_connection(payload, BackgroundTasks(), db=db_session)
        verify.assert_called_once()
        connection = db_session.query(BrokerConnection).filter_by(id=result["connection_id"]).one()
        assert "API_KEY_VALUE" not in connection.credentials_encrypted
        assert "API_SECRET_VALUE" not in connection.credentials_encrypted
        assert decrypt(connection.credentials_encrypted) == {
            "api_key": "API_KEY_VALUE",
            "api_secret": "API_SECRET_VALUE",
            "history_start_date": "2024-07-01",
        }
        assert connection.read_only_verified_at is not None

        with patch("app.routes.investments.CoinSpotAdapter.verify_read_only") as verify:
            update_coinspot_credentials(
                connection.id,
                CoinSpotCredentialsUpdate(
                    api_key="REPLACEMENT_KEY",
                    api_secret="REPLACEMENT_SECRET",
                ),
                BackgroundTasks(),
                db=db_session,
            )
        verify.assert_called_once()
        db_session.refresh(connection)
        assert decrypt(connection.credentials_encrypted) == {
            "api_key": "REPLACEMENT_KEY",
            "api_secret": "REPLACEMENT_SECRET",
            "history_start_date": "2024-07-01",
        }
        assert connection.last_sync_status == "pending"
        assert connection.consecutive_failures == 0
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)


def test_invalid_coinspot_key_does_not_create_account(db_session):
    suffix = uuid4().hex[:8]
    user_id = f"coinspot-invalid-{suffix}"
    db_session.add(User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD"))
    db_session.commit()
    payload = BrokerConnectionCreate(
        provider="coinspot", api_key="bad", api_secret="bad",
        account_name="Rejected", base_currency="AUD",
    )
    context = set_request_user_id(user_id)
    try:
        with patch(
            "app.routes.investments.CoinSpotAdapter.verify_read_only",
            side_effect=CoinSpotAuthError("rejected"),
        ), pytest.raises(HTTPException) as error:
            create_broker_connection(payload, BackgroundTasks(), db=db_session)
        assert error.value.status_code == 400
        assert db_session.query(Account).filter_by(user_id=user_id).count() == 0
        assert db_session.query(BrokerConnection).filter_by(user_id=user_id).count() == 0
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)


def test_disconnect_removes_credentials_but_keeps_imported_account(db_session):
    suffix = uuid4().hex[:8]
    user_id = f"coinspot-disconnect-{suffix}"
    symbol = f"CD{suffix.upper()}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    connection_id = connection.id
    context = set_request_user_id(user_id)
    try:
        delete_broker_connection(connection_id, db=db_session)
        db_session.refresh(account)
        assert db_session.query(BrokerConnection).filter_by(id=connection_id).one_or_none() is None
        assert account.account_type == "investment_manual"
        assert account.provider == "manual"
        assert account.is_active is True
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)
