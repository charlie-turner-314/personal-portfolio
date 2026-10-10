"""Read-only Crypto.com Exchange v1 client and canonical activity adapter.

The Exchange API shares one namespace for reads and writes. This client therefore
uses an exact method allowlist and exposes no generic request primitive. Crypto.com
does not publish a permission-introspection endpoint; callers must separately
record the user's confirmation that the key has its default Can Read-only setting.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Mapping

import httpx

from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
)


BASE_URL = "https://api.crypto.com/exchange/v1"
CAPITAL_WINDOW_DAYS = 89
REWARD_WINDOW_DAYS = 179
CAPITAL_PAGE_SIZE = 200
HISTORY_PAGE_SIZE = 100
REWARD_PAGE_SIZE = 500
MAX_PAGES = 10_000
FIAT_CODES = frozenset({"AUD", "CAD", "CHF", "EUR", "GBP", "HKD", "JPY", "NZD", "SGD", "USD"})

# The safety boundary: every private method here is documented as a read.
PRIVATE_READ_METHODS = frozenset({
    "private/user-balance",
    "private/get-trades",
    "private/get-deposit-history",
    "private/get-withdrawal-history",
    "private/staking/get-reward-history",
})
PUBLIC_READ_METHODS = frozenset({"public/get-instruments", "public/get-tickers"})


class CryptoComExchangeError(RuntimeError):
    pass


class CryptoComExchangeAuthError(CryptoComExchangeError):
    pass


class CryptoComExchangeTransientError(CryptoComExchangeError):
    def __init__(self, message: str, *, retry_after_seconds: float | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class CryptoComExchangeHistoryLimitError(CryptoComExchangeError):
    pass


class CryptoComExchangeProductUnavailableError(CryptoComExchangeError):
    pass


@dataclass(frozen=True)
class CryptoComExchangeBalance:
    symbol: str
    quantity: Decimal
    aud_rate: Decimal
    aud_balance: Decimal


@dataclass(frozen=True)
class CryptoComExchangeHistoryResult:
    batch: InvestmentActivityBatch
    pending_records: int
    requests_made: int
    partial_product_failures: tuple[str, ...]
    missing_product_warnings: tuple[str, ...]


def _decimal(value: Any, *, field: str, default: Decimal | None = None) -> Decimal:
    if value is None or value == "":
        if default is not None:
            return default
        raise CryptoComExchangeError(f"Crypto.com Exchange response is missing {field}")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise CryptoComExchangeError(
            f"Crypto.com Exchange response field {field} is not numeric"
        ) from exc
    if not result.is_finite():
        raise CryptoComExchangeError(
            f"Crypto.com Exchange response field {field} is not finite"
        )
    return result


def _symbol(value: Any) -> str:
    result = str(value or "").strip().upper()
    if not result or len(result) > 64:
        raise CryptoComExchangeError("Crypto.com Exchange returned an invalid asset symbol")
    return result


def _milliseconds(value: Any, *, field: str) -> datetime:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError) as exc:
        raise CryptoComExchangeError(
            f"Crypto.com Exchange response field {field} is not a timestamp"
        ) from exc
    # History endpoints can return their recommended nanosecond timestamps.
    if abs(parsed) > 10**15:
        parsed //= 1_000_000
    return datetime.fromtimestamp(parsed / 1000, tz=timezone.utc).replace(tzinfo=None)


def _day_start_ms(value: date) -> int:
    return int(datetime.combine(value, datetime_time.min, tzinfo=timezone.utc).timestamp() * 1000)


def _day_end_ms(value: date) -> int:
    return int(datetime.combine(value, datetime_time.max, tzinfo=timezone.utc).timestamp() * 1000)


def _stable_id(prefix: str, row: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return f"{prefix}:{value}"
    digest = hashlib.sha256(
        json.dumps(row, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return f"{prefix}:{digest}"


def _params_string(value: Any) -> str:
    """Render nested parameters exactly as the Exchange signing specification."""
    if isinstance(value, Mapping):
        return "".join(
            f"{key}{_params_string(value[key])}" for key in sorted(value)
        )
    if isinstance(value, (list, tuple)):
        return "".join(_params_string(item) for item in value)
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


class CryptoComExchangeReadOnlyClient:
    """Signed client that cannot address Exchange trade or withdrawal methods."""

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
            raise ValueError("Crypto.com Exchange client must use the production v1 API host")
        self._api_key = api_key
        self._api_secret = api_secret
        self._client = client or httpx.Client(timeout=30.0)
        self._retries = retries
        self._backoff_seconds = backoff_seconds
        self._sleep = sleep
        self._clock_ms = clock_ms or (lambda: time.time_ns() // 1_000_000)
        self._request_id = 0
        self.request_count = 0

    def close(self) -> None:
        self._client.close()

    def pause(self, seconds: float) -> None:
        """Apply the documented per-method pacing without exposing the sleep hook."""
        self._sleep(seconds)

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int, fallback: float) -> float:
        retry_after = response.headers.get("Retry-After")
        try:
            return max(float(retry_after), 0) if retry_after else fallback * (2 ** attempt)
        except ValueError:
            return fallback * (2 ** attempt)

    @staticmethod
    def _response_error(method: str, response: httpx.Response, payload: Any) -> Exception | None:
        code = payload.get("code") if isinstance(payload, Mapping) else None
        if response.status_code in {401, 403} or code in {40101, 40102, 40103}:
            return CryptoComExchangeAuthError(
                "Crypto.com Exchange rejected the API key, signature, IP allowlist, or clock"
            )
        if code in {40002, 40401} or (code == 40104 and method.startswith("private/staking/")):
            return CryptoComExchangeProductUnavailableError(
                "A Crypto.com Exchange read-only product endpoint is unavailable for this account"
            )
        if response.status_code == 429 or response.status_code >= 500 or code in {40801, 42901, 50001}:
            return CryptoComExchangeTransientError(
                "Crypto.com Exchange is temporarily unavailable or rate limited",
                retry_after_seconds=(
                    CryptoComExchangeReadOnlyClient._retry_delay(response, 0, 1.0)
                    if response.status_code == 429 or code == 42901 else None
                ),
            )
        if response.status_code >= 400 or code not in {0, None}:
            return CryptoComExchangeError("Crypto.com Exchange rejected a read-only request")
        return None

    def private_post(self, method: str, params: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        if method not in PRIVATE_READ_METHODS:
            raise ValueError("Crypto.com Exchange method is outside the read-only allowlist")
        last_error: CryptoComExchangeTransientError | None = None
        for attempt in range(self._retries + 1):
            request_id = self._next_id()
            nonce = self._clock_ms()
            request_params = dict(params or {})
            signature_payload = f"{method}{request_id}{self._api_key}{_params_string(request_params)}{nonce}"
            # The exchange protocol requires HMAC-SHA256. Use the dedicated
            # HMAC digest API so security analysis does not mistake the API
            # secret for a password being hashed with raw SHA-256.
            # codeql[py/weak-sensitive-data-hashing]
            signature = hmac.digest(
                self._api_secret.encode(), signature_payload.encode(), "sha256"
            ).hex()
            body = {
                "id": request_id,
                "method": method,
                "api_key": self._api_key,
                "params": request_params,
                "nonce": nonce,
                "sig": signature,
            }
            try:
                self.request_count += 1
                response = self._client.post(
                    f"{BASE_URL}/{method}", json=body,
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                    timeout=30.0,
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = CryptoComExchangeTransientError(
                    "Crypto.com Exchange is temporarily unreachable"
                )
                if attempt >= self._retries:
                    raise last_error from exc
                self._sleep(self._backoff_seconds * (2 ** attempt))
                continue
            try:
                payload = response.json()
            except ValueError as exc:
                if response.status_code >= 500:
                    payload = None
                else:
                    raise CryptoComExchangeError(
                        "Crypto.com Exchange returned an invalid response"
                    ) from exc
            error = self._response_error(method, response, payload)
            if isinstance(error, CryptoComExchangeTransientError):
                delay = self._retry_delay(response, attempt, self._backoff_seconds)
                error.retry_after_seconds = delay if error.retry_after_seconds is not None else None
                last_error = error
                if attempt >= self._retries or delay > 30:
                    raise error
                self._sleep(delay)
                continue
            if error is not None:
                raise error
            if not isinstance(payload, Mapping):
                raise CryptoComExchangeError("Crypto.com Exchange returned an invalid response object")
            return payload
        assert last_error is not None
        raise last_error

    def public_get(self, method: str, params: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        if method not in PUBLIC_READ_METHODS:
            raise ValueError("Crypto.com Exchange method is outside the public read allowlist")
        last_error: CryptoComExchangeTransientError | None = None
        for attempt in range(self._retries + 1):
            try:
                self.request_count += 1
                response = self._client.get(
                    f"{BASE_URL}/{method}", params=dict(params or {}), timeout=30.0
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = CryptoComExchangeTransientError(
                    "Crypto.com Exchange market data is temporarily unreachable"
                )
                if attempt >= self._retries:
                    raise last_error from exc
                self._sleep(self._backoff_seconds * (2 ** attempt))
                continue
            try:
                payload = response.json()
            except ValueError as exc:
                if response.status_code >= 500:
                    payload = None
                else:
                    raise CryptoComExchangeError(
                        "Crypto.com Exchange returned invalid market data"
                    ) from exc
            error = self._response_error(method, response, payload)
            if isinstance(error, CryptoComExchangeTransientError):
                delay = self._retry_delay(response, attempt, self._backoff_seconds)
                last_error = error
                if attempt >= self._retries or delay > 30:
                    error.retry_after_seconds = delay
                    raise error
                self._sleep(delay)
                continue
            if error is not None:
                raise error
            if not isinstance(payload, Mapping):
                raise CryptoComExchangeError("Crypto.com Exchange returned invalid market data")
            return payload
        assert last_error is not None
        raise last_error


class CryptoComExchangeAdapter:
    provider = "crypto_com_exchange"
    normalization_version = "crypto-com-exchange-v1"

    def __init__(self, client: CryptoComExchangeReadOnlyClient):
        self.client = client

    def close(self) -> None:
        self.client.close()

    def verify_read_only(self) -> None:
        # There is no permission-introspection method. The route requires a
        # user attestation and this call verifies that the key can read only
        # through the fixed code-level allowlist.
        self.client.private_post("private/user-balance", {})

    @staticmethod
    def _result_rows(payload: Mapping[str, Any], key: str = "data") -> list[Mapping[str, Any]]:
        result = payload.get("result")
        rows = result.get(key) if isinstance(result, Mapping) else None
        if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
            raise CryptoComExchangeError("Crypto.com Exchange history response is malformed")
        return rows

    def _market(self) -> tuple[dict[str, tuple[str, str]], dict[str, Decimal]]:
        instruments = self._result_rows(self.client.public_get("public/get-instruments"))
        tickers = self._result_rows(self.client.public_get("public/get-tickers"))
        pairs: dict[str, tuple[str, str]] = {}
        for row in instruments:
            name = _symbol(row.get("symbol"))
            instrument_type = str(row.get("inst_type") or "").upper()
            if instrument_type not in {"CCY_PAIR", "SPOT"} or "-PERP" in name:
                continue
            pairs[name] = (_symbol(row.get("base_ccy")), _symbol(row.get("quote_ccy")))
        prices: dict[str, Decimal] = {}
        for row in tickers:
            try:
                name = _symbol(row.get("i"))
                price = _decimal(row.get("a"), field="ticker.a")
            except CryptoComExchangeError:
                continue
            if name in pairs and price > 0:
                prices[name] = price
        return pairs, prices

    @staticmethod
    def _quote_rate(asset: str, target: str, pairs: Mapping[str, tuple[str, str]], prices: Mapping[str, Decimal]) -> Decimal:
        if asset == target:
            return Decimal("1")
        for name, (base, quote) in pairs.items():
            price = prices.get(name)
            if not price:
                continue
            if base == asset and quote == target:
                return price
            if base == target and quote == asset:
                return Decimal("1") / price
        return Decimal("0")

    def fetch_balances(self, *, aud_per_usd: Decimal) -> tuple[CryptoComExchangeBalance, ...]:
        payload = self.client.private_post("private/user-balance", {})
        account_rows = self._result_rows(payload)
        quantities: dict[str, Decimal] = {}
        for account_row in account_rows:
            rows = account_row.get("position_balances")
            if not isinstance(rows, list):
                raise CryptoComExchangeError(
                    "Crypto.com Exchange balance response is missing position balances"
                )
            for row in rows:
                if not isinstance(row, Mapping):
                    raise CryptoComExchangeError("Crypto.com Exchange balance entry is malformed")
                symbol = _symbol(row.get("instrument_name"))
                quantity = _decimal(row.get("quantity"), field="quantity")
                quantities[symbol] = quantities.get(symbol, Decimal("0")) + quantity
        pairs, prices = self._market()
        result: list[CryptoComExchangeBalance] = []
        for symbol, quantity in sorted(quantities.items()):
            if quantity == 0:
                continue
            aud_rate = self._quote_rate(symbol, "AUD", pairs, prices)
            if aud_rate <= 0:
                usd_rate = self._quote_rate(symbol, "USD", pairs, prices)
                if usd_rate <= 0:
                    usdt_rate = self._quote_rate(symbol, "USDT", pairs, prices)
                    usdt_usd = self._quote_rate("USDT", "USD", pairs, prices)
                    usd_rate = usdt_rate * (usdt_usd or Decimal("1"))
                aud_rate = usd_rate * aud_per_usd
            result.append(CryptoComExchangeBalance(
                symbol=symbol, quantity=quantity, aud_rate=aud_rate,
                aud_balance=quantity * aud_rate,
            ))
        return tuple(result)

    def _capital_records(
        self, start: date, end: date
    ) -> tuple[list[SourceRecordEnvelope], int, int, list[str]]:
        records: list[SourceRecordEnvelope] = []
        pending = 0
        calls = 0
        failures: list[str] = []
        endpoints = (
            ("private/get-deposit-history", "deposit_list", "deposit", {"1"}, {"0", "3"}),
            ("private/get-withdrawal-history", "withdrawal_list", "withdrawal", {"5"}, {"0", "1", "3"}),
        )
        for method, result_key, kind, completed, active in endpoints:
            try:
                cursor = start
                while cursor <= end:
                    window_end = min(end, cursor + timedelta(days=CAPITAL_WINDOW_DAYS))
                    page = 0
                    while True:
                        payload = self.client.private_post(method, {
                            "start_ts": str(_day_start_ms(cursor)),
                            "end_ts": str(_day_end_ms(window_end)),
                            "page_size": str(CAPITAL_PAGE_SIZE),
                            "page": str(page),
                        })
                        calls += 1
                        rows = self._result_rows(payload, result_key)
                        for row in rows:
                            status = str(row.get("status") or "")
                            if status not in completed:
                                if status in active:
                                    pending += 1
                                continue
                            occurred_at = _milliseconds(
                                row.get("update_time") or row.get("create_time"),
                                field="update_time",
                            )
                            symbol = _symbol(row.get("currency"))
                            quantity = abs(_decimal(row.get("amount"), field="amount"))
                            fee = abs(_decimal(row.get("fee"), field="fee", default=Decimal(0)))
                            provider_id = _stable_id(kind, row, "id", "txid")
                            records.append(SourceRecordEnvelope(
                                occurred_at=occurred_at,
                                provider_record_id=provider_id,
                                raw_payload=dict(row),
                                activities=(CanonicalActivityInput(
                                    activity_type=kind,
                                    occurred_at=occurred_at,
                                    asset_symbol=symbol,
                                    asset_type="cash" if symbol in FIAT_CODES else "crypto",
                                    quantity=quantity,
                                    direction="in" if kind == "deposit" else "out",
                                    fee_amount=fee or None,
                                    fee_currency=symbol if fee else None,
                                    external_group_id=str(row.get("txid") or "").strip() or None,
                                    assumptions=(
                                        "Crypto.com Exchange wallet history is treated as an external transfer candidate.",
                                    ),
                                    metadata={
                                        "crypto_com_exchange_method": method,
                                        "network": row.get("network_id"),
                                        "transaction_hash": row.get("txid"),
                                    },
                                ),),
                                metadata={"crypto_com_exchange_method": method},
                            ))
                        if len(rows) < CAPITAL_PAGE_SIZE:
                            break
                        page += 1
                        if page >= MAX_PAGES:
                            raise CryptoComExchangeHistoryLimitError(
                                f"Crypto.com Exchange {kind} history exceeded the safe pagination limit"
                            )
                    cursor = window_end + timedelta(days=1)
            except CryptoComExchangeProductUnavailableError:
                failures.append(
                    f"Crypto.com Exchange {kind} history is unavailable for this account or API key."
                )
        return records, pending, calls, failures

    @staticmethod
    def _row_ns(row: Mapping[str, Any], ns_field: str, ms_field: str) -> int:
        raw_ns = row.get(ns_field)
        if raw_ns not in {None, ""}:
            return int(str(raw_ns))
        return int(str(row.get(ms_field))) * 1_000_000

    def _backward_pages(
        self,
        method: str,
        *,
        start: date,
        end: date,
        limit: int,
        ns_field: str,
        ms_field: str,
    ) -> tuple[list[Mapping[str, Any]], int]:
        start_ns = _day_start_ms(start) * 1_000_000
        cursor_end_ns = (_day_end_ms(end) + 1) * 1_000_000
        rows: list[Mapping[str, Any]] = []
        calls = 0
        while True:
            payload = self.client.private_post(method, {
                "start_time": str(start_ns), "end_time": str(cursor_end_ns), "limit": str(limit),
            })
            calls += 1
            page = self._result_rows(payload)
            rows.extend(page)
            if len(page) < limit:
                break
            oldest = min(self._row_ns(row, ns_field, ms_field) for row in page)
            if oldest <= start_ns or oldest >= cursor_end_ns:
                raise CryptoComExchangeHistoryLimitError(
                    f"Crypto.com Exchange {method} pagination did not advance"
                )
            cursor_end_ns = (
                oldest - 1
                if method == "private/staking/get-reward-history"
                else oldest
            )
            if calls >= MAX_PAGES:
                raise CryptoComExchangeHistoryLimitError(
                    f"Crypto.com Exchange {method} exceeded the safe pagination limit"
                )
            if method == "private/get-trades":
                self.client.pause(1.0)
        return rows, calls

    def _trade_records(
        self, start: date, end: date
    ) -> tuple[list[SourceRecordEnvelope], int, int]:
        rows, calls = self._backward_pages(
            "private/get-trades", start=start, end=end, limit=HISTORY_PAGE_SIZE,
            ns_field="create_time_ns", ms_field="create_time",
        )
        pairs, _prices = self._market()
        records: list[SourceRecordEnvelope] = []
        unsupported = 0
        for row in rows:
            name = _symbol(row.get("instrument_name"))
            if name not in pairs:
                unsupported += 1
                continue
            base, quote = pairs[name]
            occurred_at = _milliseconds(
                row.get("transact_time_ns") or row.get("create_time_ns") or row.get("create_time"),
                field="create_time",
            )
            quantity = abs(_decimal(row.get("traded_quantity"), field="traded_quantity"))
            price = abs(_decimal(row.get("traded_price"), field="traded_price"))
            quote_quantity = quantity * price
            fee = abs(_decimal(row.get("fees"), field="fees", default=Decimal(0)))
            fee_symbol = _symbol(row.get("fee_instrument_name")) if fee else None
            side = str(row.get("side") or "").upper()
            if side not in {"BUY", "SELL"}:
                raise CryptoComExchangeError("Crypto.com Exchange trade has an invalid side")
            common = {
                "occurred_at": occurred_at,
                "asset_type": "crypto",
                "fee_amount": fee or None,
                "fee_currency": fee_symbol,
                "external_group_id": f"exchange-order:{row.get('order_id')}",
                "metadata": {
                    "crypto_com_exchange_method": "private/get-trades",
                    "instrument_name": name,
                    "order_id": row.get("order_id"),
                    "trade_id": row.get("trade_id"),
                },
            }
            if quote in FIAT_CODES:
                activity = CanonicalActivityInput(
                    activity_type="buy" if side == "BUY" else "sell",
                    asset_symbol=base,
                    quantity=quantity,
                    price=price,
                    currency=quote,
                    aud_value=quote_quantity if quote == "AUD" else None,
                    **common,
                )
            elif side == "BUY":
                activity = CanonicalActivityInput(
                    activity_type="crypto_swap", asset_symbol=quote, quantity=quote_quantity,
                    counter_asset_symbol=base, counter_quantity=quantity,
                    warnings=("Crypto.com Exchange fills do not report an event-time AUD value.",),
                    **common,
                )
            else:
                activity = CanonicalActivityInput(
                    activity_type="crypto_swap", asset_symbol=base, quantity=quantity,
                    counter_asset_symbol=quote, counter_quantity=quote_quantity,
                    warnings=("Crypto.com Exchange fills do not report an event-time AUD value.",),
                    **common,
                )
            provider_id = _stable_id("exchange-fill", row, "trade_id")
            records.append(SourceRecordEnvelope(
                occurred_at=occurred_at, provider_record_id=provider_id,
                raw_payload=dict(row), activities=(activity,),
                metadata={"crypto_com_exchange_method": "private/get-trades"},
            ))
        return records, calls + 2, unsupported

    def _reward_records(
        self, start: date, end: date
    ) -> tuple[list[SourceRecordEnvelope], int, list[str]]:
        records: list[SourceRecordEnvelope] = []
        calls = 0
        failures: list[str] = []
        try:
            cursor = start
            while cursor <= end:
                window_end = min(end, cursor + timedelta(days=REWARD_WINDOW_DAYS))
                rows, used = self._backward_pages(
                    "private/staking/get-reward-history",
                    start=cursor, end=window_end, limit=REWARD_PAGE_SIZE,
                    ns_field="event_timestamp_ns", ms_field="event_timestamp_ms",
                )
                calls += used
                for row in rows:
                    amount = abs(_decimal(row.get("reward_quantity"), field="reward_quantity"))
                    if amount == 0:
                        continue
                    occurred_at = _milliseconds(row.get("event_timestamp_ms"), field="event_timestamp_ms")
                    symbol = _symbol(row.get("reward_inst_name"))
                    provider_id = _stable_id("staking-reward", row)
                    records.append(SourceRecordEnvelope(
                        occurred_at=occurred_at, provider_record_id=provider_id,
                        raw_payload=dict(row),
                        activities=(CanonicalActivityInput(
                            activity_type="staking_reward", occurred_at=occurred_at,
                            asset_symbol=symbol, asset_type="crypto", quantity=amount,
                            warnings=(
                                "Crypto.com Exchange staking rewards do not report an event-time AUD value.",
                            ),
                            metadata={
                                "crypto_com_exchange_method": "private/staking/get-reward-history",
                                "staking_instrument": row.get("staking_inst_name"),
                                "underlying_instrument": row.get("underlying_inst_name"),
                            },
                        ),),
                        metadata={
                            "crypto_com_exchange_method": "private/staking/get-reward-history"
                        },
                    ))
                cursor = window_end + timedelta(days=1)
        except CryptoComExchangeProductUnavailableError:
            failures.append(
                "Crypto.com Exchange staking reward history is unavailable for this account."
            )
        return records, calls, failures

    def fetch_history(self, *, start: date, end: date) -> CryptoComExchangeHistoryResult:
        if start > end:
            raise ValueError("Crypto.com Exchange history start must not be after end")
        records, pending, calls, failures = self._capital_records(start, end)
        trade_records, used, unsupported_trades = self._trade_records(start, end)
        records.extend(trade_records)
        calls += used
        reward_records, used, reward_failures = self._reward_records(start, end)
        records.extend(reward_records)
        calls += used
        failures.extend(reward_failures)
        if unsupported_trades:
            failures.append(
                f"Skipped {unsupported_trades} non-Spot Crypto.com Exchange fill(s)."
            )
        coverage = [
            "Crypto.com App activity is not available through the Exchange connector; import the consumer App CSV separately.",
            "Margin, derivatives, isolated positions, OTC, Trading Bots, fiat-wallet history, Supercharger, and unsupported rewards are not imported.",
        ]
        warnings = tuple([*failures, *coverage])
        batch = InvestmentActivityBatch(
            provider=self.provider,
            ingestion_type="api_sync",
            normalization_version=self.normalization_version,
            records=tuple(sorted(
                records, key=lambda item: (item.occurred_at, item.provider_record_id or "")
            )),
            cursor={"history_through": end.isoformat()},
            source_name=f"Crypto.com Exchange {start.isoformat()} to {end.isoformat()}",
            warnings=warnings,
        )
        return CryptoComExchangeHistoryResult(
            batch=batch,
            pending_records=pending,
            requests_made=calls,
            partial_product_failures=tuple(failures),
            missing_product_warnings=warnings,
        )
