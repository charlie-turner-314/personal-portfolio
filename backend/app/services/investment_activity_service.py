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
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
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
    InvestmentCostBaseAdjustment,
    InvestmentCryptoTransfer,
    InvestmentIncomeEnrichment,
    InvestmentIncomeEvent,
    InvestmentIngestionRun,
    InvestmentReconciliationItem,
    InvestmentSourceRecord,
    Transaction,
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
    fee_aud_value: Decimal | str | int | float | None = None
    fee_valuation_source: str | None = None
    fee_valuation_timestamp: datetime | None = None
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
        "fee_aud_value",
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
    for field_name in (
        "price", "gross_amount", "net_amount", "fee_amount", "fee_aud_value",
        "tax_amount", "aud_value",
    ):
        value = decimals[field_name]
        if value is not None and value < 0:
            errors.append({**prefix, "field": field_name, "reason": f"{field_name} must be non-negative"})

    currency = activity.currency.strip().upper() if activity.currency else None
    fee_currency = activity.fee_currency.strip().upper() if activity.fee_currency else None
    tax_currency = activity.tax_currency.strip().upper() if activity.tax_currency else None
    direction = activity.direction.strip().lower() if activity.direction else None
    counter_symbol = activity.counter_asset_symbol.strip().upper() if activity.counter_asset_symbol else None

    if activity_type in {"buy", "sell", "drp"}:
        if decimals["quantity"] is None:
            errors.append({**prefix, "field": "quantity", "reason": f"{activity_type} requires quantity"})
        crypto_aud_total = asset_type == "crypto" and decimals["aud_value"] is not None
        if decimals["price"] is None and not crypto_aud_total:
            errors.append({**prefix, "field": "price", "reason": f"{activity_type} requires price or an explicit crypto AUD value"})
        if not currency and not crypto_aud_total:
            errors.append({**prefix, "field": "currency", "reason": f"{activity_type} requires currency"})
    if activity_type in {"dividend", "distribution"} or (
        activity_type == "interest" and asset_type != "crypto"
    ):
        if decimals["gross_amount"] is None and decimals["net_amount"] is None:
            errors.append({**prefix, "field": "gross_amount", "reason": f"{activity_type} requires gross_amount or net_amount"})
        if not currency:
            errors.append({**prefix, "field": "currency", "reason": f"{activity_type} requires currency"})
    if activity_type in {"deposit", "withdrawal", "staking_reward", "airdrop"} and decimals["quantity"] is None:
        errors.append({**prefix, "field": "quantity", "reason": f"{activity_type} requires quantity"})
    if activity_type == "interest" and asset_type == "crypto" and decimals["quantity"] is None:
        errors.append({**prefix, "field": "quantity", "reason": "crypto interest requires quantity"})
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
        elif counter_symbol == symbol:
            errors.append({**prefix, "field": "counter_asset_symbol", "reason": "crypto_swap assets must differ"})
        if asset_type != "crypto":
            errors.append({**prefix, "field": "asset_type", "reason": "crypto_swap requires crypto asset_type"})
    if activity_type in {"staking_reward", "airdrop"} and asset_type != "crypto":
        errors.append({**prefix, "field": "asset_type", "reason": f"{activity_type} requires crypto asset_type"})

    if decimals["fee_amount"] is not None and not fee_currency:
        errors.append({**prefix, "field": "fee_currency", "reason": "fee_currency is required when fee_amount is present"})
    if decimals["tax_amount"] is not None and not tax_currency:
        errors.append({**prefix, "field": "tax_currency", "reason": "tax_currency is required when tax_amount is present"})
    if decimals["aud_value"] is not None:
        if not activity.valuation_source or not activity.valuation_source.strip():
            errors.append({**prefix, "field": "valuation_source", "reason": "AUD values require valuation provenance"})
        if activity.valuation_timestamp is None:
            errors.append({**prefix, "field": "valuation_timestamp", "reason": "AUD values require a valuation timestamp"})
    if decimals["fee_aud_value"] is not None:
        if not activity.fee_valuation_source or not activity.fee_valuation_source.strip():
            errors.append({**prefix, "field": "fee_valuation_source", "reason": "fee AUD values require valuation provenance"})
        if activity.fee_valuation_timestamp is None:
            errors.append({**prefix, "field": "fee_valuation_timestamp", "reason": "fee AUD values require a valuation timestamp"})

    valuation_timestamp = None
    if activity.valuation_timestamp is not None:
        try:
            valuation_timestamp = _normalized_datetime(
                activity.valuation_timestamp, field_name="valuation_timestamp"
            )
        except ValueError as exc:
            errors.append({**prefix, "field": "valuation_timestamp", "reason": str(exc)})

    fee_valuation_timestamp = None
    if activity.fee_valuation_timestamp is not None:
        try:
            fee_valuation_timestamp = _normalized_datetime(
                activity.fee_valuation_timestamp, field_name="fee_valuation_timestamp"
            )
        except ValueError as exc:
            errors.append({**prefix, "field": "fee_valuation_timestamp", "reason": str(exc)})

    if errors:
        return None, errors
    has_crypto_aud_value = decimals["aud_value"] is not None or (
        currency == "AUD" and decimals["price"] is not None
    )
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
        fee_aud_value=decimals["fee_aud_value"],
        fee_valuation_source=(
            activity.fee_valuation_source.strip() if activity.fee_valuation_source else None
        ),
        fee_valuation_timestamp=fee_valuation_timestamp,
        tax_amount=decimals["tax_amount"],
        tax_currency=tax_currency,
        counter_asset_symbol=counter_symbol,
        counter_quantity=decimals["counter_quantity"],
        direction=direction,
        aud_value=decimals["aud_value"],
        valuation_source=activity.valuation_source.strip() if activity.valuation_source else None,
        valuation_timestamp=valuation_timestamp,
        assumptions=tuple(str(item) for item in activity.assumptions) + (
            ("No AUD market value was inferred; tax amounts remain explicitly incomplete.",)
            if asset_type == "crypto"
            and activity_type in {"crypto_swap", "staking_reward", "airdrop", "interest"}
            and not has_crypto_aud_value
            else ()
        ),
        warnings=tuple(str(item) for item in activity.warnings) + (
            ("AUD market value is missing for this tax-sensitive crypto activity.",)
            if asset_type == "crypto"
            and activity_type in {"crypto_swap", "staking_reward", "airdrop", "interest"}
            and not has_crypto_aud_value
            else ()
        ),
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
        "fee_aud_value": activity.fee_aud_value,
        "fee_valuation_source": activity.fee_valuation_source,
        "fee_valuation_timestamp": activity.fee_valuation_timestamp,
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


