from datetime import date, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.db_helpers import clear_request_user_id, set_request_user_id
from app.integrations.crypto_com_exchange_adapter import (
    CryptoComExchangeAuthError,
    CryptoComExchangeBalance,
    CryptoComExchangeHistoryResult,
    CryptoComExchangeTransientError,
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
    export_broker_connection_diagnostics,
    list_investment_ingestion_runs,
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


class _AudFx:
    def convert(self, amount, _src, _dst, _on):
        return amount


def _history(symbol: str, start: date, end: date, *, partial=False):
    occurred_at = datetime(2026, 1, 1, 10, 0)
    records = (
        SourceRecordEnvelope(
            occurred_at=occurred_at,
            provider_record_id="deposit:btc-1",
            raw_payload={"id": "btc-1", "amount": "0.5", "currency": symbol},
            activities=(CanonicalActivityInput(
                activity_type="deposit", occurred_at=occurred_at,
                asset_symbol=symbol, asset_type="crypto", quantity=Decimal("0.5"),
                direction="in",
            ),),
        ),
    )
    failures = (
        "Crypto.com Exchange staking reward history is unavailable for this account.",
    ) if partial else ()
    warnings = (*failures, "Crypto.com App activity requires a separate CSV import.")
    return CryptoComExchangeHistoryResult(
        batch=InvestmentActivityBatch(
            provider="crypto_com_exchange", ingestion_type="api_sync",
            normalization_version="crypto-com-exchange-v1", records=records,
            cursor={"history_through": end.isoformat()},
            source_name=f"Crypto.com Exchange {start} to {end}", warnings=warnings,
        ),
        pending_records=0,
        requests_made=5,
        partial_product_failures=failures,
        missing_product_warnings=warnings,
    )


class _ExchangeFixtureAdapter:
    def __init__(self, symbol: str, *, partial=False):
        self.symbol = symbol
        self.partial = partial
        self.history_calls = []
        self.balance_fx = []
        self.verified = 0
        self.closed = 0

    def verify_read_only(self):
        self.verified += 1

    def fetch_balances(self, *, aud_per_usd):
        self.balance_fx.append(aud_per_usd)
        return (
            CryptoComExchangeBalance(
                self.symbol, Decimal("0.5"), Decimal("200"), Decimal("100")
            ),
        )

    def fetch_history(self, *, start, end):
        self.history_calls.append((start, end))
        return _history(self.symbol, start, end, partial=self.partial)

    def close(self):
        self.closed += 1


def _seed_connection(db_session, *, user_id, symbol):
    user = User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD")
    account = Account(
        id=uuid4(), user_id=user_id, name="Crypto.com Exchange",
        account_type="investment_brokerage", currency="AUD",
        provider="crypto_com_exchange",
    )
    connection = BrokerConnection(
        id=uuid4(), user_id=user_id, account_id=account.id,
        provider="crypto_com_exchange",
        credentials_encrypted=encrypt({
            "api_key": "key", "api_secret": "secret",
            "history_start_date": "2026-01-01",
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


def test_initial_and_incremental_exchange_sync_are_idempotent_and_reconciled(db_session):
    suffix = uuid4().hex[:8].upper()
    user_id = f"cdc-sync-{suffix.lower()}"
    symbol = f"CD{suffix}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = _ExchangeFixtureAdapter(symbol)
    service = InvestmentSyncService(
        db=db_session,
        fx=_AudFx(),
        crypto_com_exchange_adapter_factory=lambda _creds: adapter,
    )
    try:
        service.sync_account(account.id, on=date(2026, 1, 10))
        service.sync_account(account.id, on=date(2026, 1, 10))
        db_session.refresh(connection)

        assert adapter.history_calls == [
            (date(2026, 1, 1), date(2026, 1, 10)),
            (date(2026, 1, 8), date(2026, 1, 10)),
        ]
        assert adapter.balance_fx == [Decimal("1"), Decimal("1")]
        assert connection.sync_cursor == {"history_through": "2026-01-10"}
        assert connection.last_sync_status == "ok"
        assert connection.health_details["balances_reconciled"] is True
        assert connection.health_details["skipped_duplicate_records"] == 1
        assert adapter.closed == 2
        assert db_session.query(InvestmentSourceRecord).filter_by(account_id=account.id).count() == 1
        assert db_session.query(InvestmentActivity).filter_by(account_id=account.id).count() == 1
        assert db_session.query(InvestmentIngestionRun).filter_by(account_id=account.id).count() == 2
        context = set_request_user_id(user_id)
        try:
            runs = list_investment_ingestion_runs(
                account_id=account.id, user_id=user_id, db=db_session
            )
            assert [run["ingestion_type"] for run in runs] == ["api_sync", "api_sync"]
            diagnostics = export_broker_connection_diagnostics(
                connection.id, user_id=user_id, db=db_session
            )
            assert diagnostics["connection"]["credentials_included"] is False
            assert len(diagnostics["runs"]) == 2
            assert "secret" not in str(diagnostics).lower()
        finally:
            clear_request_user_id(context)
        holding = db_session.query(Holding).filter_by(account_id=account.id, symbol=symbol).one()
        assert Decimal(holding.quantity) == Decimal("0.5")
        assert holding.source == "crypto_com_api"
        valuation = db_session.query(HoldingValuation).filter_by(holding_id=holding.id).one()
        assert Decimal(valuation.value_user_currency) == Decimal("100")
        balance = db_session.query(AccountBalance).filter_by(account_id=account.id).one()
        assert Decimal(balance.balance_in_account_currency) == Decimal("100")
    finally:
        _cleanup(db_session, user_id=user_id, symbols=[symbol])


def test_optional_product_failure_sets_actionable_partial_health(db_session):
    suffix = uuid4().hex[:8].upper()
    user_id = f"cdc-partial-{suffix.lower()}"
    symbol = f"CP{suffix}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = _ExchangeFixtureAdapter(symbol, partial=True)
    try:
        InvestmentSyncService(
            db=db_session, fx=_AudFx(),
            crypto_com_exchange_adapter_factory=lambda _creds: adapter,
        ).sync_account(account.id, on=date(2026, 1, 10))
        db_session.refresh(connection)
        assert connection.last_sync_status == "partial"
        assert "product history was unavailable" in connection.last_sync_error
        assert connection.health_details["partial_product_failures"]
    finally:
        _cleanup(db_session, user_id=user_id, symbols=[symbol])


@pytest.mark.parametrize(
    ("failure", "status", "has_retry"),
    [
        (CryptoComExchangeAuthError("bad key"), "needs_reauth", False),
        (CryptoComExchangeTransientError("busy"), "pending", True),
    ],
)
def test_exchange_failure_state_is_recoverable(db_session, failure, status, has_retry):
    suffix = uuid4().hex[:8].upper()
    user_id = f"cdc-failure-{suffix.lower()}"
    symbol = f"CF{suffix}"
    account, connection = _seed_connection(db_session, user_id=user_id, symbol=symbol)
    adapter = MagicMock()
    adapter.verify_read_only.side_effect = failure
    service = InvestmentSyncService(
        db=db_session, fx=MagicMock(),
        crypto_com_exchange_adapter_factory=lambda _creds: adapter,
        valuation_service=MagicMock(),
    )
    try:
        with pytest.raises(type(failure)):
            service.sync_account(account.id, on=date(2026, 1, 10))
        db_session.refresh(connection)
        assert connection.last_sync_status == status
        assert connection.consecutive_failures == 1
        assert (connection.next_retry_at is not None) is has_retry
        assert (connection.read_only_verified_at is None) is isinstance(
            failure, CryptoComExchangeAuthError
        )
        failed_run = db_session.query(InvestmentIngestionRun).filter_by(
            account_id=account.id,
            status="failed",
        ).one()
        assert failed_run.ingestion_type == "api_sync"
        assert str(failure) in failed_run.error
    finally:
        _cleanup(db_session, user_id=user_id)


def test_exchange_connection_requires_attestation_and_encrypts_verified_credentials(db_session):
    with pytest.raises(ValidationError, match="Can Read only"):
        BrokerConnectionCreate(
            provider="crypto_com_exchange", api_key="key", api_secret="secret",
            account_name="Exchange", base_currency="AUD",
        )

    suffix = uuid4().hex[:8]
    user_id = f"cdc-route-{suffix}"
    db_session.add(User(id=user_id, email=f"{user_id}@example.test", functional_currency="AUD"))
    db_session.commit()
    payload = BrokerConnectionCreate(
        provider="crypto_com_exchange", api_key="API_KEY_VALUE",
        api_secret="API_SECRET_VALUE", history_start_date=date(2024, 1, 1),
        read_only_confirmed=True, account_name="Crypto.com Exchange", base_currency="AUD",
    )
    context = set_request_user_id(user_id)
    try:
        with patch(
            "app.routes.investments.CryptoComExchangeAdapter.verify_read_only"
        ) as verify:
            result = create_broker_connection(payload, BackgroundTasks(), db=db_session)
        verify.assert_called_once()
        connection = db_session.query(BrokerConnection).filter_by(id=result["connection_id"]).one()
        assert "API_KEY_VALUE" not in connection.credentials_encrypted
        assert decrypt(connection.credentials_encrypted) == {
            "api_key": "API_KEY_VALUE", "api_secret": "API_SECRET_VALUE",
            "history_start_date": "2024-01-01",
        }
        assert connection.health_details["read_only_namespace"].startswith(
            "Crypto.com Exchange"
        )

        with pytest.raises(HTTPException, match="Confirm the replacement"):
            update_coinspot_credentials(
                connection.id,
                CoinSpotCredentialsUpdate(api_key="NEW_KEY", api_secret="NEW_SECRET"),
                BackgroundTasks(), db=db_session,
            )
        with patch(
            "app.routes.investments.CryptoComExchangeAdapter.verify_read_only"
        ) as verify:
            update_coinspot_credentials(
                connection.id,
                CoinSpotCredentialsUpdate(
                    api_key="NEW_KEY", api_secret="NEW_SECRET",
                    read_only_confirmed=True,
                ),
                BackgroundTasks(), db=db_session,
            )
        verify.assert_called_once()
        db_session.refresh(connection)
        assert decrypt(connection.credentials_encrypted)["api_key"] == "NEW_KEY"
        assert connection.last_sync_status == "pending"
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)


def test_exchange_connection_can_reuse_csv_backed_account(db_session):
    suffix = uuid4().hex[:8]
    user_id = f"cdc-existing-{suffix}"
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        functional_currency="AUD",
    )
    account = Account(
        user_id=user_id,
        name="Imported Exchange History",
        account_type="investment_manual",
        currency="AUD",
        provider="manual",
    )
    db_session.add_all([user, account])
    db_session.commit()
    context = set_request_user_id(user_id)
    try:
        payload = BrokerConnectionCreate(
            provider="crypto_com_exchange",
            account_id=account.id,
            api_key="EXISTING_KEY",
            api_secret="EXISTING_SECRET",
            read_only_confirmed=True,
            account_name="ignored for existing account",
            base_currency="AUD",
        )
        with patch("app.routes.investments.CryptoComExchangeAdapter.verify_read_only"):
            result = create_broker_connection(payload, BackgroundTasks(), db=db_session)
        db_session.refresh(account)
        assert result["account_id"] == str(account.id)
        assert db_session.query(Account).filter_by(user_id=user_id).count() == 1
        assert account.name == "Imported Exchange History"
        assert account.account_type == "investment_brokerage"
        assert account.provider == "crypto_com_exchange"
    finally:
        clear_request_user_id(context)
        _cleanup(db_session, user_id=user_id)
