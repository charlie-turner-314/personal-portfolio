import hashlib
import hmac
import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from app.integrations.crypto_com_exchange_adapter import (
    BASE_URL,
    CAPITAL_PAGE_SIZE,
    HISTORY_PAGE_SIZE,
    CryptoComExchangeAdapter,
    CryptoComExchangeProductUnavailableError,
    CryptoComExchangeReadOnlyClient,
    CryptoComExchangeTransientError,
)
from app.services.investment_activity_service import validate_batch


FIXTURES = Path(__file__).parent / "fixtures"


def _fixture(name):
    return json.loads((FIXTURES / name).read_text())


def test_signed_post_matches_exchange_spec_and_rejects_write_methods():
    seen = {}

    def handler(request: httpx.Request):
        seen["request"] = request
        return httpx.Response(200, json={"id": 1, "code": 0, "result": {"data": []}})

    client = CryptoComExchangeReadOnlyClient(
        api_key="public-key",
        api_secret="private-secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
        clock_ms=lambda: 1770736694138,
    )
    try:
        client.private_post("private/get-trades", {"b": "2", "a": {"d": "4", "c": ["1", "2"]}})
        body = json.loads(seen["request"].content)
        signing_payload = "private/get-trades1public-keyac12d4b21770736694138"
        expected = hmac.new(
            b"private-secret", signing_payload.encode(), hashlib.sha256
        ).hexdigest()
        assert str(seen["request"].url) == f"{BASE_URL}/private/get-trades"
        assert body["sig"] == expected
        assert body["api_key"] == "public-key"
        assert "private-secret" not in seen["request"].content.decode()
        with pytest.raises(ValueError, match="read-only allowlist"):
            client.private_post("private/create-order", {})
        with pytest.raises(ValueError, match="read-only allowlist"):
            client.private_post("private/create-withdrawal", {})
    finally:
        client.close()


def test_rate_limit_honours_retry_after_and_long_cooldown_is_durable():
    calls = 0
    sleeps = []

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429, headers={"Retry-After": "4"},
                json={"id": 1, "code": 42901, "message": "TOO_MANY_REQUESTS"},
            )
        return httpx.Response(200, json={"id": 2, "code": 0, "result": {"data": []}})

    client = CryptoComExchangeReadOnlyClient(
        api_key="key", api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=1, sleep=sleeps.append, clock_ms=lambda: 1,
    )
    try:
        client.private_post("private/user-balance", {})
        assert sleeps == [4.0]
    finally:
        client.close()

    durable = CryptoComExchangeReadOnlyClient(
        api_key="key", api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                429, headers={"Retry-After": "3600"},
                json={"id": 1, "code": 42901, "message": "TOO_MANY_REQUESTS"},
            )
        )),
        retries=3,
        sleep=lambda _delay: pytest.fail("long cooldown must not block a worker"),
        clock_ms=lambda: 1,
    )
    try:
        with pytest.raises(CryptoComExchangeTransientError) as error:
            durable.private_post("private/user-balance", {})
        assert error.value.retry_after_seconds == 3600
    finally:
        durable.close()


class _FixtureClient:
    def __init__(self):
        self.request_count = 0

    def close(self):
        pass

    def pause(self, _seconds):
        pass

    def private_post(self, method, params=None):
        self.request_count += 1
        if method == "private/user-balance":
            return _fixture("crypto_com_exchange_balance.json")
        if method == "private/get-deposit-history":
            return _fixture("crypto_com_exchange_deposits.json")
        if method == "private/get-withdrawal-history":
            return _fixture("crypto_com_exchange_withdrawals.json")
        if method == "private/get-trades":
            return _fixture("crypto_com_exchange_trades.json")
        if method == "private/staking/get-reward-history":
            return _fixture("crypto_com_exchange_rewards.json")
        raise AssertionError(method)

    def public_get(self, method, params=None):
        self.request_count += 1
        if method == "public/get-instruments":
            return _fixture("crypto_com_exchange_instruments.json")
        if method == "public/get-tickers":
            return _fixture("crypto_com_exchange_tickers.json")
        raise AssertionError(method)