def _economic_activity_signature(activity: CanonicalActivityInput | InvestmentActivity) -> tuple:
    """Provider-neutral fields used for conservative cross-source deduplication.

    Provider metadata, audit warnings, and AUD enrichment are intentionally not
    part of the signature: a later API sync often has different provenance or
    valuation detail than an earlier CSV export. Monetary and fee terms remain
    exact so two genuinely separate nearby executions are not merged.
    """
    return (
        activity.activity_type,
        activity.asset_symbol,
        activity.asset_type,
        _decimal_text(Decimal(activity.quantity)) if activity.quantity is not None else None,
        _decimal_text(Decimal(activity.price)) if activity.price is not None else None,
        _decimal_text(Decimal(activity.gross_amount)) if activity.gross_amount is not None else None,
        _decimal_text(Decimal(activity.net_amount)) if activity.net_amount is not None else None,
        activity.currency,
        _decimal_text(Decimal(activity.fee_amount)) if activity.fee_amount is not None else None,
        activity.fee_currency,
        _decimal_text(Decimal(activity.tax_amount)) if activity.tax_amount is not None else None,
        activity.tax_currency,
        activity.counter_asset_symbol,
        _decimal_text(Decimal(activity.counter_quantity))
        if activity.counter_quantity is not None else None,
        activity.direction,
    )


