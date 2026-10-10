"""Read-only CoinSpot V2 client and canonical investment adapter."""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Mapping

import httpx

from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
)


READ_ONLY_BASE_URL = "https://www.coinspot.com.au/api/v2/ro"
HISTORY_WINDOW_DAYS = 90
ORDER_LIMIT = 500


class CoinSpotError(RuntimeError):
    pass


class CoinSpotAuthError(CoinSpotError):
    pass


class CoinSpotTransientError(CoinSpotError):
    pass


class CoinSpotHistoryLimitError(CoinSpotError):
    pass


@dataclass(frozen=True)
class CoinSpotBalance:
    symbol: str
    quantity: Decimal
    aud_balance: Decimal
    aud_rate: Decimal
    provider_symbol: str | None = None


@dataclass(frozen=True)
class CoinSpotHistoryResult:
    batch: InvestmentActivityBatch
    pending_records: int
    windows_requested: int


def _decimal(value: Any, *, field: str, default: Decimal | None = None) -> Decimal:
    if value is None or value == "":
        if default is not None:
            return default
        raise CoinSpotError(f"CoinSpot response is missing {field}")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise CoinSpotError(f"CoinSpot response field {field} is not numeric") from exc
    if not result.is_finite():
        raise CoinSpotError(f"CoinSpot response field {field} is not finite")
    return result


def _timestamp(value: Any, *, field: str) -> datetime:
    if not value:
        raise CoinSpotError(f"CoinSpot response is missing {field}")
    rendered = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(rendered)
    except ValueError as exc:
        raise CoinSpotError(f"CoinSpot response field {field} is not an ISO timestamp") from exc
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _stable_id(prefix: str, payload: Mapping[str, Any]) -> str:
    explicit = payload.get("id") or payload.get("txid")
    if explicit:
        return f"{prefix}:{explicit}"
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()
    return f"{prefix}:{digest}"


def _symbol(value: Any) -> tuple[str, str | None]:
    """Keep provider-native NFT identifiers without overflowing ledger symbols."""
    provider_symbol = str(value or "").strip().upper()
    if not provider_symbol:
        raise CoinSpotError("CoinSpot response is missing a coin symbol")
    if len(provider_symbol) <= 64:
        return provider_symbol, None
    digest = hashlib.sha256(provider_symbol.encode("utf-8")).hexdigest()[:40].upper()
    return f"COINSPOT:{digest}", provider_symbol


def _status_complete(value: Any) -> bool:
    return str(value or "completed").strip().lower() in {
        "complete", "completed", "ok", "paid", "processed", "success", "successful",
    }


