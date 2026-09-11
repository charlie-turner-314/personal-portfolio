import hashlib
import hmac
import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from app.integrations.binance_adapter import (
    BASE_URL,
    BinanceAdapter,
    BinancePermissionError,
    BinanceReadOnlyClient,
    BinanceTransientError,
)
from app.services.investment_activity_service import validate_batch


FIXTURES = Path(__file__).parent / "fixtures"


def _fixture(name):
    return json.loads((FIXTURES / name).read_text())


def test_signed_get_percent_encodes_before_hmac_and_has_read_only_allowlist():
    seen = {}

    def handler(request: httpx.Request):
        seen["request"] = request
        return httpx.Response(200, json={"balances": []})

    client = BinanceReadOnlyClient(
        api_key="public-key",
        api_secret="private-secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
        clock_ms=lambda: 1770736694138,
    )
    try:
        client.signed_get("/api/v3/account", {"label": "A B+C"})
        request = seen["request"]
        unsigned = "label=A+B%2BC&recvWindow=5000&timestamp=1770736694138"
        signature = hmac.new(b"private-secret", unsigned.encode(), hashlib.sha256).hexdigest()
        assert str(request.url) == f"{BASE_URL}/api/v3/account?{unsigned}&signature={signature}"
        assert request.headers["X-MBX-APIKEY"] == "public-key"
        with pytest.raises(ValueError, match="read-only allowlist"):
            client.signed_get("/api/v3/order", {"symbol": "BTCAUD"})
    finally:
        client.close()


def test_read_only_verification_rejects_any_enabled_movement_permission():
    def handler(request: httpx.Request):
        if request.url.path == "/api/v3/time":
            return httpx.Response(200, json={"serverTime": 1770736694138})
        return httpx.Response(200, json={
            "enableReading": True,
            "enableWithdrawals": False,
            "enableSpotAndMarginTrading": True,
        })

    adapter = BinanceAdapter(BinanceReadOnlyClient(
        api_key="key", api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0, clock_ms=lambda: 1770736694138,
    ))
    try:
        with pytest.raises(BinancePermissionError, match="spot or margin trading"):
            adapter.verify_read_only()
    finally:
        adapter.close()


def test_rate_limit_respects_retry_after_and_recovers():
    calls = 0
    sleeps = []

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"Retry-After": "7"}, json={"code": -1003})
        return httpx.Response(200, json={"balances": []})

    client = BinanceReadOnlyClient(
        api_key="key", api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=1, sleep=sleeps.append, clock_ms=lambda: 1770736694138,
    )
    try:
        assert client.signed_get("/api/v3/account") == {"balances": []}
        assert sleeps == [7.0]
    finally:
        client.close()


def test_long_rate_limit_is_returned_for_durable_backoff_without_sleeping():
    client = BinanceReadOnlyClient(
        api_key="key", api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                418, headers={"Retry-After": "3600"}, json={"code": -1003},
            )
        )),
        retries=3,
        sleep=lambda _delay: pytest.fail("long cooldown must not block a worker"),
        clock_ms=lambda: 1770736694138,
    )
    try:
        with pytest.raises(BinanceTransientError) as error:
            client.signed_get("/api/v3/account")
        assert error.value.retry_after_seconds == 3600
    finally:
        client.close()


def test_timestamp_drift_refreshes_server_offset_without_consuming_retry_budget():
    signed_calls = 0

    def handler(request: httpx.Request):
        nonlocal signed_calls
        if request.url.path == "/api/v3/time":
            return httpx.Response(200, json={"serverTime": 2000})
        signed_calls += 1
        if signed_calls == 1:
            return httpx.Response(400, json={"code": -1021, "msg": "outside recvWindow"})
        assert "timestamp=2000" in str(request.url)
        return httpx.Response(200, json={"balances": []})

    client = BinanceReadOnlyClient(
        api_key="key", api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0, clock_ms=lambda: 1000,
    )
    try:
        assert client.signed_get("/api/v3/account") == {"balances": []}
        assert signed_calls == 2
    finally:
        client.close()


class _FixtureClient:
    def __init__(self):
        self.request_count = 0
        self.trade_queries = []

    def close(self):
        pass

    def signed_get(self, path, params=None):
        self.request_count += 1
        params = params or {}
        if path == "/api/v3/account":
            return _fixture("binance_account.json")
        if path == "/sapi/v1/capital/deposit/hisrec":
            return _fixture("binance_deposits.json")
        if path == "/sapi/v1/capital/withdraw/history":
            return _fixture("binance_withdrawals.json")
        if path == "/sapi/v1/convert/tradeFlow":
            return _fixture("binance_convert.json")
        if path.endswith("flexible/history/rewardsRecord"):
            return _fixture("binance_flexible_rewards.json")
        if path.endswith("locked/history/rewardsRecord"):
            return _fixture("binance_locked_rewards.json")
        if path == "/api/v3/myTrades":
            self.trade_queries.append(dict(params))
            return _fixture("binance_trades.json") if params["symbol"] == "BTCUSDT" else []
        raise AssertionError(path)

    def public_get(self, path, params=None):
        self.request_count += 1
        if path == "/api/v3/exchangeInfo":
            return _fixture("binance_exchange_info.json")
        if path == "/api/v3/ticker/price":
            return _fixture("binance_prices.json")
        raise AssertionError(path)