def _cross_source_duplicate_source_id(
    db: Session,
    *,
    account_id: UUID,
    provider: str,
    ingestion_type: str,
    record: SourceRecordEnvelope,
) -> UUID | None:
    """Return one unambiguous equivalent row from another source channel.

    Five minutes accommodates timestamp rounding between statement exports and
    APIs, including a CSV and API that use the same provider name. If more than
    one source row is equivalent, nothing is auto-suppressed: retaining a
    possible duplicate is safer than deleting a real repeated fill.
    """
    if any(
        item.metadata.get("is_annual_statement")
        or item.metadata.get("income_data_kind") == "annual_statement"
        for item in record.activities
    ):
        return None
    window_start = record.occurred_at - timedelta(minutes=5)
    window_end = record.occurred_at + timedelta(minutes=5)
    rows = (
        db.query(InvestmentActivity, InvestmentSourceRecord, InvestmentIngestionRun)
        .join(
            InvestmentSourceRecord,
            InvestmentSourceRecord.id == InvestmentActivity.source_record_id,
        )
        .join(
            InvestmentIngestionRun,
            InvestmentIngestionRun.id == InvestmentActivity.run_id,
        )
        .filter(
            InvestmentActivity.account_id == account_id,
            InvestmentActivity.occurred_at >= window_start,
            InvestmentActivity.occurred_at <= window_end,
        )
        .all()
    )
    by_source: dict[UUID, list[InvestmentActivity]] = {}
    for activity, source, run in rows:
        if source.provider == provider and run.ingestion_type == ingestion_type:
            continue
        by_source.setdefault(source.id, []).append(activity)
    incoming = Counter(_economic_activity_signature(item) for item in record.activities)
    matches = [
        source_id
        for source_id, activities in by_source.items()
        if Counter(_economic_activity_signature(item) for item in activities) == incoming
    ]
    return matches[0] if len(matches) == 1 else None


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
        occurred_at=activity.occurred_at,
        acquisition_date=activity.occurred_at.date(),
        side=side,
        quantity=activity.quantity,
        price=activity.price,
        currency=activity.currency,
        fees=fees,
        external_id=external_id,
        economic_type="trade",
        taxable_disposal=True,
        aud_value=activity.aud_value,
        valuation_source=activity.valuation_source,
        valuation_timestamp=activity.valuation_timestamp,
        valuation_missing=False,
        assumptions=list(activity.assumptions or []),
        source_activity_id=activity.id,
        event_group_id=activity.external_group_id,
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
    from app.services.investment_income_reconciliation_service import (
        create_cash_income_event,
        reconcile_annual_statement,
    )

    holding = _ensure_holding(db, account, activity)
    metadata = activity.activity_metadata or {}
    source_id = f"ing:{idempotency_key}:{activity.leg_index}"
    if metadata.get("is_annual_statement") or metadata.get("income_data_kind") == "annual_statement":
        reconcile_annual_statement(
            db,
            account=account,
            holding=holding,
            activity=activity,
        )
    else:
        create_cash_income_event(
            db,
            account=account,
            holding=holding,
            activity=activity,
            source_id=source_id,
        )


def safe_error_message(exc: Exception) -> str:
    rendered = _SECRET_VALUE_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", str(exc))
    return rendered[:2000]


def _cash_transfer_direction(activity: InvestmentActivity) -> str | None:
    if activity.activity_type == "deposit":
        return "in"
    if activity.activity_type == "withdrawal":
        return "out"
    return activity.direction if activity.direction in {"in", "out"} else None