class CoinSpotReadOnlyClient:
    """Minimal V2 client that cannot address trading or withdrawal APIs."""

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        client: httpx.Client | None = None,
        base_url: str = READ_ONLY_BASE_URL,
        retries: int = 3,
        backoff_seconds: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        nonce_factory: Callable[[], int] | None = None,
    ):
        self._api_key = api_key
        self._api_secret = api_secret
        self._client = client or httpx.Client(timeout=30.0)
        self._base_url = base_url.rstrip("/")
        if self._base_url != READ_ONLY_BASE_URL:
            raise ValueError("CoinSpot client base URL must be the documented read-only V2 namespace")
        self._retries = retries
        self._backoff_seconds = backoff_seconds
        self._sleep = sleep
        self._nonce_factory = nonce_factory
        self._nonce_lock = threading.Lock()
        self._last_nonce = 0

    def _next_nonce(self) -> int:
        with self._nonce_lock:
            candidate = (
                int(self._nonce_factory())
                if self._nonce_factory is not None
                else time.time_ns() // 1_000
            )
            self._last_nonce = max(candidate, self._last_nonce + 1)
            return self._last_nonce

    def _post(self, path: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if not path.startswith("/") or ".." in path:
            raise ValueError("CoinSpot read-only path must be absolute and normalized")
        last_error: CoinSpotTransientError | None = None
        for attempt in range(self._retries + 1):
            body = {"nonce": self._next_nonce(), **dict(payload or {})}
            encoded = json.dumps(body, separators=(",", ":"))
            signature = hmac.new(
                self._api_secret.encode("utf-8"),
                encoded.encode("utf-8"),
                hashlib.sha512,
            ).hexdigest()
            try:
                response = self._client.post(
                    f"{self._base_url}{path}",
                    content=encoded,
                    headers={
                        "key": self._api_key,
                        "sign": signature,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    timeout=30.0,
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = CoinSpotTransientError("CoinSpot is temporarily unreachable")
                if attempt >= self._retries:
                    raise last_error from exc
                self._sleep(self._backoff_seconds * (2 ** attempt))
                continue
            if response.status_code in {401, 403}:
                raise CoinSpotAuthError("CoinSpot rejected the read-only API credentials")
            if response.status_code == 429 or response.status_code >= 500:
                last_error = CoinSpotTransientError(
                    f"CoinSpot read-only API returned HTTP {response.status_code}"
                )
                if attempt >= self._retries:
                    raise last_error
                retry_after = response.headers.get("Retry-After")
                try:
                    delay = min(float(retry_after), 60.0) if retry_after else self._backoff_seconds * (2 ** attempt)
                except ValueError:
                    delay = self._backoff_seconds * (2 ** attempt)
                self._sleep(delay)
                continue
            try:
                result = response.json()
            except ValueError as exc:
                raise CoinSpotError("CoinSpot returned an invalid response") from exc
            if not isinstance(result, dict):
                raise CoinSpotError("CoinSpot returned an invalid response object")
            if response.status_code >= 400:
                message = str(result.get("message") or "CoinSpot request failed")
                lowered = message.lower()
                if any(token in lowered for token in (
                    "key", "signature", "sign", "nonce", "authoris", "authoriz",
                )):
                    raise CoinSpotAuthError("CoinSpot rejected the read-only API credentials")
                raise CoinSpotError("CoinSpot rejected the read-only request")
            if str(result.get("status", "")).lower() != "ok":
                message = str(result.get("message") or "CoinSpot request failed")
                lowered = message.lower()
                if any(token in lowered for token in ("key", "signature", "sign", "nonce", "authoris", "authoriz")):
                    raise CoinSpotAuthError("CoinSpot rejected the read-only API credentials")
                if any(token in lowered for token in ("rate", "tempor", "timeout", "busy", "unavailable")):
                    last_error = CoinSpotTransientError("CoinSpot is temporarily unavailable")
                    if attempt >= self._retries:
                        raise last_error
                    self._sleep(self._backoff_seconds * (2 ** attempt))
                    continue
                raise CoinSpotError("CoinSpot rejected the read-only request")
            return result
        assert last_error is not None
        raise last_error

    def verify_read_only(self) -> None:
        self._post("/status")

    def close(self) -> None:
        self._client.close()

    def balances(self) -> dict[str, Any]:
        return self._post("/my/balances")

    def orders(self, *, start: date, end: date) -> dict[str, Any]:
        return self._post("/my/orders/completed", {
            "startdate": start.isoformat(),
            "enddate": end.isoformat(),
            "limit": ORDER_LIMIT,
        })

    def send_receive(self, *, start: date, end: date) -> dict[str, Any]:
        return self._post("/my/sendreceive", {
            "startdate": start.isoformat(), "enddate": end.isoformat(),
        })

    def deposits(self, *, start: date, end: date) -> dict[str, Any]:
        return self._post("/my/deposits", {
            "startdate": start.isoformat(), "enddate": end.isoformat(),
        })

    def withdrawals(self, *, start: date, end: date) -> dict[str, Any]:
        return self._post("/my/withdrawals", {
            "startdate": start.isoformat(), "enddate": end.isoformat(),
        })


class CoinSpotAdapter:
    provider = "coinspot"
    normalization_version = "coinspot-v2"

    def __init__(self, client: CoinSpotReadOnlyClient):
        self.client = client

    def verify_read_only(self) -> None:
        self.client.verify_read_only()

    def close(self) -> None:
        self.client.close()

    def fetch_balances(self) -> tuple[CoinSpotBalance, ...]:
        payload = self.client.balances()
        raw_balances = payload.get("balances")
        if not isinstance(raw_balances, list):
            raise CoinSpotError("CoinSpot balances response is missing balances")
        balances: list[CoinSpotBalance] = []
        for item in raw_balances:
            if not isinstance(item, Mapping) or len(item) != 1:
                raise CoinSpotError("CoinSpot balance entry is malformed")
            symbol, raw = next(iter(item.items()))
            if not isinstance(raw, Mapping):
                raise CoinSpotError("CoinSpot balance values are malformed")
            normalized_symbol, provider_symbol = _symbol(symbol)
            balances.append(CoinSpotBalance(
                symbol=normalized_symbol,
                quantity=_decimal(raw.get("balance"), field="balance"),
                aud_balance=_decimal(raw.get("audbalance"), field="audbalance", default=Decimal(0)),
                aud_rate=_decimal(raw.get("rate"), field="rate", default=Decimal(0)),
                provider_symbol=provider_symbol,
            ))
        return tuple(balances)

    def _order_records(self, payload: Mapping[str, Any]) -> list[SourceRecordEnvelope]:
        records: list[SourceRecordEnvelope] = []
        for response_key, side in (("buyorders", "buy"), ("sellorders", "sell")):
            raw_orders = payload.get(response_key, [])
            if not isinstance(raw_orders, list):
                raise CoinSpotError(f"CoinSpot response field {response_key} is malformed")
            for row in raw_orders:
                if not isinstance(row, Mapping):
                    raise CoinSpotError("CoinSpot order row is malformed")
                occurred_at = _timestamp(row.get("solddate") or row.get("created"), field="solddate")
                coin, provider_symbol = _symbol(row.get("coin"))
                market = str(row.get("market") or f"{coin}/AUD").upper()
                pair = market.split("/")
                if not coin or len(pair) != 2:
                    raise CoinSpotError("CoinSpot order row has an invalid coin or market")
                base, _ = _symbol(pair[0])
                quote, _ = _symbol(pair[1])
                quantity = abs(_decimal(row.get("amount"), field="amount"))
                rate = abs(_decimal(row.get("rate"), field="rate"))
                total = abs(_decimal(row.get("total"), field="total", default=rate * quantity))
                fee = abs(_decimal(row.get("audfeeExGst"), field="audfeeExGst", default=Decimal(0))) + abs(
                    _decimal(row.get("audGst"), field="audGst", default=Decimal(0))
                )
                aud_total = abs(_decimal(row.get("audtotal"), field="audtotal", default=Decimal(0)))
                common: dict[str, Any] = {
                    "occurred_at": occurred_at,
                    "asset_type": "crypto",
                    "fee_amount": fee if fee else None,
                    "fee_currency": "AUD" if fee else None,
                    "fee_aud_value": fee if fee else None,
                    "fee_valuation_source": "coinspot_order_history" if fee else None,
                    "fee_valuation_timestamp": occurred_at if fee else None,
                    "external_group_id": _stable_id("order", row),
                    "metadata": {
                        "coinspot_endpoint": "orders",
                        "order_type": row.get("type"),
                        "market": market,
                        "provider_asset_symbol": provider_symbol,
                    },
                }
                if quote == "AUD":
                    activity = CanonicalActivityInput(
                        activity_type=side,
                        asset_symbol=coin,
                        quantity=quantity,
                        price=rate,
                        currency="AUD",
                        aud_value=total,
                        valuation_source="coinspot_order_history",
                        valuation_timestamp=occurred_at,
                        **common,
                    )
                elif side == "buy":
                    activity = CanonicalActivityInput(
                        activity_type="crypto_swap",
                        asset_symbol=quote,
                        quantity=total,
                        counter_asset_symbol=base,
                        counter_quantity=quantity,
                        aud_value=aud_total or None,
                        valuation_source="coinspot_order_history" if aud_total else None,
                        valuation_timestamp=occurred_at if aud_total else None,
                        **common,
                    )
                else:
                    activity = CanonicalActivityInput(
                        activity_type="crypto_swap",
                        asset_symbol=base,
                        quantity=quantity,
                        counter_asset_symbol=quote,
                        counter_quantity=total,
                        aud_value=aud_total or None,
                        valuation_source="coinspot_order_history" if aud_total else None,
                        valuation_timestamp=occurred_at if aud_total else None,
                        **common,
                    )
                records.append(SourceRecordEnvelope(
                    occurred_at=occurred_at,
                    provider_record_id=f"order:{side}:{row.get('id')}" if row.get("id") else _stable_id(f"order:{side}", row),
                    raw_payload=dict(row),
                    activities=(activity,),
                    metadata={"coinspot_endpoint": "orders", "side": side},
                ))
        return records

    def _transfer_records(self, payload: Mapping[str, Any]) -> list[SourceRecordEnvelope]:
        records: list[SourceRecordEnvelope] = []
        for response_key, activity_type in (
            ("sendtransactions", "withdrawal"),
            ("receivetransactions", "deposit"),
        ):
            rows = payload.get(response_key, [])
            if not isinstance(rows, list):
                raise CoinSpotError(f"CoinSpot response field {response_key} is malformed")
            for row in rows:
                if not isinstance(row, Mapping):
                    raise CoinSpotError("CoinSpot send/receive row is malformed")
                occurred_at = _timestamp(row.get("timestamp"), field="timestamp")
                symbol, provider_symbol = _symbol(row.get("coin"))
                quantity = abs(_decimal(row.get("amount"), field="amount"))
                aud_value = abs(_decimal(row.get("aud"), field="aud", default=Decimal(0)))
                fee = (
                    abs(_decimal(row.get("sendfee"), field="sendfee", default=Decimal(0)))
                    if activity_type == "withdrawal" else Decimal(0)
                )
                txid = str(row.get("txid") or "").strip() or None
                activity = CanonicalActivityInput(
                    activity_type=activity_type,
                    occurred_at=occurred_at,
                    asset_symbol=symbol,
                    asset_type="crypto",
                    quantity=quantity,
                    direction="out" if activity_type == "withdrawal" else "in",
                    fee_amount=fee or None,
                    fee_currency=symbol if fee else None,
                    aud_value=aud_value or None,
                    valuation_source="coinspot_send_receive" if aud_value else None,
                    valuation_timestamp=occurred_at if aud_value else None,
                    external_group_id=txid,
                    assumptions=("CoinSpot send fee is treated as a separate crypto disposal.",) if fee else (),
                    metadata={
                        "coinspot_endpoint": "sendreceive",
                        "transaction_hash": txid,
                        "address": row.get("address"),
                        "from": row.get("from"),
                        "provider_asset_symbol": provider_symbol,
                    },
                )
                records.append(SourceRecordEnvelope(
                    occurred_at=occurred_at,
                    provider_record_id=_stable_id("send" if activity_type == "withdrawal" else "receive", row),
                    raw_payload=dict(row),
                    activities=(activity,),
                    metadata={"coinspot_endpoint": "sendreceive", "direction": activity.direction},
                ))
        return records

    def _cash_records(
        self,
        payload: Mapping[str, Any],
        *,
        response_key: str,
        activity_type: str,
    ) -> tuple[list[SourceRecordEnvelope], int]:
        rows = payload.get(response_key, [])
        if not isinstance(rows, list):
            raise CoinSpotError(f"CoinSpot response field {response_key} is malformed")
        records: list[SourceRecordEnvelope] = []
        pending = 0
        for row in rows:
            if not isinstance(row, Mapping):
                raise CoinSpotError("CoinSpot AUD funding row is malformed")
            if not _status_complete(row.get("status")):
                pending += 1
                continue
            occurred_at = _timestamp(row.get("created"), field="created")
            activity = CanonicalActivityInput(
                activity_type=activity_type,
                occurred_at=occurred_at,
                asset_symbol="AUD",
                asset_type="cash",
                quantity=abs(_decimal(row.get("amount"), field="amount")),
                direction="in" if activity_type == "deposit" else "out",
                warnings=("AUD funding is retained for reconciliation and does not alter crypto CGT lots.",),
                metadata={
                    "coinspot_endpoint": response_key,
                    "status": row.get("status"),
                    "funding_type": row.get("type"),
                    "reference": row.get("reference"),
                },
            )
            records.append(SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=_stable_id(response_key.rstrip("s"), row),
                raw_payload=dict(row),
                activities=(activity,),
                metadata={"coinspot_endpoint": response_key},
            ))
        return records, pending

    def _orders_for_range(self, start: date, end: date) -> tuple[list[SourceRecordEnvelope], int]:
        payload = self.client.orders(start=start, end=end)
        count = sum(len(payload.get(key, [])) for key in ("buyorders", "sellorders"))
        if count < ORDER_LIMIT:
            return self._order_records(payload), 1
        if start >= end:
            raise CoinSpotHistoryLimitError(
                f"CoinSpot returned {count} orders for {start}; the read-only API has no further page cursor"
            )
        midpoint = start + timedelta(days=(end - start).days // 2)
        left, left_calls = self._orders_for_range(start, midpoint)
        right, right_calls = self._orders_for_range(midpoint + timedelta(days=1), end)
        return left + right, left_calls + right_calls + 1

    def fetch_history(self, *, start: date, end: date) -> CoinSpotHistoryResult:
        if end < start:
            raise ValueError("CoinSpot history end date must be on or after start date")
        records: list[SourceRecordEnvelope] = []
        pending = 0
        requests = 0
        window_start = start
        while window_start <= end:
            window_end = min(end, window_start + timedelta(days=HISTORY_WINDOW_DAYS - 1))
            order_records, order_calls = self._orders_for_range(window_start, window_end)
            records.extend(order_records)
            requests += order_calls

            transfers = self.client.send_receive(start=window_start, end=window_end)
            records.extend(self._transfer_records(transfers))
            requests += 1

            deposits = self.client.deposits(start=window_start, end=window_end)
            deposit_records, deposit_pending = self._cash_records(
                deposits, response_key="deposits", activity_type="deposit"
            )
            records.extend(deposit_records)
            pending += deposit_pending
            requests += 1

            withdrawals = self.client.withdrawals(start=window_start, end=window_end)
            withdrawal_records, withdrawal_pending = self._cash_records(
                withdrawals, response_key="withdrawals", activity_type="withdrawal"
            )
            records.extend(withdrawal_records)
            pending += withdrawal_pending
            requests += 1
            window_start = window_end + timedelta(days=1)

        unique: dict[str, SourceRecordEnvelope] = {}
        for record in records:
            key = record.provider_record_id or _stable_id("payload", record.raw_payload)
            unique[key] = record
        ordered = tuple(sorted(unique.values(), key=lambda item: (item.occurred_at, item.provider_record_id or "")))
        warnings = (
            (f"{pending} pending CoinSpot AUD funding record(s) were deferred until completed.",)
            if pending else ()
        )
        return CoinSpotHistoryResult(
            batch=InvestmentActivityBatch(
                provider=self.provider,
                ingestion_type="api_sync",
                normalization_version=self.normalization_version,
                records=ordered,
                source_name=f"CoinSpot read-only API {start.isoformat()} to {end.isoformat()}",
                cursor={"history_through": end.isoformat()},
                warnings=warnings,
            ),
            pending_records=pending,
            windows_requested=requests,
        )
