import hashlib
import hmac
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from app.integrations.coinspot_adapter import (
    ORDER_LIMIT,
    CoinSpotAdapter,
    CoinSpotAuthError,
    CoinSpotHistoryLimitError,
    CoinSpotReadOnlyClient,
)


FIXTURES = Path(__file__).parent / "fixtures"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_read_only_client_signs_exact_json_and_uses_monotonic_nonces():
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode()
        payload = json.loads(body)
        expected = hmac.new(b"secret", body.encode(), hashlib.sha512).hexdigest()
        assert str(request.url) == "https://www.coinspot.com.au/api/v2/ro/status"
        assert request.headers["key"] == "public-key"
        assert request.headers["sign"] == expected
        seen.append(payload)
        return httpx.Response(200, json={"status": "ok", "message": "ok"})

    client = CoinSpotReadOnlyClient(
        api_key="public-key",
        api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        nonce_factory=lambda: 100,
    )
    client.verify_read_only()
    client.verify_read_only()

    assert [item["nonce"] for item in seen] == [100, 101]


def test_read_only_client_retries_rate_limit_without_leaking_provider_message():
    calls = 0
    delays: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"Retry-After": "2"}, json={"status": "error"})
        return httpx.Response(200, json={"status": "ok", "message": "ok"})

    client = CoinSpotReadOnlyClient(
        api_key="public-key",
        api_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=delays.append,
        nonce_factory=lambda: 100,
    )
    client.verify_read_only()

    assert calls == 2
    assert delays == [2.0]


def test_read_only_client_maps_auth_failure_to_recoverable_error():
    client = CoinSpotReadOnlyClient(
        api_key="bad-key",
        api_secret="bad-secret",
        client=httpx.Client(transport=httpx.MockTransport(
            lambda _request: httpx.Response(400, json={"status": "error", "message": "invalid key"})
        )),
    )
    with pytest.raises(CoinSpotAuthError, match="read-only API credentials"):
        client.verify_read_only()


class _FixtureClient:
    def __init__(self):
        funding = _fixture("coinspot_funding.json")
        self._deposits = funding["deposits"]
        self._withdrawals = funding["withdrawals"]
        self.order_calls: list[tuple[date, date]] = []

    def verify_read_only(self):
        return None

    def balances(self):
        return _fixture("coinspot_balances.json")

    def orders(self, *, start, end):
        self.order_calls.append((start, end))
        return _fixture("coinspot_orders.json")

    def send_receive(self, **_kwargs):
        return _fixture("coinspot_sendreceive.json")

    def deposits(self, **_kwargs):
        return self._deposits

    def withdrawals(self, **_kwargs):
        return self._withdrawals


def test_adapter_normalizes_balances_orders_transfers_fees_and_funding():
    adapter = CoinSpotAdapter(_FixtureClient())
    balances = {item.symbol: item for item in adapter.fetch_balances()}
    result = adapter.fetch_history(start=date(2025, 1, 1), end=date(2025, 1, 10))
    activities = [record.activities[0] for record in result.batch.records]

    assert balances["BTC"].quantity == Decimal("0.75")
    assert balances["BTC"].aud_balance == Decimal("75000.00")
    assert [activity.activity_type for activity in activities] == [
        "deposit", "buy", "crypto_swap", "sell", "withdrawal", "deposit", "withdrawal"
    ]
    buy = next(activity for activity in activities if activity.activity_type == "buy")
    swap = next(activity for activity in activities if activity.activity_type == "crypto_swap")
    sent = next(activity for activity in activities if activity.activity_type == "withdrawal" and activity.asset_type == "crypto")
    assert (buy.asset_symbol, buy.aud_value, buy.fee_aud_value) == (
        "BTC", Decimal("100000"), Decimal("10.00")
    )
    assert (swap.asset_symbol, swap.counter_asset_symbol, swap.aud_value) == (
        "USDT", "ETH", Decimal("1600")
    )
    assert (sent.external_group_id, sent.fee_amount, sent.fee_currency) == (
        "chain-send-1", Decimal("0.0001"), "BTC"
    )
    assert result.pending_records == 1
    assert "pending CoinSpot AUD funding" in result.batch.warnings[0]


def test_order_history_recursively_splits_full_windows_and_preserves_date_boundaries():
    class FullWindowClient(_FixtureClient):
        def orders(self, *, start, end):
            self.order_calls.append((start, end))
            if start != end:
                return {"status": "ok", "buyorders": [{"id": str(index)} for index in range(ORDER_LIMIT)], "sellorders": []}
            return {"status": "ok", "buyorders": [], "sellorders": []}

        def send_receive(self, **_kwargs):
            return {"status": "ok", "sendtransactions": [], "receivetransactions": []}

        def deposits(self, **_kwargs):
            return {"status": "ok", "deposits": []}

        def withdrawals(self, **_kwargs):
            return {"status": "ok", "withdrawals": []}

    client = FullWindowClient()
    result = CoinSpotAdapter(client).fetch_history(start=date(2025, 1, 1), end=date(2025, 1, 2))

    assert client.order_calls == [
        (date(2025, 1, 1), date(2025, 1, 2)),
        (date(2025, 1, 1), date(2025, 1, 1)),
        (date(2025, 1, 2), date(2025, 1, 2)),
    ]
    assert result.windows_requested == 6
    assert result.batch.records == ()


def test_order_history_surfaces_unpageable_single_day_limit():
    class FullDayClient(_FixtureClient):
        def orders(self, *, start, end):
            return {"status": "ok", "buyorders": [{"id": str(index)} for index in range(ORDER_LIMIT)], "sellorders": []}

    with pytest.raises(CoinSpotHistoryLimitError, match="no further page cursor"):
        CoinSpotAdapter(FullDayClient()).fetch_history(start=date(2025, 1, 1), end=date(2025, 1, 1))


def test_long_coinspot_nft_identifiers_are_stably_preserved_outside_ledger_symbol():
    provider_symbol = "NFT|||0x12345f64363bd663abd3ef08df75dd22d853111|||12345678901234567890"

    class NftClient(_FixtureClient):
        def balances(self):
            return {
                "status": "ok",
                "balances": [{provider_symbol: {
                    "balance": "1", "audbalance": "25", "rate": "25",
                }}],
            }

    first = CoinSpotAdapter(NftClient()).fetch_balances()[0]
    second = CoinSpotAdapter(NftClient()).fetch_balances()[0]
    assert first.symbol == second.symbol
    assert first.symbol.startswith("COINSPOT:")
    assert len(first.symbol) <= 64
    assert first.provider_symbol == provider_symbol.upper()
