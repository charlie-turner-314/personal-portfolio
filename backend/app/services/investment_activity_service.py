"""Provider-neutral investment activity validation and atomic application.

Adapters preserve their provider-specific parsing at the edge and emit the
immutable contract in this module. The service stores a sanitized source row,
its canonical activities, and any existing downstream trade/income records in
one transaction. This is the only ingestion seam provider adapters should use.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Protocol, Sequence, runtime_checkable
from uuid import UUID

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import (
    Account,
    BrokerTrade,
    Holding,
    InvestmentActivity,
    InvestmentIncomeEvent,
    InvestmentIngestionRun,
    InvestmentSourceRecord,
)
from app.services.broker_trade_service import _recompute_holding


NORMALIZATION_VERSION = "investment-activity-v1"
ACTIVITY_TYPES = frozenset(
    {
        "buy",
        "sell",
        "dividend",
        "distribution",
        "drp",
        "deposit",
        "withdrawal",
        "transfer",
        "fee",
        "interest",
        "staking_reward",
        "airdrop",
        "crypto_swap",
    }
)
INGESTION_TYPES = frozenset({"csv_import", "api_sync", "manual"})
DIRECTIONS = frozenset({"in", "out", "internal"})
ASSET_TYPES = frozenset({"equity", "fund", "crypto", "cash", "option", "bond", "other"})

_PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_SECRET_KEY_RE = re.compile(
    r"(^|[_-])(api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token)([_-]|$)",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"(?i)\b(api[_-]?key|authorization|password|secret|signature|token)\s*[:=]\s*[^\s,;]+"
)


class ActivityValidationError(ValueError):
    """Raised before persistence when an adapter violates the canonical contract."""

    def __init__(self, errors: Sequence[dict[str, Any]]):
        self.errors = list(errors)
        super().__init__(f"invalid investment activity batch ({len(self.errors)} error(s))")


class ActivityApplicationError(RuntimeError):
    """Raised when an otherwise valid batch cannot be applied atomically."""

    def __init__(self, message: str, *, run_id: UUID | None = None):
        self.run_id = run_id
        super().__init__(message)


@dataclass(frozen=True)
class CanonicalActivityInput:
    activity_type: str
    occurred_at: datetime
    asset_symbol: str
    asset_type: str
    leg_index: int = 0
    asset_name: str | None = None
    quantity: Decimal | str | int | float | None = None
    price: Decimal | str | int | float | None = None
    gross_amount: Decimal | str | int | float | None = None
    net_amount: Decimal | str | int | float | None = None
    currency: str | None = None
    fee_amount: Decimal | str | int | float | None = None
    fee_currency: str | None = None
    tax_amount: Decimal | str | int | float | None = None
    tax_currency: str | None = None
    counter_asset_symbol: str | None = None
    counter_quantity: Decimal | str | int | float | None = None
    direction: str | None = None
    external_group_id: str | None = None
    aud_value: Decimal | str | int | float | None = None
    valuation_source: str | None = None
    valuation_timestamp: datetime | None = None
    assumptions: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SourceRecordEnvelope:
    occurred_at: datetime
    raw_payload: Mapping[str, Any]
    activities: tuple[CanonicalActivityInput, ...]
    provider_record_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class InvestmentActivityBatch:
    provider: str
    ingestion_type: str
    records: tuple[SourceRecordEnvelope, ...]
    normalization_version: str = NORMALIZATION_VERSION
    source_name: str | None = None
    source_hash: str | None = None
    cursor: Mapping[str, Any] | None = None
    warnings: tuple[str, ...] = ()


@runtime_checkable
class InvestmentActivityAdapter(Protocol):
    """Contract implemented by CSV presets and read-only provider adapters."""

    provider: str
    normalization_version: str

    def normalize(self, records: Iterable[Mapping[str, Any]]) -> InvestmentActivityBatch:
        """Normalize provider rows without writing to the database."""


@dataclass(frozen=True)
class ActivityBatchPreview:
    provider: str
    record_count: int
    activity_count: int
    source_keys: tuple[str, ...]
    warnings: tuple[str, ...]


def _normalized_decimal(value: Any, *, field_name: str) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be numeric")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"{field_name} must be numeric") from exc
    if not result.is_finite():
        raise ValueError(f"{field_name} must be finite")
    return result


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    rendered = format(value.normalize(), "f")
    return "0" if rendered == "-0" else rendered


def _normalized_datetime(value: datetime, *, field_name: str) -> datetime:
    if not isinstance(value, datetime):
        raise ValueError(f"{field_name} must be a datetime")
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _jsonable(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Decimal):
        return _decimal_text(value)
    if isinstance(value, datetime):
        normalized = _normalized_datetime(value, field_name="datetime")
        return normalized.isoformat(timespec="microseconds") + "Z"
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def sanitize_source_payload(value: Any) -> Any:
    """Return a JSON-safe deep copy with credential-shaped keys redacted."""
    if isinstance(value, Mapping):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            sanitized[name] = "[REDACTED]" if _SECRET_KEY_RE.search(name) else sanitize_source_payload(item)
        return sanitized
    if isinstance(value, (list, tuple, set, frozenset)):
        return [sanitize_source_payload(item) for item in value]
    return _jsonable(value)


def _canonical_json(value: Any) -> str:
    return json.dumps(_jsonable(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def source_payload_hash(raw_payload: Mapping[str, Any]) -> str:
    """Hash the exact sanitized payload that is safe to persist."""
    return _sha256(sanitize_source_payload(raw_payload))


def source_idempotency_key(
    *,
    provider: str,
    account_id: str | UUID,
    record: SourceRecordEnvelope,
) -> str:
    """Stable provider/account key for overlapping files and sync windows."""
    normalized_provider = provider.strip().lower()
    identity: dict[str, Any] = {
        "provider": normalized_provider,
        "account_id": str(account_id),
    }
    if record.provider_record_id and record.provider_record_id.strip():
        identity["provider_record_id"] = record.provider_record_id.strip()
    else:
        identity["occurred_at"] = _normalized_datetime(
            record.occurred_at, field_name="record.occurred_at"
        ).isoformat(timespec="microseconds")
        identity["payload_hash"] = source_payload_hash(record.raw_payload)
    return _sha256(identity)


def _validate_activity(
    activity: CanonicalActivityInput,
    *,
    record_index: int,
    activity_index: int,
) -> tuple[CanonicalActivityInput | None, list[dict[str, Any]]]:
    prefix = {"record_index": record_index, "activity_index": activity_index}
    errors: list[dict[str, Any]] = []

    activity_type = str(activity.activity_type).strip().lower()
    if activity_type not in ACTIVITY_TYPES:
        errors.append({**prefix, "field": "activity_type", "reason": f"unsupported activity type: {activity_type!r}"})

    symbol = str(activity.asset_symbol).strip().upper()
    if not symbol or len(symbol) > 64:
        errors.append({**prefix, "field": "asset_symbol", "reason": "asset symbol is required and must be at most 64 characters"})

    asset_type = str(activity.asset_type).strip().lower()
    if asset_type not in ASSET_TYPES:
        errors.append({**prefix, "field": "asset_type", "reason": f"unsupported asset type: {asset_type!r}"})

    if not isinstance(activity.leg_index, int) or isinstance(activity.leg_index, bool) or activity.leg_index < 0:
        errors.append({**prefix, "field": "leg_index", "reason": "leg index must be a non-negative integer"})

    try:
        occurred_at = _normalized_datetime(activity.occurred_at, field_name="occurred_at")
    except ValueError as exc:
        occurred_at = datetime.min
        errors.append({**prefix, "field": "occurred_at", "reason": str(exc)})

    decimals: dict[str, Decimal | None] = {}
    for field_name in (
        "quantity",
        "price",
        "gross_amount",
        "net_amount",
        "fee_amount",
        "tax_amount",
        "counter_quantity",
        "aud_value",
    ):
        try:
            decimals[field_name] = _normalized_decimal(getattr(activity, field_name), field_name=field_name)
        except ValueError as exc:
            decimals[field_name] = None
            errors.append({**prefix, "field": field_name, "reason": str(exc)})

    for field_name in ("quantity", "counter_quantity"):
        value = decimals[field_name]
        if value is not None and value <= 0:
            errors.append({**prefix, "field": field_name, "reason": f"{field_name} must be positive"})
    for field_name in ("price", "gross_amount", "net_amount", "fee_amount", "tax_amount", "aud_value"):
        value = decimals[field_name]
        if value is not None and value < 0:
            errors.append({**prefix, "field": field_name, "reason": f"{field_name} must be non-negative"})

    currency = activity.currency.strip().upper() if activity.currency else None
    fee_currency = activity.fee_currency.strip().upper() if activity.fee_currency else None
    tax_currency = activity.tax_currency.strip().upper() if activity.tax_currency else None
    direction = activity.direction.strip().lower() if activity.direction else None
    counter_symbol = activity.counter_asset_symbol.strip().upper() if activity.counter_asset_symbol else None

    if activity_type in {"buy", "sell", "drp"}:
        for required in ("quantity", "price"):
            if decimals[required] is None:
                errors.append({**prefix, "field": required, "reason": f"{activity_type} requires {required}"})
        if not currency:
            errors.append({**prefix, "field": "currency", "reason": f"{activity_type} requires currency"})
    if activity_type in {"dividend", "distribution", "interest"}:
        if decimals["gross_amount"] is None and decimals["net_amount"] is None:
            errors.append({**prefix, "field": "gross_amount", "reason": f"{activity_type} requires gross_amount or net_amount"})
        if not currency:
            errors.append({**prefix, "field": "currency", "reason": f"{activity_type} requires currency"})
    if activity_type in {"deposit", "withdrawal", "staking_reward", "airdrop"} and decimals["quantity"] is None:
        errors.append({**prefix, "field": "quantity", "reason": f"{activity_type} requires quantity"})
    if activity_type == "transfer":
        if decimals["quantity"] is None:
            errors.append({**prefix, "field": "quantity", "reason": "transfer requires quantity"})
        if direction not in DIRECTIONS:
            errors.append({**prefix, "field": "direction", "reason": "transfer direction must be in, out, or internal"})
    elif direction is not None and direction not in DIRECTIONS:
        errors.append({**prefix, "field": "direction", "reason": "direction must be in, out, or internal"})
    if activity_type == "fee" and decimals["fee_amount"] is None and decimals["quantity"] is None:
        errors.append({**prefix, "field": "fee_amount", "reason": "fee requires fee_amount or quantity"})
    if activity_type == "crypto_swap":
        for required in ("quantity", "counter_quantity"):
            if decimals[required] is None:
                errors.append({**prefix, "field": required, "reason": f"crypto_swap requires {required}"})
        if not counter_symbol:
            errors.append({**prefix, "field": "counter_asset_symbol", "reason": "crypto_swap requires counter_asset_symbol"})

    if decimals["fee_amount"] is not None and not fee_currency:
        errors.append({**prefix, "field": "fee_currency", "reason": "fee_currency is required when fee_amount is present"})
    if decimals["tax_amount"] is not None and not tax_currency:
        errors.append({**prefix, "field": "tax_currency", "reason": "tax_currency is required when tax_amount is present"})
    if decimals["aud_value"] is not None:
        if not activity.valuation_source or not activity.valuation_source.strip():
            errors.append({**prefix, "field": "valuation_source", "reason": "AUD values require valuation provenance"})
        if activity.valuation_timestamp is None:
            errors.append({**prefix, "field": "valuation_timestamp", "reason": "AUD values require a valuation timestamp"})

    valuation_timestamp = None
    if activity.valuation_timestamp is not None:
        try:
            valuation_timestamp = _normalized_datetime(
                activity.valuation_timestamp, field_name="valuation_timestamp"
            )
        except ValueError as exc:
            errors.append({**prefix, "field": "valuation_timestamp", "reason": str(exc)})

    if errors:
        return None, errors
    return replace(
        activity,
        activity_type=activity_type,
        occurred_at=occurred_at,
        asset_symbol=symbol,
        asset_type=asset_type,
        quantity=decimals["quantity"],
        price=decimals["price"],
        gross_amount=decimals["gross_amount"],
        net_amount=decimals["net_amount"],
        currency=currency,
        fee_amount=decimals["fee_amount"],
        fee_currency=fee_currency,
        tax_amount=decimals["tax_amount"],
        tax_currency=tax_currency,
        counter_asset_symbol=counter_symbol,
        counter_quantity=decimals["counter_quantity"],
        direction=direction,
        aud_value=decimals["aud_value"],
        valuation_source=activity.valuation_source.strip() if activity.valuation_source else None,
        valuation_timestamp=valuation_timestamp,
        assumptions=tuple(str(item) for item in activity.assumptions),
        warnings=tuple(str(item) for item in activity.warnings),
        metadata=sanitize_source_payload(activity.metadata),
    ), []


def validate_batch(
    batch: InvestmentActivityBatch,
    *,
    account_id: str | UUID,
) -> InvestmentActivityBatch:
    """Validate and normalize a complete adapter batch before any write."""
    errors: list[dict[str, Any]] = []
    provider = str(batch.provider).strip().lower()
    if not _PROVIDER_RE.fullmatch(provider):
        errors.append({"field": "provider", "reason": "provider must be a lowercase-safe identifier up to 64 characters"})
    ingestion_type = str(batch.ingestion_type).strip().lower()
    if ingestion_type not in INGESTION_TYPES:
        errors.append({"field": "ingestion_type", "reason": f"unsupported ingestion type: {ingestion_type!r}"})
    version = str(batch.normalization_version).strip()
    if not version or len(version) > 32:
        errors.append({"field": "normalization_version", "reason": "normalization version is required and must be at most 32 characters"})
    if batch.source_hash is not None and not _HASH_RE.fullmatch(batch.source_hash.lower()):
        errors.append({"field": "source_hash", "reason": "source hash must be a 64-character SHA-256 hex digest"})

    normalized_records: list[SourceRecordEnvelope] = []
    for record_index, record in enumerate(batch.records):
        try:
            occurred_at = _normalized_datetime(record.occurred_at, field_name="record.occurred_at")
        except ValueError as exc:
            occurred_at = datetime.min
            errors.append({"record_index": record_index, "field": "occurred_at", "reason": str(exc)})
        if not isinstance(record.raw_payload, Mapping):
            errors.append({"record_index": record_index, "field": "raw_payload", "reason": "raw payload must be an object"})
            raw_payload: Mapping[str, Any] = {}
        else:
            raw_payload = sanitize_source_payload(record.raw_payload)
        if not record.activities:
            errors.append({"record_index": record_index, "field": "activities", "reason": "source record must emit at least one activity"})

        activities: list[CanonicalActivityInput] = []
        legs: set[int] = set()
        for activity_index, activity in enumerate(record.activities):
            normalized, activity_errors = _validate_activity(
                activity,
                record_index=record_index,
                activity_index=activity_index,
            )
            errors.extend(activity_errors)
            if normalized is not None:
                if normalized.leg_index in legs:
                    errors.append({
                        "record_index": record_index,
                        "activity_index": activity_index,
                        "field": "leg_index",
                        "reason": f"duplicate leg index {normalized.leg_index} within source record",
                    })
                legs.add(normalized.leg_index)
                activities.append(normalized)
        normalized_records.append(
            SourceRecordEnvelope(
                occurred_at=occurred_at,
                raw_payload=raw_payload,
                activities=tuple(activities),
                provider_record_id=(
                    record.provider_record_id.strip()
                    if record.provider_record_id and record.provider_record_id.strip()
                    else None
                ),
                metadata=sanitize_source_payload(record.metadata),
            )
        )

    if errors:
        raise ActivityValidationError(errors)
    return InvestmentActivityBatch(
        provider=provider,
        ingestion_type=ingestion_type,
        records=tuple(normalized_records),
        normalization_version=version,
        source_name=batch.source_name.strip()[:255] if batch.source_name else None,
        source_hash=batch.source_hash.lower() if batch.source_hash else None,
        cursor=sanitize_source_payload(batch.cursor) if batch.cursor is not None else None,
        warnings=tuple(str(item) for item in batch.warnings),
    )


def preview_batch(
    batch: InvestmentActivityBatch,
    *,
    account_id: str | UUID,
) -> ActivityBatchPreview:
    validated = validate_batch(batch, account_id=account_id)
    return ActivityBatchPreview(
        provider=validated.provider,
        record_count=len(validated.records),
        activity_count=sum(len(record.activities) for record in validated.records),
        source_keys=tuple(
            source_idempotency_key(
                provider=validated.provider,
                account_id=account_id,
                record=record,
            )
            for record in validated.records
        ),
        warnings=validated.warnings,
    )


def _canonical_activity_payload(activity: CanonicalActivityInput) -> dict[str, Any]:
    return {
        "activity_type": activity.activity_type,
        "occurred_at": activity.occurred_at,
        "asset_symbol": activity.asset_symbol,
        "asset_name": activity.asset_name,
        "asset_type": activity.asset_type,
        "leg_index": activity.leg_index,
        "quantity": activity.quantity,
        "price": activity.price,
        "gross_amount": activity.gross_amount,
        "net_amount": activity.net_amount,
        "currency": activity.currency,
        "fee_amount": activity.fee_amount,
        "fee_currency": activity.fee_currency,
        "tax_amount": activity.tax_amount,
        "tax_currency": activity.tax_currency,
        "counter_asset_symbol": activity.counter_asset_symbol,
        "counter_quantity": activity.counter_quantity,
        "direction": activity.direction,
        "external_group_id": activity.external_group_id,
        "aud_value": activity.aud_value,
        "valuation_source": activity.valuation_source,
        "valuation_timestamp": activity.valuation_timestamp,
        "assumptions": activity.assumptions,
        "warnings": activity.warnings,
        "metadata": sanitize_source_payload(activity.metadata),
    }


def _instrument_type(asset_type: str) -> str:
    if asset_type == "fund":
        return "etf"
    if asset_type in {"equity", "crypto", "cash"}:
        return asset_type
    return "other"


def _ensure_holding(db: Session, account: Account, activity: InvestmentActivity) -> Holding:
    holding = (
        db.query(Holding)
        .filter(
            Holding.account_id == account.id,
            Holding.symbol == activity.asset_symbol,
            Holding.instrument_type == _instrument_type(activity.asset_type),
        )
        .one_or_none()
    )
    if holding is None:
        holding = Holding(
            user_id=account.user_id,
            account_id=account.id,
            symbol=activity.asset_symbol,
            name=activity.asset_name,
            currency=activity.currency or account.currency or "AUD",
            instrument_type=_instrument_type(activity.asset_type),
            quantity=Decimal("0"),
            avg_cost=None,
            as_of_date=activity.occurred_at.date(),
            source="activity_import",
        )
        db.add(holding)
        db.flush()
    return holding


def _apply_trade_activity(
    db: Session,
    account: Account,
    activity: InvestmentActivity,
    *,
    idempotency_key: str,
) -> None:
    side = "sell" if activity.activity_type == "sell" else "buy"
    fees = (
        Decimal(activity.fee_amount)
        if activity.fee_amount is not None
        and activity.fee_currency == activity.currency
        else Decimal("0")
    )
    external_id = f"ing:{idempotency_key}:{activity.leg_index}"
    trade = BrokerTrade(
        account_id=account.id,
        symbol=activity.asset_symbol,
        instrument_type=_instrument_type(activity.asset_type),
        trade_date=activity.occurred_at.date(),
        side=side,
        quantity=activity.quantity,
        price=activity.price,
        currency=activity.currency,
        fees=fees,
        external_id=external_id,
    )
    db.add(trade)
    db.flush()
    activity.broker_trade_id = trade.id


def _income_decimal(metadata: Mapping[str, Any], key: str) -> Decimal | None:
    value = metadata.get(key)
    if value is None or value == "":
        return None
    return _normalized_decimal(value, field_name=key)


def _apply_income_activity(
    db: Session,
    account: Account,
    activity: InvestmentActivity,
    *,
    idempotency_key: str,
) -> None:
    holding = _ensure_holding(db, account, activity)
    metadata = activity.activity_metadata or {}
    is_drp = activity.activity_type == "drp"
    event_type = (
        "distribution"
        if activity.activity_type == "distribution" or metadata.get("income_type") == "distribution"
        else "dividend"
    )
    cash_received = activity.net_amount
    if cash_received is None:
        cash_received = activity.gross_amount
    if cash_received is None and is_drp and activity.quantity is not None and activity.price is not None:
        cash_received = Decimal(activity.quantity) * Decimal(activity.price)
    source_id = f"ing:{idempotency_key}:{activity.leg_index}"
    event = InvestmentIncomeEvent(
        user_id=account.user_id,
        account_id=account.id,
        holding_id=holding.id,
        event_type=event_type,
        pay_date=activity.occurred_at.date(),
        ex_date=(date.fromisoformat(metadata["ex_date"]) if metadata.get("ex_date") else None),
        currency=activity.currency or account.currency or "AUD",
        cash_received=cash_received or Decimal("0"),
        franked_amount=_income_decimal(metadata, "franked_amount"),
        unfranked_amount=_income_decimal(metadata, "unfranked_amount"),
        franking_credit=_income_decimal(metadata, "franking_credit"),
        foreign_income=_income_decimal(metadata, "foreign_income"),
        foreign_tax_paid=_income_decimal(metadata, "foreign_tax_paid"),
        amit_amma_components=metadata.get("amit_amma_components"),
        is_drp=is_drp,
        drp_quantity=activity.quantity if is_drp else None,
        drp_price=activity.price if is_drp else None,
        reinvestment_trade_id=activity.broker_trade_id if is_drp else None,
        source_id=source_id,
        notes=metadata.get("notes"),
    )
    db.add(event)
    db.flush()
    activity.income_event_id = event.id


def _safe_error(exc: Exception) -> str:
    rendered = _SECRET_VALUE_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", str(exc))
    return rendered[:2000]


def apply_batch(
    db: Session,
    *,
    user_id: str,
    account_id: str | UUID,
    batch: InvestmentActivityBatch,
    commit: bool = True,
) -> dict[str, Any]:
    """Validate and atomically apply a canonical batch.

    A failed downstream write rolls back every source/activity/trade/income
    mutation from the batch while retaining the failed run for diagnostics.
    Callers that pass ``commit=False`` own the surrounding transaction.
    """
    account = (
        db.query(Account)
        .filter(Account.id == account_id, Account.user_id == user_id)
        .one_or_none()
    )
    if account is None:
        raise ActivityApplicationError(f"account not found or not owned by user: {account_id}")
    if account.account_type not in {"investment_manual", "investment_brokerage"}:
        raise ActivityApplicationError(f"account is not an investment account: {account.account_type}")

    validated = validate_batch(batch, account_id=account.id)
    run = InvestmentIngestionRun(
        user_id=user_id,
        account_id=account.id,
        provider=validated.provider,
        ingestion_type=validated.ingestion_type,
        status="applying",
        source_name=validated.source_name,
        source_hash=validated.source_hash,
        normalization_version=validated.normalization_version,
        cursor=validated.cursor,
        warnings=list(validated.warnings),
        summary={},
    )
    db.add(run)
    db.flush()

    inserted_records = 0
    skipped_records = 0
    inserted_activities = 0
    trade_activities: list[tuple[InvestmentActivity, str]] = []
    income_activities: list[tuple[InvestmentActivity, str]] = []
    affected_trade_instruments: set[tuple[str, str]] = set()

    try:
        with db.begin_nested():
            for record in validated.records:
                idempotency_key = source_idempotency_key(
                    provider=validated.provider,
                    account_id=account.id,
                    record=record,
                )
                payload_hash = source_payload_hash(record.raw_payload)
                source_id = db.execute(
                    pg_insert(InvestmentSourceRecord.__table__)
                    .values(
                        run_id=run.id,
                        user_id=user_id,
                        account_id=account.id,
                        provider=validated.provider,
                        provider_record_id=record.provider_record_id,
                        idempotency_key=idempotency_key,
                        payload_hash=payload_hash,
                        occurred_at=record.occurred_at,
                        source_payload=sanitize_source_payload(record.raw_payload),
                        source_metadata=sanitize_source_payload(record.metadata),
                        normalization_version=validated.normalization_version,
                    )
                    .on_conflict_do_nothing(
                        constraint="investment_source_records_account_provider_key_uq"
                    )
                    .returning(InvestmentSourceRecord.__table__.c.id)
                ).scalar_one_or_none()
                if source_id is None:
                    skipped_records += 1
                    continue
                inserted_records += 1

                for canonical in record.activities:
                    canonical_payload = _canonical_activity_payload(canonical)
                    activity = InvestmentActivity(
                        source_record_id=source_id,
                        run_id=run.id,
                        user_id=user_id,
                        account_id=account.id,
                        leg_index=canonical.leg_index,
                        activity_type=canonical.activity_type,
                        occurred_at=canonical.occurred_at,
                        asset_symbol=canonical.asset_symbol,
                        asset_name=canonical.asset_name,
                        asset_type=canonical.asset_type,
                        quantity=canonical.quantity,
                        price=canonical.price,
                        gross_amount=canonical.gross_amount,
                        net_amount=canonical.net_amount,
                        currency=canonical.currency,
                        fee_amount=canonical.fee_amount,
                        fee_currency=canonical.fee_currency,
                        tax_amount=canonical.tax_amount,
                        tax_currency=canonical.tax_currency,
                        counter_asset_symbol=canonical.counter_asset_symbol,
                        counter_quantity=canonical.counter_quantity,
                        direction=canonical.direction,
                        external_group_id=canonical.external_group_id,
                        aud_value=canonical.aud_value,
                        valuation_source=canonical.valuation_source,
                        valuation_timestamp=canonical.valuation_timestamp,
                        canonical_hash=_sha256(canonical_payload),
                        assumptions=list(canonical.assumptions),
                        warnings=list(canonical.warnings),
                        activity_metadata=sanitize_source_payload(canonical.metadata),
                    )
                    db.add(activity)
                    db.flush()
                    inserted_activities += 1
                    if canonical.activity_type in {"buy", "sell", "drp"}:
                        _apply_trade_activity(
                            db,
                            account,
                            activity,
                            idempotency_key=idempotency_key,
                        )
                        trade_activities.append((activity, idempotency_key))
                        affected_trade_instruments.add(
                            (canonical.asset_symbol, _instrument_type(canonical.asset_type))
                        )
                    if canonical.activity_type in {"dividend", "distribution", "drp"}:
                        income_activities.append((activity, idempotency_key))

            for symbol, instrument_type in sorted(affected_trade_instruments):
                _recompute_holding(db, account, symbol, instrument_type)
            # SessionLocal disables autoflush. Make trade-derived holdings
            # visible to the income phase so a same-batch dividend/DRP links
            # to the existing row instead of attempting a duplicate insert.
            if affected_trade_instruments:
                db.flush()
            for activity, idempotency_key in income_activities:
                _apply_income_activity(
                    db,
                    account,
                    activity,
                    idempotency_key=idempotency_key,
                )
            applied_at = datetime.utcnow()
            for activity, _ in trade_activities:
                activity.applied_at = applied_at
            for activity, _ in income_activities:
                activity.applied_at = applied_at
            db.query(InvestmentActivity).filter(
                InvestmentActivity.run_id == run.id,
                InvestmentActivity.applied_at.is_(None),
            ).update({InvestmentActivity.applied_at: applied_at}, synchronize_session=False)

        run.status = "completed"
        run.completed_at = datetime.utcnow()
        run.summary = {
            "source_records": len(validated.records),
            "inserted_records": inserted_records,
            "skipped_duplicate_records": skipped_records,
            "inserted_activities": inserted_activities,
            "affected_symbols": sorted({symbol for symbol, _ in affected_trade_instruments}),
        }
        if commit:
            db.commit()
        else:
            db.flush()
    except Exception as exc:
        run.status = "failed"
        run.completed_at = datetime.utcnow()
        run.error = _safe_error(exc)
        run.summary = {
            "source_records": len(validated.records),
            "inserted_records": 0,
            "skipped_duplicate_records": 0,
            "inserted_activities": 0,
        }
        if commit:
            db.commit()
        else:
            db.flush()
        raise ActivityApplicationError(
            f"investment activity batch failed atomically: {run.error}",
            run_id=run.id,
        ) from exc

    return {
        "run_id": str(run.id),
        "status": run.status,
        **run.summary,
    }


def source_record_view(record: InvestmentSourceRecord) -> dict[str, Any]:
    """Safe provenance representation for API/UI consumers."""
    return {
        "id": str(record.id),
        "run_id": str(record.run_id),
        "provider": record.provider,
        "provider_record_id": record.provider_record_id,
        "idempotency_key": record.idempotency_key,
        "payload_hash": record.payload_hash,
        "occurred_at": record.occurred_at.isoformat(),
        "source_payload": sanitize_source_payload(record.source_payload),
        "source_metadata": sanitize_source_payload(record.source_metadata),
        "normalization_version": record.normalization_version,
        "created_at": record.created_at.isoformat(),
    }


def revert_run(
    db: Session,
    *,
    user_id: str,
    run_id: str | UUID,
    commit: bool = True,
) -> dict[str, Any]:
    """Remove only the economic records created by one ingestion run.

    Immutable source rows and canonical activities remain as an audit trail and
    continue to deduplicate the same provider record if it is uploaded again.
    """
    run = (
        db.query(InvestmentIngestionRun)
        .filter(InvestmentIngestionRun.id == run_id, InvestmentIngestionRun.user_id == user_id)
        .one_or_none()
    )
    if run is None:
        raise ActivityApplicationError("investment ingestion run not found")
    if run.ingestion_type != "csv_import":
        raise ActivityApplicationError("only CSV import runs can be reverted from this workflow")
    if run.status == "reverted":
        return {
            "run_id": str(run.id),
            "status": "reverted",
            "removed_trades": 0,
            "removed_income_events": 0,
            "affected_symbols": [],
        }
    if run.status not in {"completed", "partial"}:
        raise ActivityApplicationError(f"run cannot be reverted while its status is {run.status!r}")

    activities = (
        db.query(InvestmentActivity)
        .filter(InvestmentActivity.run_id == run.id, InvestmentActivity.user_id == user_id)
        .all()
    )
    trade_ids = {activity.broker_trade_id for activity in activities if activity.broker_trade_id}
    income_ids = {activity.income_event_id for activity in activities if activity.income_event_id}
    trades = db.query(BrokerTrade).filter(BrokerTrade.id.in_(trade_ids)).all() if trade_ids else []
    income_events = (
        db.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.id.in_(income_ids)).all()
        if income_ids else []
    )
    affected_instruments = {(trade.symbol, trade.instrument_type) for trade in trades}
    account = db.query(Account).filter(Account.id == run.account_id, Account.user_id == user_id).one()

    try:
        with db.begin_nested():
            for activity in activities:
                activity.income_event_id = None
                activity.broker_trade_id = None
                activity.applied_at = None
            for event in income_events:
                db.delete(event)
            db.flush()
            for trade in trades:
                db.delete(trade)
            db.flush()
            for symbol, instrument_type in sorted(affected_instruments):
                _recompute_holding(db, account, symbol, instrument_type)
            run.status = "reverted"
            run.reverted_at = datetime.utcnow()
            previous_summary = dict(run.summary or {})
            run.summary = {
                **previous_summary,
                "reverted_trades": len(trades),
                "reverted_income_events": len(income_events),
                "reverted_affected_symbols": sorted({symbol for symbol, _ in affected_instruments}),
            }
        if commit:
            db.commit()
        else:
            db.flush()
    except Exception as exc:
        if commit:
            db.rollback()
        raise ActivityApplicationError(
            f"investment import reversal failed atomically: {_safe_error(exc)}",
            run_id=run.id,
        ) from exc

    return {
        "run_id": str(run.id),
        "status": run.status,
        "removed_trades": len(trades),
        "removed_income_events": len(income_events),
        "affected_symbols": sorted({symbol for symbol, _ in affected_instruments}),
    }