def test_balances_and_all_supported_histories_normalize_from_sanitized_fixtures():
    client = _FixtureClient()
    adapter = BinanceAdapter(client)
    balances = adapter.fetch_balances()
    assert [(row.symbol, row.quantity) for row in balances] == [
        ("BTC", Decimal("0.50000000")),
        ("USDT", Decimal("100.00000000")),
    ]
    assert balances[0].aud_rate == Decimal("60000") / Decimal("0.65000000")

    history = adapter.fetch_history(
        start=date(2026, 1, 1),
        end=date(2026, 1, 10),
        configured_trade_symbols=["BTCUSDT", "UNKNOWNPAIR"],
        current_assets=[row.symbol for row in balances],
    )
    validated = validate_batch(history.batch, account_id=uuid4())
    assert len(validated.records) == 7
    assert history.pending_records == 2
    assert history.trade_symbols == ("BTCUSDT", "ETHUSDT")
    assert any("UNKNOWNPAIR" in warning for warning in history.missing_product_warnings)
    assert any("sold-out historical" in warning for warning in history.missing_product_warnings)

    activities = [activity for record in validated.records for activity in record.activities]
    assert {activity.activity_type for activity in activities} == {
        "deposit", "withdrawal", "crypto_swap", "interest", "staking_reward",
    }
    fills = [record for record in validated.records if record.provider_record_id.startswith("spot-fill:")]
    assert [record.provider_record_id for record in fills] == [
        "spot-fill:BTCUSDT:28457", "spot-fill:BTCUSDT:28458",
    ]
    assert fills[0].activities[0].external_group_id == fills[1].activities[0].external_group_id
    assert fills[0].activities[0].fee_currency == "BTC"
    assert fills[1].activities[0].fee_currency == "BNB"
    assert any(query["symbol"] == "BTCUSDT" and "startTime" in query for query in client.trade_queries)


def test_overlapping_fetches_emit_the_same_provider_record_ids():
    adapter = BinanceAdapter(_FixtureClient())
    first = adapter.fetch_history(
        start=date(2026, 1, 1), end=date(2026, 1, 10),
        configured_trade_symbols=["BTCUSDT"], current_assets=["BTC", "USDT"],
    )
    second = adapter.fetch_history(
        start=date(2026, 1, 2), end=date(2026, 1, 10),
        configured_trade_symbols=["BTCUSDT"], current_assets=["BTC", "USDT"],
    )
    first_ids = {record.provider_record_id for record in first.batch.records}
    second_ids = {record.provider_record_id for record in second.batch.records}
    assert first_ids == second_ids


def test_capital_history_uses_bounded_windows_and_offset_pagination():
    class Client:
        def __init__(self):
            self.calls = []

        def signed_get(self, path, params):
            self.calls.append((path, dict(params)))
            return []

    client = Client()
    adapter = BinanceAdapter(client)
    records, pending, calls = adapter._capital_records(
        date(2025, 1, 1), date(2025, 7, 1)
    )
    assert records == []
    assert pending == 0
    assert calls == 6
    starts_ends = [(params["startTime"], params["endTime"]) for _, params in client.calls]
    assert all(end - start < 90 * 24 * 60 * 60 * 1000 for start, end in starts_ends)

    paging = Client()
    pages = 0

    def paged(_path, params):
        nonlocal pages
        pages += 1
        paging.calls.append((_path, dict(params)))
        return ([{}] * 1000) if pages == 1 else [{}]

    paging.signed_get = paged
    rows, used = BinanceAdapter(paging)._paged_window(
        "/sapi/v1/capital/deposit/hisrec", date(2026, 1, 1), date(2026, 1, 2)
    )
    assert len(rows) == 1001
    assert used == 2
    assert [params["offset"] for _, params in paging.calls] == [0, 1000]


def test_spot_fill_pagination_advances_by_fill_id_without_querying_orders():
    class Client:
        def __init__(self):
            self.calls = []

        def signed_get(self, path, params):
            assert path == "/api/v3/myTrades"
            self.calls.append(dict(params))
            start_id = 0 if "startTime" in params else params["fromId"]
            count = 1000 if len(self.calls) == 1 else 1
            return [{
                "symbol": "BTCUSDT", "id": start_id + index, "orderId": 42,
                "price": "50000", "qty": "0.001", "quoteQty": "50",
                "commission": "0", "commissionAsset": "BTC",
                "time": 1767225600000 + index, "isBuyer": True,
            } for index in range(count)]

    client = Client()
    records, calls = BinanceAdapter(client)._trade_records(
        symbols=["BTCUSDT"], symbol_map={"BTCUSDT": ("BTC", "USDT")},
        start=date(2026, 1, 1), end=date(2026, 1, 2),
    )
    assert len(records) == 1001
    assert calls == 2
    assert "startTime" in client.calls[0]
    assert client.calls[1]["fromId"] == 1000
    assert all(record.provider_record_id.startswith("spot-fill:") for record in records)