def test_sanitized_exchange_fixtures_normalize_balances_fills_movements_and_rewards():
    adapter = CryptoComExchangeAdapter(_FixtureClient())
    balances = adapter.fetch_balances(aud_per_usd=Decimal("1.5"))
    assert [(item.symbol, item.quantity) for item in balances] == [
        ("BTC", Decimal("0.50000000")),
        ("USDT", Decimal("100.00000000")),
    ]
    assert balances[0].aud_rate == Decimal("90000.000")
    assert balances[1].aud_rate == Decimal("1.5")

    history = adapter.fetch_history(start=date(2026, 1, 1), end=date(2026, 1, 10))
    validated = validate_batch(history.batch, account_id=uuid4())
    assert len(validated.records) == 5
    assert history.pending_records == 2
    assert history.partial_product_failures == ()
    assert any("consumer App CSV" in warning for warning in history.missing_product_warnings)
    activities = [item for record in validated.records for item in record.activities]
    assert {item.activity_type for item in activities} == {
        "deposit", "withdrawal", "crypto_swap", "staking_reward",
    }
    fills = [
        record for record in validated.records
        if record.provider_record_id.startswith("exchange-fill:")
    ]
    assert [record.provider_record_id for record in fills] == [
        "exchange-fill:8001", "exchange-fill:8002",
    ]
    assert fills[0].activities[0].external_group_id == fills[1].activities[0].external_group_id
    assert fills[0].activities[0].fee_currency == "USDT"
    assert fills[1].activities[0].fee_currency == "CRO"


def test_overlapping_exchange_windows_keep_stable_provider_ids():
    adapter = CryptoComExchangeAdapter(_FixtureClient())
    first = adapter.fetch_history(start=date(2026, 1, 1), end=date(2026, 1, 10))
    second = adapter.fetch_history(start=date(2026, 1, 2), end=date(2026, 1, 10))
    assert [record.provider_record_id for record in first.batch.records] == [
        record.provider_record_id for record in second.batch.records
    ]


def test_optional_staking_failure_is_visible_without_losing_spot_history():
    class Client(_FixtureClient):
        def private_post(self, method, params=None):
            if method == "private/staking/get-reward-history":
                raise CryptoComExchangeProductUnavailableError("not available")
            return super().private_post(method, params)

    history = CryptoComExchangeAdapter(Client()).fetch_history(
        start=date(2026, 1, 1), end=date(2026, 1, 10)
    )
    assert len(history.batch.records) == 4
    assert history.partial_product_failures == (
        "Crypto.com Exchange staking reward history is unavailable for this account.",
    )


def test_capital_history_uses_bounded_windows_and_zero_based_pagination():
    seen = []

    class Client(_FixtureClient):
        def private_post(self, method, params=None):
            if method in {"private/get-deposit-history", "private/get-withdrawal-history"}:
                seen.append((method, dict(params or {})))
                key = "deposit_list" if "deposit" in method else "withdrawal_list"
                return {"code": 0, "result": {key: []}}
            return super().private_post(method, params)

    CryptoComExchangeAdapter(Client())._capital_records(
        date(2025, 1, 1), date(2025, 7, 1)
    )
    assert len(seen) == 6
    assert all(call[1]["page"] == "0" for call in seen)
    assert all(call[1]["page_size"] == str(CAPITAL_PAGE_SIZE) for call in seen)


def test_full_trade_page_paginates_backwards_by_nanosecond_without_orders():
    calls = []
    sleeps = []

    class Client:
        pause = staticmethod(sleeps.append)

        def private_post(self, method, params=None):
            calls.append((method, dict(params or {})))
            if len(calls) == 1:
                return {"code": 0, "result": {"data": [
                    {
                        "trade_id": str(index),
                        "create_time": 1767261600000 + index,
                        "create_time_ns": str((1767261600000 + index) * 1_000_000),
                    }
                    for index in range(HISTORY_PAGE_SIZE)
                ]}}
            return {"code": 0, "result": {"data": []}}

    rows, used = CryptoComExchangeAdapter(Client())._backward_pages(
        "private/get-trades", start=date(2026, 1, 1), end=date(2026, 1, 10),
        limit=HISTORY_PAGE_SIZE, ns_field="create_time_ns", ms_field="create_time",
    )
    assert len(rows) == HISTORY_PAGE_SIZE
    assert used == 2
    assert calls[1][1]["end_time"] == str(1767261600000 * 1_000_000)
    assert sleeps == [1.0]
    assert {method for method, _params in calls} == {"private/get-trades"}
