"""Least-privilege Binance Spot client and canonical investment adapter.

Only read-only USER_DATA and public market-data endpoints are addressable from
this module.  Binance's Spot trade-history endpoint is symbol-scoped, so a
complete import can require user-supplied historical pairs when every asset in
a sold-out pair has disappeared from the current account and other histories.
That limitation is returned as an explicit warning rather than hidden.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import urlencode

import httpx

from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
)


BASE_URL = "https://api.binance.com"
HISTORY_WINDOW_DAYS = 89
CONVERT_WINDOW_DAYS = 30
PAGE_LIMIT = 1000
EARN_PAGE_SIZE = 100
MAX_PAGES = 10_000
FIAT_CODES = frozenset({"AUD", "CAD", "CHF", "EUR", "GBP", "HKD", "JPY", "NZD", "SGD", "USD"})

# This allowlist is the main safety boundary. There is deliberately no generic
# signed-request method exposed to adapters or routes and no TRADE endpoint.
SIGNED_READ_ONLY_PATHS = frozenset({
    "/sapi/v1/account/apiRestrictions",
    "/api/v3/account",
    "/api/v3/myTrades",
    "/sapi/v1/capital/deposit/hisrec",
    "/sapi/v1/capital/withdraw/history",
    "/sapi/v1/convert/tradeFlow",
    "/sapi/v1/simple-earn/flexible/history/rewardsRecord",
    "/sapi/v1/simple-earn/locked/history/rewardsRecord",
})
PUBLIC_PATHS = frozenset({"/api/v3/time", "/api/v3/exchangeInfo", "/api/v3/ticker/price"})


class BinanceError(RuntimeError):
    pass


class BinanceAuthError(BinanceError):
    pass


class BinancePermissionError(BinanceAuthError):
    pass


class BinanceTransientError(BinanceError):
    def __init__(self, message: str, *, retry_after_seconds: float | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class BinanceHistoryLimitError(BinanceError):
    pass


class BinanceProductUnavailableError(BinanceError):
    pass


@dataclass(frozen=True)
class BinanceBalance:
    symbol: str
    quantity: Decimal
    aud_rate: Decimal
    aud_balance: Decimal


@dataclass(frozen=True)
class BinanceHistoryResult:
    batch: InvestmentActivityBatch
    pending_records: int
    windows_requested: int
    trade_symbols: tuple[str, ...]
    missing_product_warnings: tuple[str, ...]


def _decimal(value: Any, *, field: str, default: Decimal | None = None) -> Decimal:
    if value is None or value == "":
        if default is not None:
            return default
        raise BinanceError(f"Binance response is missing {field}")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise BinanceError(f"Binance response field {field} is not numeric") from exc
    if not result.is_finite():
        raise BinanceError(f"Binance response field {field} is not finite")
    return result


def _milliseconds(value: Any, *, field: str) -> datetime:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise BinanceError(f"Binance response field {field} is not a millisecond timestamp") from exc
    return datetime.fromtimestamp(parsed / 1000, tz=timezone.utc).replace(tzinfo=None)


def _utc_text(value: Any, *, field: str) -> datetime:
    rendered = str(value or "").strip()
    if not rendered:
        raise BinanceError(f"Binance response is missing {field}")
    try:
        parsed = datetime.fromisoformat(rendered.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.strptime(rendered, "%Y-%m-%d %H:%M:%S")
        except ValueError as exc:
            raise BinanceError(f"Binance response field {field} is not a UTC timestamp") from exc
    if parsed.tzinfo:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _symbol(value: Any) -> str:
    rendered = str(value or "").strip().upper()
    if not rendered or len(rendered) > 64:
        raise BinanceError("Binance response contains an invalid asset symbol")
    return rendered


def _stable_id(prefix: str, row: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return f"{prefix}:{value}"
    digest = hashlib.sha256(
        json.dumps(row, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return f"{prefix}:{digest}"


def _day_start_ms(value: date) -> int:
    return int(datetime.combine(value, datetime_time.min, tzinfo=timezone.utc).timestamp() * 1000)


def _day_end_ms(value: date) -> int:
    return int(datetime.combine(value, datetime_time.max, tzinfo=timezone.utc).timestamp() * 1000)


class BinanceReadOnlyClient:
    """HMAC client whose endpoint allowlist cannot place trades or move funds."""

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        client: httpx.Client | None = None,
        base_url: str = BASE_URL,
        retries: int = 3,
        backoff_seconds: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        clock_ms: Callable[[], int] | None = None,
    ):
        if base_url.rstrip("/") != BASE_URL:
            raise ValueError("Binance client base URL must be the documented production API host")
        self._api_key = api_key
        self._api_secret = api_secret
        self._client = client or httpx.Client(timeout=30.0)
        self._base_url = BASE_URL
        self._retries = retries
        self._backoff_seconds = backoff_seconds
        self._sleep = sleep
        self._clock_ms = clock_ms or (lambda: time.time_ns() // 1_000_000)
        self._server_offset_ms = 0
        self.request_count = 0

    def close(self) -> None:
        self._client.close()

    def _retry_delay(self, response: httpx.Response, attempt: int) -> float:
        retry_after = response.headers.get("Retry-After")
        try:
            return max(float(retry_after), 0) if retry_after else self._backoff_seconds * (2 ** attempt)
        except ValueError:
            return self._backoff_seconds * (2 ** attempt)

    def _get(self, path: str, params: Mapping[str, Any] | None = None, *, signed: bool) -> Any:
        allowed = SIGNED_READ_ONLY_PATHS if signed else PUBLIC_PATHS
        if path not in allowed:
            raise ValueError("Binance endpoint is outside the read-only allowlist")
        refreshed_time = False
        last_error: BinanceTransientError | None = None
        attempt = 0
        while attempt <= self._retries:
            request_params = {key: value for key, value in dict(params or {}).items() if value is not None}
            if signed:
                request_params["recvWindow"] = 5000
                request_params["timestamp"] = self._clock_ms() + self._server_offset_ms
            encoded = urlencode(request_params, doseq=True)
            if signed:
                # Binance requires percent-encoding before HMAC calculation.
                signature = hmac.new(
                    self._api_secret.encode(), encoded.encode(), hashlib.sha256
                ).hexdigest()
                encoded = f"{encoded}&signature={signature}"
            url = f"{self._base_url}{path}" + (f"?{encoded}" if encoded else "")
            try:
                self.request_count += 1
                response = self._client.get(
                    url,
                    headers={"X-MBX-APIKEY": self._api_key} if signed else {},
                    timeout=30.0,
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = BinanceTransientError("Binance is temporarily unreachable")
                if attempt >= self._retries:
                    raise last_error from exc
                self._sleep(self._backoff_seconds * (2 ** attempt))
                attempt += 1
                continue

            try:
                payload = response.json()
            except ValueError as exc:
                if response.status_code >= 500:
                    payload = None
                else:
                    raise BinanceError("Binance returned an invalid response") from exc

            code = payload.get("code") if isinstance(payload, Mapping) else None
            if code == -1021 and signed and not refreshed_time:
                refreshed_time = True
                self.sync_server_time()
                continue
            if response.status_code in {401, 403} or code in {-1002, -1022, -2014, -2015}:
                raise BinanceAuthError("Binance rejected the read-only API credentials")
            if response.status_code in {418, 429} or response.status_code >= 500 or code in {-1001, -1003, -1006, -1007}:
                delay = self._retry_delay(response, attempt)
                last_error = BinanceTransientError(
                    "Binance is temporarily unavailable or rate limited",
                    retry_after_seconds=delay if response.status_code in {418, 429} else None,
                )
                if attempt >= self._retries:
                    raise last_error
                # Persist long server-directed cooldowns in connection health;
                # tying up a web/Celery worker for minutes or days is unsafe.
                if delay > 30:
                    raise last_error
                self._sleep(delay)
                attempt += 1
                continue
            if response.status_code >= 400 or (isinstance(code, int) and code < 0):
                if code in {-1128, -12014, -6006, -7001}:
                    raise BinanceProductUnavailableError("This Binance product history is unavailable for the account")
                raise BinanceError("Binance rejected a read-only request")
            if not isinstance(payload, (Mapping, list)):
                raise BinanceError("Binance returned an invalid response object")
            return payload
        assert last_error is not None
        raise last_error

    def public_get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        return self._get(path, params, signed=False)

    def signed_get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        return self._get(path, params, signed=True)

    def sync_server_time(self) -> None:
        payload = self.public_get("/api/v3/time")
        if not isinstance(payload, Mapping) or "serverTime" not in payload:
            raise BinanceError("Binance server-time response is malformed")
        self._server_offset_ms = int(payload["serverTime"]) - self._clock_ms()

    def verify_read_only(self) -> Mapping[str, Any]:
        self.sync_server_time()
        permissions = self.signed_get("/sapi/v1/account/apiRestrictions")
        if not isinstance(permissions, Mapping):
            raise BinanceError("Binance API-permission response is malformed")
        if permissions.get("enableReading") is not True:
            raise BinancePermissionError("Binance API key does not have reading enabled")
        forbidden = {
            "enableWithdrawals": "withdrawals",
            "enableSpotAndMarginTrading": "spot or margin trading",
            "enableMargin": "margin trading",
            "enableFutures": "futures trading",
            "enableVanillaOptions": "options trading",
            "enablePortfolioMarginTrading": "portfolio margin trading",
            "enableFixApiTrade": "FIX trading",
            "enableInternalTransfer": "internal transfers",
            "permitsUniversalTransfer": "universal transfers",
        }
        enabled = [label for field, label in forbidden.items() if permissions.get(field) is True]
        if enabled:
            raise BinancePermissionError(
                "Binance API key has non-read permissions enabled: " + ", ".join(enabled)
            )
        return permissions


class BinanceAdapter:
    provider = "binance"
    normalization_version = "binance-spot-v1"

    def __init__(self, client: BinanceReadOnlyClient):
        self.client = client

    def close(self) -> None:
        self.client.close()

    def verify_read_only(self) -> None:
        self.client.verify_read_only()

    def _exchange_symbols(self) -> dict[str, tuple[str, str]]:
        payload = self.client.public_get("/api/v3/exchangeInfo")
        rows = payload.get("symbols") if isinstance(payload, Mapping) else None
        if not isinstance(rows, list):
            raise BinanceError("Binance exchange-information response is malformed")
        result: dict[str, tuple[str, str]] = {}
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            symbol = _symbol(row.get("symbol"))
            result[symbol] = (_symbol(row.get("baseAsset")), _symbol(row.get("quoteAsset")))
        return result

    def _prices(self) -> dict[str, Decimal]:
        payload = self.client.public_get("/api/v3/ticker/price")
        if not isinstance(payload, list):
            raise BinanceError("Binance price response is malformed")
        result: dict[str, Decimal] = {}
        for row in payload:
            if not isinstance(row, Mapping):
                continue
            try:
                price = _decimal(row.get("price"), field="price")
                symbol = _symbol(row.get("symbol"))
            except BinanceError:
                continue
            if price > 0:
                result[symbol] = price
        return result

    @staticmethod
    def _aud_rate(asset: str, prices: Mapping[str, Decimal]) -> Decimal:
        if asset == "AUD":
            return Decimal("1")
        direct = prices.get(f"{asset}AUD")
        if direct:
            return direct
        inverse = prices.get(f"AUD{asset}")
        if inverse:
            return Decimal("1") / inverse
        if asset == "USDT" and prices.get("AUDUSDT"):
            return Decimal("1") / prices["AUDUSDT"]
        asset_usdt, aud_usdt = prices.get(f"{asset}USDT"), prices.get("AUDUSDT")
        if asset_usdt and aud_usdt:
            return asset_usdt / aud_usdt
        asset_btc, btc_aud = prices.get(f"{asset}BTC"), prices.get("BTCAUD")
        if asset_btc and btc_aud:
            return asset_btc * btc_aud
        return Decimal("0")

    def fetch_balances(self) -> tuple[BinanceBalance, ...]:
        payload = self.client.signed_get("/api/v3/account", {"omitZeroBalances": "true"})
        rows = payload.get("balances") if isinstance(payload, Mapping) else None
        if not isinstance(rows, list):
            raise BinanceError("Binance account response is missing balances")
        prices = self._prices()
        balances: list[BinanceBalance] = []
        for row in rows:
            if not isinstance(row, Mapping):
                raise BinanceError("Binance balance entry is malformed")
            asset = _symbol(row.get("asset"))
            quantity = _decimal(row.get("free"), field="free") + _decimal(row.get("locked"), field="locked")
            if quantity == 0:
                continue
            aud_rate = self._aud_rate(asset, prices)
            balances.append(BinanceBalance(asset, quantity, aud_rate, quantity * aud_rate))
        return tuple(balances)

    def _paged_window(
        self, path: str, start: date, end: date, *, page_size: int = PAGE_LIMIT
    ) -> tuple[list[Mapping[str, Any]], int]:
        result: list[Mapping[str, Any]] = []
        calls = 0
        offset = 0
        while True:
            payload = self.client.signed_get(path, {
                "startTime": _day_start_ms(start), "endTime": _day_end_ms(end),
                "offset": offset, "limit": page_size,
            })
            calls += 1
            if not isinstance(payload, list) or any(not isinstance(row, Mapping) for row in payload):
                raise BinanceError("Binance paginated history response is malformed")
            result.extend(payload)
            if len(payload) < page_size:
                return result, calls
            offset += page_size
            if calls >= MAX_PAGES:
                raise BinanceHistoryLimitError("Binance history exceeded the safe pagination limit")

    def _capital_records(self, start: date, end: date) -> tuple[list[SourceRecordEnvelope], int, int]:
        records: list[SourceRecordEnvelope] = []
        pending = 0
        calls = 0
        cursor = start
        while cursor <= end:
            window_end = min(end, cursor + timedelta(days=HISTORY_WINDOW_DAYS))
            deposits, used = self._paged_window("/sapi/v1/capital/deposit/hisrec", cursor, window_end)
            calls += used
            withdrawals, used = self._paged_window("/sapi/v1/capital/withdraw/history", cursor, window_end)
            calls += used
            for row in deposits:
                if int(row.get("status", -1)) not in {1, 6}:
                    pending += 1
                    continue
                occurred_at = _milliseconds(row.get("completeTime") or row.get("insertTime"), field="insertTime")
                asset = _symbol(row.get("coin"))
                quantity = abs(_decimal(row.get("amount"), field="amount"))
                txid = str(row.get("txId") or "").strip() or None
                records.append(SourceRecordEnvelope(
                    occurred_at=occurred_at,
                    provider_record_id=_stable_id("deposit", row, "id", "txId"),
                    raw_payload=dict(row),
                    activities=(CanonicalActivityInput(
                        activity_type="deposit", occurred_at=occurred_at,
                        asset_symbol=asset, asset_type="cash" if asset in FIAT_CODES else "crypto",
                        quantity=quantity, direction="in", external_group_id=txid,
                        assumptions=("Binance capital history is treated as an external transfer candidate.",),
                        metadata={"binance_endpoint": "capital/deposit/hisrec", "transaction_hash": txid, "network": row.get("network")},
                    ),),
                    metadata={"binance_endpoint": "capital/deposit/hisrec"},
                ))
            for row in withdrawals:
                if int(row.get("status", -1)) != 6:
                    pending += 1
                    continue
                occurred_at = (
                    _utc_text(row.get("completeTime"), field="completeTime")
                    if row.get("completeTime") else _utc_text(row.get("applyTime"), field="applyTime")
                )
                asset = _symbol(row.get("coin"))
                quantity = abs(_decimal(row.get("amount"), field="amount"))
                fee = abs(_decimal(row.get("transactionFee"), field="transactionFee", default=Decimal(0)))
                txid = str(row.get("txId") or "").strip() or None
                records.append(SourceRecordEnvelope(
                    occurred_at=occurred_at,
                    provider_record_id=_stable_id("withdrawal", row, "id", "txId"),
                    raw_payload=dict(row),
                    activities=(CanonicalActivityInput(
                        activity_type="withdrawal", occurred_at=occurred_at,
                        asset_symbol=asset, asset_type="cash" if asset in FIAT_CODES else "crypto",
                        quantity=quantity, direction="out", fee_amount=fee or None,
                        fee_currency=asset if fee else None, external_group_id=txid,
                        assumptions=("Binance capital history is treated as an external transfer candidate.",),
                        metadata={"binance_endpoint": "capital/withdraw/history", "transaction_hash": txid, "network": row.get("network")},
                    ),),
                    metadata={"binance_endpoint": "capital/withdraw/history"},
                ))
            cursor = window_end + timedelta(days=1)
        return records, pending, calls

    def _convert_window(self, start_ms: int, end_ms: int) -> tuple[list[Mapping[str, Any]], int]:
        payload = self.client.signed_get("/sapi/v1/convert/tradeFlow", {
            "startTime": start_ms, "endTime": end_ms, "limit": PAGE_LIMIT,
        })
        if not isinstance(payload, Mapping) or not isinstance(payload.get("list"), list):
            raise BinanceError("Binance Convert history response is malformed")
        rows = payload["list"]
        if not payload.get("moreData") and len(rows) < PAGE_LIMIT:
            return rows, 1
        if start_ms >= end_ms:
            raise BinanceHistoryLimitError("Binance Convert history exceeded the safe per-millisecond limit")
        midpoint = start_ms + (end_ms - start_ms) // 2
        left, left_calls = self._convert_window(start_ms, midpoint)
        right, right_calls = self._convert_window(midpoint + 1, end_ms)
        return left + right, 1 + left_calls + right_calls

    def _convert_records(self, start: date, end: date) -> tuple[list[SourceRecordEnvelope], int]:
        rows: list[Mapping[str, Any]] = []
        calls = 0
        cursor = start
        while cursor <= end:
            window_end = min(end, cursor + timedelta(days=CONVERT_WINDOW_DAYS - 1))
            found, used = self._convert_window(_day_start_ms(cursor), _day_end_ms(window_end))
            rows.extend(found)
            calls += used
            cursor = window_end + timedelta(days=1)
        records: list[SourceRecordEnvelope] = []
        for row in rows:
            if str(row.get("orderStatus") or "SUCCESS").upper() != "SUCCESS":
                continue
            occurred_at = _milliseconds(row.get("createTime"), field="createTime")
            source, target = _symbol(row.get("fromAsset")), _symbol(row.get("toAsset"))
            source_quantity = abs(_decimal(row.get("fromAmount"), field="fromAmount"))
            target_quantity = abs(_decimal(row.get("toAmount"), field="toAmount"))
            common = {
                "occurred_at": occurred_at, "asset_type": "crypto",
                "external_group_id": _stable_id("convert", row, "orderId", "quoteId"),
                "metadata": {"binance_endpoint": "convert/tradeFlow", "quote_id": row.get("quoteId")},
            }
            if source in FIAT_CODES and target not in FIAT_CODES:
                activity = CanonicalActivityInput(
                    activity_type="buy", asset_symbol=target, quantity=target_quantity,
                    price=source_quantity / target_quantity, currency=source,
                    aud_value=source_quantity if source == "AUD" else None, **common,
                )
            elif target in FIAT_CODES and source not in FIAT_CODES:
                activity = CanonicalActivityInput(
                    activity_type="sell", asset_symbol=source, quantity=source_quantity,
                    price=target_quantity / source_quantity, currency=target,
                    aud_value=target_quantity if target == "AUD" else None, **common,
                )
            else:
                activity = CanonicalActivityInput(
                    activity_type="crypto_swap", asset_symbol=source, quantity=source_quantity,
                    counter_asset_symbol=target, counter_quantity=target_quantity,
                    warnings=("Binance Convert does not report an event-time AUD market value.",),
                    **common,
                )
            records.append(SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=_stable_id("convert", row, "orderId", "quoteId"),
                raw_payload=dict(row), activities=(activity,),
                metadata={"binance_endpoint": "convert/tradeFlow"},
            ))
        return records, calls

    def _earn_records(self, start: date, end: date) -> tuple[list[SourceRecordEnvelope], int, list[str]]:
        records: list[SourceRecordEnvelope] = []
        calls = 0
        warnings: list[str] = []
        products = (
            ("flexible", "interest"),
            ("locked", "staking_reward"),
        )
        for product, activity_type in products:
            path = f"/sapi/v1/simple-earn/{product}/history/rewardsRecord"
            try:
                cursor = start
                while cursor <= end:
                    window_end = min(end, cursor + timedelta(days=CONVERT_WINDOW_DAYS - 1))
                    current = 1
                    while True:
                        payload = self.client.signed_get(path, {
                            "startTime": _day_start_ms(cursor), "endTime": _day_end_ms(window_end),
                            "current": current, "size": EARN_PAGE_SIZE,
                        })
                        calls += 1
                        rows = payload.get("rows") if isinstance(payload, Mapping) else None
                        if not isinstance(rows, list):
                            raise BinanceError(f"Binance Simple Earn {product} response is malformed")
                        for row in rows:
                            if not isinstance(row, Mapping):
                                raise BinanceError(f"Binance Simple Earn {product} row is malformed")
                            occurred_at = _milliseconds(row.get("time"), field="time")
                            asset = _symbol(row.get("asset"))
                            amount_field = "rewards" if product == "flexible" else "amount"
                            amount = abs(_decimal(row.get(amount_field), field=amount_field))
                            if amount == 0:
                                continue
                            provider_id = _stable_id(f"earn:{product}", row, "tranId")
                            records.append(SourceRecordEnvelope(
                                occurred_at=occurred_at, provider_record_id=provider_id,
                                raw_payload=dict(row),
                                activities=(CanonicalActivityInput(
                                    activity_type=activity_type, occurred_at=occurred_at,
                                    asset_symbol=asset, asset_type="crypto", quantity=amount,
                                    warnings=("Binance Simple Earn does not report an event-time AUD market value.",),
                                    metadata={"binance_endpoint": f"simple-earn/{product}/rewardsRecord", "reward_type": row.get("type")},
                                ),),
                                metadata={"binance_endpoint": f"simple-earn/{product}/rewardsRecord"},
                            ))
                        total = int(payload.get("total") or len(rows))
                        if current * EARN_PAGE_SIZE >= total or len(rows) < EARN_PAGE_SIZE:
                            break
                        current += 1
                        if current > MAX_PAGES:
                            raise BinanceHistoryLimitError("Binance Simple Earn history exceeded the safe pagination limit")
                    cursor = window_end + timedelta(days=1)
            except BinanceProductUnavailableError:
                warnings.append(f"Binance Simple Earn {product} reward history is unavailable for this account.")
        return records, calls, warnings

    def _trade_records(
        self,
        *,
        symbols: Iterable[str],
        symbol_map: Mapping[str, tuple[str, str]],
        start: date,
        end: date,
    ) -> tuple[list[SourceRecordEnvelope], int]:
        records: list[SourceRecordEnvelope] = []
        calls = 0
        end_ms = _day_end_ms(end)
        for symbol in sorted(set(symbols)):
            from_id: int | None = None
            pages = 0
            while True:
                params: dict[str, Any] = {"symbol": symbol, "limit": PAGE_LIMIT}
                if from_id is None:
                    params["startTime"] = _day_start_ms(start)
                else:
                    params["fromId"] = from_id
                payload = self.client.signed_get("/api/v3/myTrades", params)
                calls += 1
                pages += 1
                if not isinstance(payload, list) or any(not isinstance(row, Mapping) for row in payload):
                    raise BinanceError("Binance Spot trade history response is malformed")
                filtered = [row for row in payload if int(row.get("time", 0)) <= end_ms]
                base, quote = symbol_map[symbol]
                for row in filtered:
                    occurred_at = _milliseconds(row.get("time"), field="time")
                    quantity = abs(_decimal(row.get("qty"), field="qty"))
                    quote_quantity = abs(_decimal(row.get("quoteQty"), field="quoteQty"))
                    price = abs(_decimal(row.get("price"), field="price"))
                    is_buyer = bool(row.get("isBuyer"))
                    fee = abs(_decimal(row.get("commission"), field="commission", default=Decimal(0)))
                    fee_asset = _symbol(row.get("commissionAsset")) if fee else None
                    group = f"spot-order:{symbol}:{row.get('orderId')}"
                    common = {
                        "occurred_at": occurred_at, "asset_type": "crypto",
                        "fee_amount": fee or None, "fee_currency": fee_asset,
                        "external_group_id": group,
                        "metadata": {"binance_endpoint": "api/v3/myTrades", "symbol": symbol, "order_id": row.get("orderId"), "fill_id": row.get("id")},
                    }
                    if quote in FIAT_CODES:
                        activity = CanonicalActivityInput(
                            activity_type="buy" if is_buyer else "sell",
                            asset_symbol=base, quantity=quantity, price=price, currency=quote,
                            aud_value=quote_quantity if quote == "AUD" else None,
                            **common,
                        )
                    elif is_buyer:
                        activity = CanonicalActivityInput(
                            activity_type="crypto_swap", asset_symbol=quote, quantity=quote_quantity,
                            counter_asset_symbol=base, counter_quantity=quantity,
                            warnings=("Binance Spot fills do not report an event-time AUD market value.",),
                            **common,
                        )
                    else:
                        activity = CanonicalActivityInput(
                            activity_type="crypto_swap", asset_symbol=base, quantity=quantity,
                            counter_asset_symbol=quote, counter_quantity=quote_quantity,
                            warnings=("Binance Spot fills do not report an event-time AUD market value.",),
                            **common,
                        )
                    provider_id = f"spot-fill:{symbol}:{row.get('id')}"
                    records.append(SourceRecordEnvelope(
                        occurred_at=occurred_at, provider_record_id=provider_id,
                        raw_payload=dict(row), activities=(activity,),
                        metadata={"binance_endpoint": "api/v3/myTrades", "symbol": symbol},
                    ))
                if len(payload) < PAGE_LIMIT or not payload or int(payload[-1].get("time", 0)) > end_ms:
                    break
                last_id = int(payload[-1].get("id"))
                if from_id is not None and last_id < from_id:
                    raise BinanceHistoryLimitError("Binance Spot trade pagination did not advance")
                from_id = last_id + 1
                if pages >= MAX_PAGES:
                    raise BinanceHistoryLimitError("Binance Spot trade history exceeded the safe pagination limit")
        return records, calls

    def fetch_history(
        self,
        *,
        start: date,
        end: date,
        configured_trade_symbols: Sequence[str] = (),
        current_assets: Sequence[str] = (),
    ) -> BinanceHistoryResult:
        if start > end:
            raise ValueError("Binance history start must not be after end")
        records, pending, calls = self._capital_records(start, end)
        convert_records, used = self._convert_records(start, end)
        records.extend(convert_records)
        calls += used
        earn_records, used, product_warnings = self._earn_records(start, end)
        records.extend(earn_records)
        calls += used

        symbol_map = self._exchange_symbols()
        evidence_assets = {_symbol(asset) for asset in current_assets}
        for record in records:
            for activity in record.activities:
                evidence_assets.add(activity.asset_symbol)
                if activity.counter_asset_symbol:
                    evidence_assets.add(activity.counter_asset_symbol)
                if activity.fee_currency:
                    evidence_assets.add(activity.fee_currency)
        configured = {_symbol(symbol) for symbol in configured_trade_symbols if str(symbol).strip()}
        invalid = sorted(configured - set(symbol_map))
        discovered = {
            symbol for symbol, (base, quote) in symbol_map.items()
            if base in evidence_assets and quote in evidence_assets
        }
        trade_symbols = (configured - set(invalid)) | discovered
        trade_records, used = self._trade_records(
            symbols=trade_symbols, symbol_map=symbol_map, start=start, end=end,
        )
        records.extend(trade_records)
        calls += used

        warnings = list(product_warnings)
        if invalid:
            warnings.append("Unknown or inactive Binance Spot pairs were skipped: " + ", ".join(invalid))
        warnings.append(
            "Binance trade history is symbol-scoped. Add any sold-out historical Spot pairs to the connection to guarantee completeness."
        )
        warnings.append(
            "Margin, futures, options, Funding wallet, P2P, Pay, NFT, and products other than Spot, Convert, and supported Simple Earn rewards are not imported."
        )
        batch = InvestmentActivityBatch(
            provider=self.provider,
            ingestion_type="api_sync",
            normalization_version=self.normalization_version,
            records=tuple(sorted(records, key=lambda item: (item.occurred_at, item.provider_record_id or ""))),
            cursor={"history_through": end.isoformat(), "trade_symbols": sorted(trade_symbols)},
            source_name=f"Binance {start.isoformat()} to {end.isoformat()}",
            warnings=tuple(warnings),
        )
        return BinanceHistoryResult(
            batch=batch, pending_records=pending, windows_requested=calls,
            trade_symbols=tuple(sorted(trade_symbols)),
            missing_product_warnings=tuple(warnings),
        )