def _reconcile_cash_transfer(
    db: Session,
    *,
    account: Account,
    activity: InvestmentActivity,
) -> None:
    """Match brokerage cash funding to owned accounts without moving money again."""
    direction = _cash_transfer_direction(activity)
    amount = Decimal(
        activity.quantity
        or activity.net_amount
        or activity.gross_amount
        or 0
    )
    if direction is None or amount <= 0:
        return
    currency = (activity.currency or activity.asset_symbol).upper()
    start = activity.occurred_at - timedelta(days=7)
    end = activity.occurred_at + timedelta(days=7)
    opposite_type = "withdrawal" if direction == "in" else "deposit"
    opposite_direction = "out" if direction == "in" else "in"
    activity_candidates = db.query(InvestmentActivity).filter(
        InvestmentActivity.user_id == account.user_id,
        InvestmentActivity.id != activity.id,
        InvestmentActivity.account_id != account.id,
        InvestmentActivity.asset_type == "cash",
        InvestmentActivity.asset_symbol == activity.asset_symbol,
        InvestmentActivity.quantity == amount,
        InvestmentActivity.occurred_at >= start,
        InvestmentActivity.occurred_at <= end,
    ).order_by(InvestmentActivity.occurred_at, InvestmentActivity.id).all()
    activity_candidates = [
        item for item in activity_candidates
        if item.activity_type == opposite_type
        or (item.activity_type == "transfer" and item.direction == opposite_direction)
    ]
    expected_transaction_type = "debit" if direction == "in" else "credit"
    expected_amount = -amount if direction == "in" else amount
    transaction_candidates = db.query(Transaction).filter(
        Transaction.user_id == account.user_id,
        Transaction.account_id != account.id,
        Transaction.transaction_type == expected_transaction_type,
        Transaction.currency == currency,
        Transaction.amount == expected_amount,
        Transaction.booked_at >= start,
        Transaction.booked_at <= end,
        Transaction.pending.is_(False),
    ).order_by(Transaction.booked_at, Transaction.id).all()

    candidate_count = len(activity_candidates) + len(transaction_candidates)
    confidence = "high" if candidate_count == 1 and (
        abs(
            (
                activity_candidates[0].occurred_at
                if activity_candidates else transaction_candidates[0].booked_at
            ) - activity.occurred_at
        ) <= timedelta(days=1)
    ) else "medium" if candidate_count else None
    item = InvestmentReconciliationItem(
        user_id=account.user_id,
        account_id=account.id,
        source_activity_id=activity.id,
        kind="cash_match",
        status="resolved" if candidate_count == 1 else "pending",
        reason=(
            "Matched one owned-account cash movement."
            if candidate_count == 1
            else "No owned cash movement matches this brokerage transfer."
            if candidate_count == 0
            else "Multiple owned cash movements could match this brokerage transfer."
        ),
        candidate_income_event_ids=[],
        candidate_transaction_ids=[str(item.id) for item in transaction_candidates],
        details={
            "workflow": "investment_cash_transfer",
            "direction": direction,
            "amount": format(amount, "f"),
            "currency": currency,
            "confidence": confidence,
            "candidate_activity_ids": [str(item.id) for item in activity_candidates],
        },
        resolution=(
            {
                "action": (
                    "auto_link_activity" if activity_candidates else "auto_link_transaction"
                ),
                "activity_id": (
                    str(activity_candidates[0].id) if activity_candidates else None
                ),
                "transaction_id": (
                    str(transaction_candidates[0].id) if transaction_candidates else None
                ),
                "confidence": confidence,
            }
            if candidate_count == 1 else None
        ),
        resolved_at=datetime.utcnow() if candidate_count == 1 else None,
    )
    db.add(item)
    if len(activity_candidates) == 1 and not transaction_candidates:
        counterpart = db.query(InvestmentReconciliationItem).filter(
            InvestmentReconciliationItem.source_activity_id == activity_candidates[0].id,
            InvestmentReconciliationItem.kind == "cash_match",
            InvestmentReconciliationItem.status == "pending",
        ).one_or_none()
        if counterpart is not None:
            counterpart.status = "resolved"
            counterpart.reason = "Matched one owned investment-account cash movement."
            counterpart.resolution = {
                "action": "auto_link_activity",
                "activity_id": str(activity.id),
                "confidence": confidence,
            }
            counterpart.resolved_at = datetime.utcnow()
    db.flush()


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
    cross_source_duplicates = 0
    inserted_activities = 0
    trade_activities: list[tuple[InvestmentActivity, str]] = []
    income_activities: list[tuple[InvestmentActivity, str]] = []
    affected_trade_instruments: set[tuple[str, str]] = set()
    transfer_summary = {
        "total_transfers": 0,
        "matched_pairs": 0,
        "ambiguous_transfers": 0,
        "pending_transfers": 0,
        "internal_transfers": 0,
    }

    try:
        with db.begin_nested():
            for record in validated.records:
                idempotency_key = source_idempotency_key(
                    provider=validated.provider,
                    account_id=account.id,
                    record=record,
                )
                payload_hash = source_payload_hash(record.raw_payload)
                duplicate_source_id = _cross_source_duplicate_source_id(
                    db,
                    account_id=account.id,
                    provider=validated.provider,
                    ingestion_type=validated.ingestion_type,
                    record=record,
                )
                source_metadata = sanitize_source_payload(record.metadata)
                if duplicate_source_id is not None:
                    source_metadata = {
                        **source_metadata,
                        "cross_source_duplicate_of_source_record_id": str(
                            duplicate_source_id
                        ),
                        "cross_source_duplicate_reason": (
                            "Equivalent economic activity already exists for this account "
                            "from another provider or ingestion channel."
                        ),
                    }
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
                        source_metadata=source_metadata,
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
                if duplicate_source_id is not None:
                    skipped_records += 1
                    cross_source_duplicates += 1
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
                        fee_aud_value=canonical.fee_aud_value,
                        fee_valuation_source=canonical.fee_valuation_source,
                        fee_valuation_timestamp=canonical.fee_valuation_timestamp,
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
                    is_crypto_accounting = canonical.asset_type == "crypto" and canonical.activity_type in {
                        "buy", "sell", "crypto_swap", "staking_reward", "airdrop", "interest",
                        "transfer", "deposit", "withdrawal", "fee",
                    }
                    if is_crypto_accounting:
                        from app.services.crypto_accounting_service import apply_crypto_activity

                        crypto_result = apply_crypto_activity(
                            db,
                            account=account,
                            activity=activity,
                            idempotency_key=idempotency_key,
                        )
                        if crypto_result.trades:
                            trade_activities.append((activity, idempotency_key))
                        affected_trade_instruments.update(crypto_result.affected_instruments)
                        if canonical.activity_type in {"transfer", "deposit", "withdrawal"}:
                            affected_trade_instruments.add((canonical.asset_symbol, "crypto"))
                    elif canonical.asset_type == "cash" and canonical.activity_type in {
                        "deposit", "withdrawal", "transfer",
                    }:
                        _reconcile_cash_transfer(db, account=account, activity=activity)
                    elif canonical.activity_type in {"buy", "sell", "drp"}:
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
                    if not is_crypto_accounting and canonical.activity_type in {"dividend", "distribution", "drp"}:
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
            from app.services.crypto_accounting_service import rebuild_owned_crypto_transfers

            transfer_summary = rebuild_owned_crypto_transfers(db, user_id=user_id)
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
            **(
                {"skipped_cross_source_records": cross_source_duplicates}
                if cross_source_duplicates else {}
            ),
            "inserted_activities": inserted_activities,
            "affected_symbols": sorted({symbol for symbol, _ in affected_trade_instruments}),
            **(transfer_summary if transfer_summary["total_transfers"] else {}),
        }
        if commit:
            db.commit()
        else:
            db.flush()
    except Exception as exc:
        run.status = "failed"
        run.completed_at = datetime.utcnow()
        run.error = safe_error_message(exc)
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
            "removed_cost_base_adjustments": 0,
            "affected_symbols": [],
        }
    if run.status not in {"completed", "partial"}:
        raise ActivityApplicationError(f"run cannot be reverted while its status is {run.status!r}")

    activities = (
        db.query(InvestmentActivity)
        .filter(InvestmentActivity.run_id == run.id, InvestmentActivity.user_id == user_id)
        .all()
    )
    activity_ids = {activity.id for activity in activities}
    trade_ids = {activity.broker_trade_id for activity in activities if activity.broker_trade_id}
    if activity_ids:
        trade_ids.update(
            trade_id for (trade_id,) in db.query(BrokerTrade.id).filter(
                BrokerTrade.source_activity_id.in_(activity_ids)
            ).all()
        )
    income_ids = {
        event_id for (event_id,) in db.query(InvestmentIncomeEvent.id).filter(
            InvestmentIncomeEvent.created_by_activity_id.in_(activity_ids)
        ).all()
    } if activity_ids else set()
    trades = db.query(BrokerTrade).filter(BrokerTrade.id.in_(trade_ids)).all() if trade_ids else []
    income_events = (
        db.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.id.in_(income_ids)).all()
        if income_ids else []
    )
    enrichments = db.query(InvestmentIncomeEnrichment).filter(
        InvestmentIncomeEnrichment.source_activity_id.in_(activity_ids)
    ).all() if activity_ids else []
    adjustments = db.query(InvestmentCostBaseAdjustment).filter(
        InvestmentCostBaseAdjustment.source_activity_id.in_(activity_ids)
    ).all() if activity_ids else []
    reconciliation_items = db.query(InvestmentReconciliationItem).filter(
        InvestmentReconciliationItem.source_activity_id.in_(activity_ids)
    ).all() if activity_ids else []
    crypto_transfers = db.query(InvestmentCryptoTransfer).filter(
        InvestmentCryptoTransfer.source_activity_id.in_(activity_ids)
    ).all() if activity_ids else []
    for event in income_events:
        later_external = db.query(InvestmentIncomeEnrichment.id).filter(
            InvestmentIncomeEnrichment.income_event_id == event.id,
            InvestmentIncomeEnrichment.source_activity_id.notin_(activity_ids),
        ).first()
        if later_external:
            raise ActivityApplicationError(
                "run cannot be reverted because a later annual statement enriched one of its income events"
            )
    for enrichment in enrichments:
        later_external = db.query(InvestmentIncomeEnrichment.id).filter(
            InvestmentIncomeEnrichment.income_event_id == enrichment.income_event_id,
            InvestmentIncomeEnrichment.created_at > enrichment.created_at,
            InvestmentIncomeEnrichment.source_activity_id.notin_(activity_ids),
        ).first()
        if later_external:
            raise ActivityApplicationError(
                "run cannot be reverted before a later annual-statement enrichment is reverted"
            )
    affected_instruments = {(trade.symbol, trade.instrument_type) for trade in trades}
    adjustment_holdings = {
        item.holding_id: db.query(Holding).filter(Holding.id == item.holding_id).one_or_none()
        for item in adjustments
    }
    affected_instruments.update(
        (holding.symbol, holding.instrument_type)
        for holding in adjustment_holdings.values()
        if holding is not None
    )
    account = db.query(Account).filter(Account.id == run.account_id, Account.user_id == user_id).one()

    try:
        with db.begin_nested():
            for enrichment in enrichments:
                event = db.query(InvestmentIncomeEvent).filter(
                    InvestmentIncomeEvent.id == enrichment.income_event_id
                ).one_or_none()
                if event is not None and (
                    event.user_confirmed_at is None
                    or event.user_confirmed_at <= enrichment.created_at
                ):
                    for field, value in (enrichment.previous_values or {}).items():
                        if field in {
                            "franked_amount", "unfranked_amount", "franking_credit",
                            "foreign_income", "foreign_tax_paid", "tfn_withholding",
                        } and value is not None:
                            value = Decimal(str(value))
                        elif field == "ex_date" and value:
                            value = date.fromisoformat(str(value))
                        setattr(event, field, value)
            for activity in activities:
                activity.income_event_id = None
                activity.broker_trade_id = None
                activity.applied_at = None
            for item in reconciliation_items:
                db.delete(item)
            for item in crypto_transfers:
                db.delete(item)
            for item in adjustments:
                db.delete(item)
            for enrichment in enrichments:
                db.delete(enrichment)
            for event in income_events:
                db.delete(event)
            db.flush()
            for trade in trades:
                db.delete(trade)
            db.flush()
            # Transfer projections can depend on an acquisition from the run
            # being reverted. Remove/rebuild them before recomputing holdings
            # so a now-unsupported transfer-out cannot cause a transient
            # oversell and block an otherwise valid reversal.
            from app.services.crypto_accounting_service import rebuild_owned_crypto_transfers

            rebuild_owned_crypto_transfers(db, user_id=user_id)
            for symbol, instrument_type in sorted(affected_instruments):
                _recompute_holding(db, account, symbol, instrument_type)
            run.status = "reverted"
            run.reverted_at = datetime.utcnow()
            previous_summary = dict(run.summary or {})
            run.summary = {
                **previous_summary,
                "reverted_trades": len(trades),
                "reverted_income_events": len(income_events),
                "reverted_income_enrichments": len(enrichments),
                "reverted_cost_base_adjustments": len(adjustments),
                "reverted_reconciliation_items": len(reconciliation_items),
                "reverted_crypto_transfers": len(crypto_transfers),
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
            f"investment import reversal failed atomically: {safe_error_message(exc)}",
            run_id=run.id,
        ) from exc

    return {
        "run_id": str(run.id),
        "status": run.status,
        "removed_trades": len(trades),
        "removed_income_events": len(income_events),
        "removed_income_enrichments": len(enrichments),
        "removed_cost_base_adjustments": len(adjustments),
        "removed_reconciliation_items": len(reconciliation_items),
        "removed_crypto_transfers": len(crypto_transfers),
        "affected_symbols": sorted({symbol for symbol, _ in affected_instruments}),
    }
