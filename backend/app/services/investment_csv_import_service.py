"""Generic CSV normalization, preview, application, and reversal for investments.

The browser converts XLS/XLSX first sheets to CSV text, but this module remains
the authoritative parser.  Every apply reparses the source text and delegates
the resulting provider-neutral batch to ``investment_activity_service``.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import Account, Holding, InvestmentIngestionRun, InvestmentSourceRecord
from app.services.investment_activity_service import (
    ACTIVITY_TYPES,
    ASSET_TYPES,
    ActivityValidationError,
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    apply_batch,
    source_idempotency_key,
    validate_batch,
)


MAX_IMPORT_BYTES = 10 * 1024 * 1024
MAX_IMPORT_ROWS = 50_000
DATE_FORMATS = frozenset({"AUTO", "DD-MM-YYYY", "MM-DD-YYYY"})
AMOUNT_FORMATS = frozenset({"AUTO", "DOT_DECIMAL", "COMMA_DECIMAL"})

MAPPING_FIELDS = (
    "occurred_at",
    "activity_type",
    "asset_symbol",
    "asset_name",
    "asset_type",
    "quantity",
    "price",
    "gross_amount",
    "net_amount",
    "currency",
    "fee_amount",
    "fee_currency",
    "fee_aud_value",
    "fee_valuation_source",
    "fee_valuation_timestamp",
    "tax_amount",
    "tax_currency",
    "source_reference",
    "counter_asset_symbol",
    "counter_quantity",
    "direction",
    "external_group_id",
    "transaction_hash",
    "aud_value",
    "valuation_source",
    "valuation_timestamp",
    "description",
    "ex_date",
    "franked_amount",
    "unfranked_amount",
    "franking_credit",
    "foreign_income",
    "foreign_tax_paid",
    "tfn_withholding",
    "amit_amma_components",
    "cost_base_increase",
    "cost_base_decrease",
    "cost_base_effective_date",
    "annual_statement_reference",
    "amma_interest",
    "amma_capital_gains_discounted",
    "amma_capital_gains_other",
    "amma_capital_gains_discount",
    "amma_tax_deferred",
    "amma_tax_free",
    "amma_other_non_assessable",
)

_NUMERIC_FIELDS = (
    "quantity",
    "price",
    "gross_amount",
    "net_amount",
    "fee_amount",
    "fee_aud_value",
    "aud_value",
    "tax_amount",
    "counter_quantity",
    "franked_amount",
    "unfranked_amount",
    "franking_credit",
    "foreign_income",
    "foreign_tax_paid",
    "tfn_withholding",
    "cost_base_increase",
    "cost_base_decrease",
    "amma_interest",
    "amma_capital_gains_discounted",
    "amma_capital_gains_other",
    "amma_capital_gains_discount",
    "amma_tax_deferred",
    "amma_tax_free",
    "amma_other_non_assessable",
)

_ACTIVITY_ALIASES = {
    "buy": "buy",
    "bought": "buy",
    "purchase": "buy",
    "sell": "sell",
    "sold": "sell",
    "sale": "sell",
    "dividend": "dividend",
    "dividends": "dividend",
    "cash dividend": "dividend",
    "distribution": "distribution",
    "distributions": "distribution",
    "fund distribution": "distribution",
    "drp": "drp",
    "dividend reinvestment": "drp",
    "reinvestment": "drp",
    "deposit": "deposit",
    "withdrawal": "withdrawal",
    "withdraw": "withdrawal",
    "transfer": "transfer",
    "fee": "fee",
    "commission": "fee",
    "interest": "interest",
    "staking reward": "staking_reward",
    "reward": "staking_reward",
    "airdrop": "airdrop",
    "crypto swap": "crypto_swap",
    "swap": "crypto_swap",
}

_ASSET_TYPE_ALIASES = {
    "stock": "equity",
    "share": "equity",
    "shares": "equity",
    "equity": "equity",
    "etf": "fund",
    "managed fund": "fund",
    "fund": "fund",
    "crypto": "crypto",
    "cryptocurrency": "crypto",
    "coin": "crypto",
    "cash": "cash",
    "option": "option",
    "bond": "bond",
    "other": "other",
}

_MONTH_FORMATS = (
    "%d %b %Y",
    "%d %B %Y",
    "%b %d %Y",
    "%B %d %Y",
    "%b %d, %Y",
    "%B %d, %Y",
)


class InvestmentCsvImportError(ValueError):
    """A file-level error that prevents a meaningful preview."""


@dataclass(frozen=True)
class ParsedInvestmentImport:
    batch: InvestmentActivityBatch
    rows: tuple[dict[str, Any], ...]
    rejected_rows: tuple[dict[str, Any], ...]
    headers: tuple[str, ...]
    amount_format: str


def _normal_token(value: str) -> str:
    return re.sub(r"[\s_-]+", " ", value.strip().lower())


def normalize_provider(value: str) -> str:
    provider = re.sub(r"[^a-z0-9_.-]+", "_", value.strip().lower()).strip("_.-")
    if not provider:
        raise InvestmentCsvImportError("Provider name is required.")
    return provider[:64]


def _read_csv(file_content: str) -> tuple[list[str], list[list[str]]]:
    if not isinstance(file_content, str) or not file_content.strip():
        raise InvestmentCsvImportError("The file is empty.")
    if len(file_content.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise InvestmentCsvImportError("The file exceeds the 10 MB import limit.")
    sample = file_content[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = "\t" if "\t" in sample else ";" if sample.count(";") > sample.count(",") else ","
    try:
        reader = csv.reader(io.StringIO(file_content), delimiter=delimiter)
        raw_rows = [[cell.strip() for cell in row] for row in reader if any(cell.strip() for cell in row)]
    except csv.Error as exc:
        raise InvestmentCsvImportError(f"The delimited file could not be read: {exc}.") from exc
    if not raw_rows:
        raise InvestmentCsvImportError("The file contains no rows.")
    headers = [cell.lstrip("\ufeff").strip() for cell in raw_rows[0]]
    if not headers or any(not header for header in headers):
        raise InvestmentCsvImportError("Every column must have a non-empty header.")
    normalized_headers = [header.casefold() for header in headers]
    duplicates = sorted({header for header in normalized_headers if normalized_headers.count(header) > 1})
    if duplicates:
        raise InvestmentCsvImportError(f"Duplicate column headers are not supported: {', '.join(duplicates)}.")
    rows = raw_rows[1:]
    if not rows:
        raise InvestmentCsvImportError("The file contains headers but no data rows.")
    if len(rows) > MAX_IMPORT_ROWS:
        raise InvestmentCsvImportError(f"The file exceeds the {MAX_IMPORT_ROWS:,} row import limit.")
    return headers, rows


def _mapping_indices(headers: Sequence[str], mapping: Mapping[str, Any], defaults: Mapping[str, Any]) -> dict[str, int]:
    unknown = sorted(set(mapping) - set(MAPPING_FIELDS))
    if unknown:
        raise InvestmentCsvImportError(f"Unsupported mapping fields: {', '.join(unknown)}.")
    exact = {header: index for index, header in enumerate(headers)}
    folded = {header.casefold(): index for index, header in enumerate(headers)}
    indices: dict[str, int] = {}
    missing_columns: list[str] = []
    for field in MAPPING_FIELDS:
        header = mapping.get(field)
        if header is None or str(header).strip() == "":
            indices[field] = -1
            continue
        name = str(header).strip()
        index = exact.get(name, folded.get(name.casefold(), -1))
        indices[field] = index
        if index < 0:
            missing_columns.append(name)
    if missing_columns:
        raise InvestmentCsvImportError(
            "Mapped columns were not found in the file: " + ", ".join(sorted(set(missing_columns))) + "."
        )
    required = ["occurred_at", "asset_symbol"]
    if indices.get("activity_type", -1) < 0 and not defaults.get("activity_type"):
        required.append("activity_type")
    absent = [field for field in required if indices.get(field, -1) < 0]
    if absent:
        raise InvestmentCsvImportError("Map the required fields before previewing: " + ", ".join(absent) + ".")
    return indices


def _value(row: Sequence[str], index: int) -> str | None:
    if index < 0 or index >= len(row):
        return None
    value = row[index].strip()
    return value or None


def _infer_amount_format(rows: Sequence[Sequence[str]], indices: Mapping[str, int]) -> str:
    dot = comma = 0
    for row in rows:
        for field in _NUMERIC_FIELDS:
            raw = _value(row, indices.get(field, -1))
            if not raw:
                continue
            token = re.sub(r"[^0-9.,]", "", raw)
            if "." in token and "," in token:
                if token.rfind(".") > token.rfind(","):
                    dot += 1
                else:
                    comma += 1
                continue
            separator = "." if "." in token else "," if "," in token else None
            if separator:
                digits_after = len(token) - token.rfind(separator) - 1
                if digits_after not in {0, 3}:
                    if separator == ".":
                        dot += 1
                    else:
                        comma += 1
    if dot and not comma:
        return "DOT_DECIMAL"
    if comma and not dot:
        return "COMMA_DECIMAL"
    return "AMBIGUOUS"


def _parse_decimal(raw: str | None, *, field: str, configured: str, inferred: str) -> Decimal | None:
    if raw is None:
        return None
    value = raw.strip().replace("\u2212", "-")
    negative = value.startswith("-") or value.endswith("-") or (value.startswith("(") and value.endswith(")"))
    token = re.sub(r"[^0-9.,'’\s\u00a0\u202f]", "", value)
    token = re.sub(r"['’\s\u00a0\u202f]", "", token)
    if not token or not re.search(r"\d", token):
        raise ValueError(f"{field} must be a number")
    decimal_separator: str | None = None
    if "." in token and "," in token:
        decimal_separator = "." if token.rfind(".") > token.rfind(",") else ","
    elif "." in token or "," in token:
        separator = "." if "." in token else ","
        resolved = configured if configured != "AUTO" else inferred
        if resolved in {"DOT_DECIMAL", "COMMA_DECIMAL"}:
            decimal_separator = "." if resolved == "DOT_DECIMAL" else ","
        else:
            digits_after = len(token) - token.rfind(separator) - 1
            groups = token.split(separator)
            if digits_after == 3 and len(groups) > 2 and all(len(group) == 3 for group in groups[1:]):
                decimal_separator = None
            elif digits_after in {0, 3}:
                raise ValueError(
                    f"{field} value {raw!r} is ambiguous; choose dot-decimal or comma-decimal format"
                )
            else:
                decimal_separator = separator
    if decimal_separator:
        decimal_index = token.rfind(decimal_separator)
        normalized = "".join(
            "." if char == decimal_separator and index == decimal_index else char if char.isdigit() else ""
            for index, char in enumerate(token)
        )
    else:
        normalized = re.sub(r"[.,]", "", token)
    try:
        result = Decimal(normalized)
    except InvalidOperation as exc:
        raise ValueError(f"{field} must be a number") from exc
    if not result.is_finite():
        raise ValueError(f"{field} must be finite")
    return -result if negative else result


def _parse_datetime(raw: str | None, date_format: str) -> datetime:
    if not raw:
        raise ValueError("occurred_at is required")
    value = raw.strip().replace("Z", "+00:00")
    try:
        if re.match(r"^\d{4}-\d{1,2}-\d{1,2}", value):
            parsed = datetime.fromisoformat(value)
            return parsed.replace(tzinfo=None) if parsed.tzinfo is None else parsed.astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        pass
    match = re.search(r"(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?!\d)", value)
    if match:
        first, second = int(match.group(1)), int(match.group(2))
        year = int(match.group(3))
        if year < 100:
            year += 2000 if year <= 50 else 1900
        if date_format == "AUTO":
            if first <= 12 and second <= 12:
                raise ValueError(
                    f"date {raw!r} is ambiguous; choose DD-MM-YYYY or MM-DD-YYYY"
                )
            day_first = first > 12
        else:
            day_first = date_format == "DD-MM-YYYY"
        month, day = (second, first) if day_first else (first, second)
        try:
            parsed = datetime(year, month, day)
        except ValueError as exc:
            raise ValueError(f"occurred_at is not a valid calendar date: {raw!r}") from exc
        time_match = re.search(r"(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?", value)
        if time_match:
            parsed = parsed.replace(
                hour=int(time_match.group(1)), minute=int(time_match.group(2)), second=int(time_match.group(3) or 0)
            )
        return parsed
    cleaned = re.sub(r"\s+", " ", value).strip()
    for pattern in _MONTH_FORMATS:
        try:
            return datetime.strptime(cleaned, pattern)
        except ValueError:
            continue
    raise ValueError(f"occurred_at is not a supported date: {raw!r}")


def _activity_type(raw: str | None, aliases: Mapping[str, str], default: str | None) -> str:
    value = raw or default
    if not value:
        raise ValueError("activity_type is required")
    token = _normal_token(str(value))
    mapped = aliases.get(token, _ACTIVITY_ALIASES.get(token, token.replace(" ", "_")))
    if mapped not in ACTIVITY_TYPES:
        raise ValueError(f"unsupported activity type {value!r}")
    return mapped


def _asset_type(raw: str | None, default: str) -> str:
    token = _normal_token(raw or default)
    mapped = _ASSET_TYPE_ALIASES.get(token, token.replace(" ", "_"))
    if mapped not in ASSET_TYPES:
        raise ValueError(f"unsupported asset type {(raw or default)!r}")
    return mapped


def _currency(raw: str | None, default: str | None, field: str) -> str | None:
    value = (raw or default)
    if value is None:
        return None
    normalized = value.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,16}", normalized):
        raise ValueError(f"{field} must be a 2-16 character currency or asset code")
    return normalized


def _serialize_activity(activity: CanonicalActivityInput) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for field in CanonicalActivityInput.__dataclass_fields__:
        value = getattr(activity, field)
        if isinstance(value, Decimal):
            value = format(value, "f")
        elif isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, tuple):
            value = list(value)
        result[field] = value
    return result


def parse_investment_csv(
    *,
    file_name: str,
    file_content: str,
    provider: str,
    mapping: Mapping[str, Any],
    date_format: str = "AUTO",
    amount_format: str = "AUTO",
    default_asset_type: str = "equity",
    default_currency: str | None = None,
    default_activity_type: str | None = None,
    activity_type_aliases: Mapping[str, str] | None = None,
    income_data_kind: str = "cash_activity",
) -> ParsedInvestmentImport:
    """Parse independent rows and retain actionable rejection reasons."""
    date_format = date_format.upper()
    amount_format = amount_format.upper()
    if date_format not in DATE_FORMATS:
        raise InvestmentCsvImportError(f"Unsupported date format {date_format!r}.")
    if amount_format not in AMOUNT_FORMATS:
        raise InvestmentCsvImportError(f"Unsupported amount format {amount_format!r}.")
    if income_data_kind not in {"cash_activity", "annual_statement"}:
        raise InvestmentCsvImportError(f"Unsupported income data kind {income_data_kind!r}.")
    headers, source_rows = _read_csv(file_content)
    defaults = {"activity_type": default_activity_type}
    indices = _mapping_indices(headers, mapping, defaults)
    inferred = _infer_amount_format(source_rows, indices)
    aliases = {
        _normal_token(str(key)): str(value).strip().lower()
        for key, value in (activity_type_aliases or {}).items()
    }
    records: list[SourceRecordEnvelope] = []
    preview_rows: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for source_index, row in enumerate(source_rows):
        row_number = source_index + 2
        raw_payload = {
            header: (row[index] if index < len(row) else "")
            for index, header in enumerate(headers)
        }
        reasons: list[str] = []
        warnings: list[str] = []
        try:
            occurred_at = _parse_datetime(_value(row, indices["occurred_at"]), date_format)
            activity_type = _activity_type(
                _value(row, indices.get("activity_type", -1)), aliases, default_activity_type
            )
            symbol_raw = _value(row, indices["asset_symbol"])
            if not symbol_raw:
                raise ValueError("asset_symbol is required")
            symbol = symbol_raw.strip().upper()
            asset_type = _asset_type(
                _value(row, indices.get("asset_type", -1)), default_asset_type
            )
            decimals = {
                field: _parse_decimal(
                    _value(row, indices.get(field, -1)), field=field, configured=amount_format, inferred=inferred
                )
                for field in _NUMERIC_FIELDS
            }
            for field, value in tuple(decimals.items()):
                if value is not None and value < 0:
                    decimals[field] = abs(value)
                    warnings.append(f"{field} was negative and was normalized to its absolute value")
            currency = _currency(
                _value(row, indices.get("currency", -1)), default_currency, "currency"
            )
            fee_currency = _currency(
                _value(row, indices.get("fee_currency", -1)), currency, "fee_currency"
            ) if decimals["fee_amount"] is not None else None
            tax_currency = _currency(
                _value(row, indices.get("tax_currency", -1)), currency, "tax_currency"
            ) if decimals["tax_amount"] is not None else None
            if decimals["fee_amount"] is not None and indices.get("fee_currency", -1) < 0 and currency:
                warnings.append("fee_currency defaulted to the activity currency")
            if decimals["tax_amount"] is not None and indices.get("tax_currency", -1) < 0 and currency:
                warnings.append("tax_currency defaulted to the activity currency")
            direction = _value(row, indices.get("direction", -1))
            valuation_timestamp_raw = _value(row, indices.get("valuation_timestamp", -1))
            fee_valuation_timestamp_raw = _value(row, indices.get("fee_valuation_timestamp", -1))
            valuation_source = _value(row, indices.get("valuation_source", -1))
            fee_valuation_source = _value(row, indices.get("fee_valuation_source", -1))
            valuation_timestamp = None
            fee_valuation_timestamp = None
            if decimals["aud_value"] is not None:
                valuation_source = valuation_source or f"{normalize_provider(provider)}_reported"
                valuation_timestamp = (
                    _parse_datetime(valuation_timestamp_raw, date_format)
                    if valuation_timestamp_raw else occurred_at
                )
                if valuation_timestamp_raw is None:
                    warnings.append("valuation_timestamp defaulted to the activity timestamp")
                if indices.get("valuation_source", -1) < 0:
                    warnings.append("valuation_source defaulted to the provider-reported CSV value")
            if decimals["fee_aud_value"] is not None:
                fee_valuation_source = fee_valuation_source or f"{normalize_provider(provider)}_reported"
                fee_valuation_timestamp = (
                    _parse_datetime(fee_valuation_timestamp_raw, date_format)
                    if fee_valuation_timestamp_raw else occurred_at
                )
                if fee_valuation_timestamp_raw is None:
                    warnings.append("fee_valuation_timestamp defaulted to the activity timestamp")
                if indices.get("fee_valuation_source", -1) < 0:
                    warnings.append("fee_valuation_source defaulted to the provider-reported CSV value")
            ex_date_raw = _value(row, indices.get("ex_date", -1))
            effective_date_raw = _value(row, indices.get("cost_base_effective_date", -1))
            components_raw = _value(row, indices.get("amit_amma_components", -1))
            components = None
            if components_raw:
                try:
                    components = json.loads(components_raw)
                except json.JSONDecodeError as exc:
                    raise ValueError("amit_amma_components must be a JSON object") from exc
                if not isinstance(components, dict):
                    raise ValueError("amit_amma_components must be a JSON object")
            components = dict(components or {})
            component_fields = {
                "interest": "amma_interest",
                "capital_gains_discounted": "amma_capital_gains_discounted",
                "capital_gains_other": "amma_capital_gains_other",
                "capital_gains_discount": "amma_capital_gains_discount",
                "tax_deferred": "amma_tax_deferred",
                "tax_free": "amma_tax_free",
                "other_non_assessable": "amma_other_non_assessable",
            }
            for component_name, field in component_fields.items():
                component_value = decimals[field]
                if component_value is not None:
                    rendered = format(component_value, "f")
                    existing_component = components.get(component_name)
                    if existing_component is not None and Decimal(str(existing_component)) != component_value:
                        raise ValueError(
                            f"AMMA component {component_name} conflicts with the mapped JSON object"
                        )
                    components[component_name] = rendered
            metadata = {
                "description": _value(row, indices.get("description", -1)),
                "source_row_number": row_number,
                "income_data_kind": income_data_kind,
                "is_annual_statement": income_data_kind == "annual_statement",
                "ex_date": _parse_datetime(ex_date_raw, date_format).date().isoformat() if ex_date_raw else None,
                "franked_amount": decimals["franked_amount"],
                "unfranked_amount": decimals["unfranked_amount"],
                "franking_credit": decimals["franking_credit"],
                "foreign_income": decimals["foreign_income"],
                "foreign_tax_paid": decimals["foreign_tax_paid"],
                "tfn_withholding": decimals["tfn_withholding"],
                "amit_amma_components": components or None,
                "cost_base_increase": decimals["cost_base_increase"],
                "cost_base_decrease": decimals["cost_base_decrease"],
                "cost_base_effective_date": (
                    _parse_datetime(effective_date_raw, date_format).date().isoformat()
                    if effective_date_raw else None
                ),
                "annual_statement_reference": _value(row, indices.get("annual_statement_reference", -1)),
                "transaction_hash": _value(row, indices.get("transaction_hash", -1)),
            }
            metadata = {key: value for key, value in metadata.items() if value is not None}
            activity = CanonicalActivityInput(
                activity_type=activity_type,
                occurred_at=occurred_at,
                asset_symbol=symbol,
                asset_name=_value(row, indices.get("asset_name", -1)),
                asset_type=asset_type,
                quantity=decimals["quantity"],
                price=decimals["price"],
                gross_amount=decimals["gross_amount"],
                net_amount=decimals["net_amount"],
                currency=currency,
                fee_amount=decimals["fee_amount"],
                fee_currency=fee_currency,
                fee_aud_value=decimals["fee_aud_value"],
                fee_valuation_source=fee_valuation_source,
                fee_valuation_timestamp=fee_valuation_timestamp,
                tax_amount=decimals["tax_amount"],
                tax_currency=tax_currency,
                counter_asset_symbol=_value(row, indices.get("counter_asset_symbol", -1)),
                counter_quantity=decimals["counter_quantity"],
                direction=direction,
                external_group_id=(
                    _value(row, indices.get("external_group_id", -1))
                    or _value(row, indices.get("transaction_hash", -1))
                ),
                aud_value=decimals["aud_value"],
                valuation_source=valuation_source,
                valuation_timestamp=valuation_timestamp,
                warnings=tuple(warnings),
                metadata=metadata,
            )
            record = SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=_value(row, indices.get("source_reference", -1)),
                raw_payload=raw_payload,
                activities=(activity,),
                metadata={"source_row_number": row_number, "file_name": file_name},
            )
            # Validate each row independently so one malformed row cannot hide
            # valid rows from the dry-run preview.
            validated = validate_batch(
                InvestmentActivityBatch(provider=normalize_provider(provider), ingestion_type="csv_import", records=(record,)),
                account_id="00000000-0000-0000-0000-000000000000",
            )
            record = validated.records[0]
            records.append(record)
            preview_rows.append({
                "row_number": row_number,
                "status": "ready",
                "normalized": _serialize_activity(record.activities[0]),
                "warnings": list(record.activities[0].warnings),
                "raw": raw_payload,
            })
        except ActivityValidationError as exc:
            reasons.extend(error["reason"] for error in exc.errors)
        except (ValueError, TypeError) as exc:
            reasons.append(str(exc))
        if reasons:
            rejected.append({"row_number": row_number, "reasons": reasons, "raw": raw_payload})
    source_hash = hashlib.sha256(file_content.encode("utf-8")).hexdigest()
    batch = InvestmentActivityBatch(
        provider=normalize_provider(provider),
        ingestion_type="csv_import",
        source_name=file_name[:255],
        source_hash=source_hash,
        records=tuple(records),
    )
    return ParsedInvestmentImport(
        batch=batch,
        rows=tuple(preview_rows),
        rejected_rows=tuple(rejected),
        headers=tuple(headers),
        amount_format=amount_format if amount_format != "AUTO" else inferred,
    )


def preview_investment_csv(
    db: Session,
    *,
    user_id: str,
    account_id: str | UUID,
    parse_options: Mapping[str, Any],
) -> tuple[ParsedInvestmentImport, dict[str, Any]]:
    account = db.query(Account).filter(Account.id == account_id, Account.user_id == user_id).one_or_none()
    if account is None or account.account_type not in {"investment_manual", "investment_brokerage"}:
        raise InvestmentCsvImportError("Investment account not found.")
    options = dict(parse_options)
    if not options.get("default_currency"):
        options["default_currency"] = account.currency
    parsed = parse_investment_csv(**options)
    keys = [
        source_idempotency_key(provider=parsed.batch.provider, account_id=account.id, record=record)
        for record in parsed.batch.records
    ]
    existing = set()
    if keys:
        existing = {
            key for (key,) in db.query(InvestmentSourceRecord.idempotency_key).filter(
                InvestmentSourceRecord.account_id == account.id,
                InvestmentSourceRecord.provider == parsed.batch.provider,
                InvestmentSourceRecord.idempotency_key.in_(keys),
            ).all()
        }
    account_holdings = db.query(Holding).filter(Holding.account_id == account.id).all()
    held_symbols = {holding.symbol for holding in account_holdings}
    holding_sources = {
        (holding.symbol, holding.instrument_type): (holding.source, Decimal(holding.quantity))
        for holding in account_holdings
    }
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    unmatched: set[str] = set()
    duplicate_count = 0
    conflict_count = 0
    for row, key in zip(parsed.rows, keys, strict=True):
        item = dict(row)
        symbol = item["normalized"]["asset_symbol"]
        item["idempotency_key"] = key
        activity_type = item["normalized"]["activity_type"]
        canonical_asset_type = item["normalized"]["asset_type"]
        instrument_type = "etf" if canonical_asset_type == "fund" else canonical_asset_type
        holding_source = holding_sources.get((symbol, instrument_type))
        if (
            activity_type in {"buy", "sell", "drp"}
            and holding_source is not None
            and holding_source[1] != 0
            and holding_source[0] not in {"trade_import", "activity_import"}
        ):
            item["status"] = "conflict"
            item["conflict_reason"] = (
                f"{symbol} is managed by {holding_source[0]}; import trades into a separate account "
                "so this file cannot overwrite another source's position."
            )
            conflict_count += 1
        elif key in existing:
            item["status"] = "duplicate"
            item["duplicate_reason"] = "This source record was already imported for this account and provider."
            duplicate_count += 1
        elif key in seen:
            item["status"] = "duplicate"
            item["duplicate_reason"] = "This source record appears more than once in the uploaded file."
            duplicate_count += 1
        if symbol not in held_symbols:
            item["asset_status"] = "new"
            unmatched.add(symbol)
        else:
            item["asset_status"] = "existing"
        seen.add(key)
        rows.append(item)
    ready_count = sum(row["status"] == "ready" for row in rows)
    response = {
        "provider": parsed.batch.provider,
        "file_name": parsed.batch.source_name,
        "source_hash": parsed.batch.source_hash,
        "headers": list(parsed.headers),
        "resolved_amount_format": parsed.amount_format,
        "rows": rows,
        "rejected_rows": list(parsed.rejected_rows),
        "unmatched_assets": sorted(unmatched),
        "summary": {
            "total_rows": len(rows) + len(parsed.rejected_rows),
            "ready_rows": ready_count,
            "duplicate_rows": duplicate_count,
            "rejected_rows": len(parsed.rejected_rows),
            "conflict_rows": conflict_count,
            "warning_rows": sum(bool(row["warnings"]) for row in rows),
        },
    }
    return parsed, response


def apply_investment_csv(
    db: Session,
    *,
    user_id: str,
    account_id: str | UUID,
    parse_options: Mapping[str, Any],
    selected_row_numbers: Sequence[int] | None = None,
) -> dict[str, Any]:
    parsed, preview = preview_investment_csv(
        db, user_id=user_id, account_id=account_id, parse_options=parse_options
    )
    selected = set(selected_row_numbers) if selected_row_numbers is not None else None
    preview_by_row = {row["row_number"]: row for row in preview["rows"]}
    selected_records = tuple(
        record
        for record, row in zip(parsed.batch.records, parsed.rows, strict=True)
        if preview_by_row[row["row_number"]]["status"] != "conflict"
        and (selected is None or row["row_number"] in selected)
    )
    if selected is not None:
        valid_numbers = {
            row["row_number"]
            for row in parsed.rows
            if preview_by_row[row["row_number"]]["status"] != "conflict"
        }
        unknown = sorted(selected - valid_numbers)
        if unknown:
            raise InvestmentCsvImportError(
                "Selected rows are not importable or do not exist: " + ", ".join(map(str, unknown)) + "."
            )
    if not selected_records and any(row["status"] == "conflict" for row in preview["rows"]):
        raise InvestmentCsvImportError(
            "No rows can be imported because their holdings are managed by another source. "
            "Choose or create a separate investment account."
        )
    excluded_conflicts = preview["summary"]["conflict_rows"]
    run_warnings: list[str] = []
    if parsed.rejected_rows:
        run_warnings.append(f"{len(parsed.rejected_rows)} malformed row(s) were excluded from the import.")
    if excluded_conflicts:
        run_warnings.append(
            f"{excluded_conflicts} row(s) were excluded because their holdings are managed by another source."
        )
    result = apply_batch(
        db,
        user_id=user_id,
        account_id=account_id,
        batch=InvestmentActivityBatch(
            provider=parsed.batch.provider,
            ingestion_type=parsed.batch.ingestion_type,
            records=selected_records,
            normalization_version=parsed.batch.normalization_version,
            source_name=parsed.batch.source_name,
            source_hash=parsed.batch.source_hash,
            warnings=tuple(run_warnings),
        ),
    )
    if parsed.rejected_rows or excluded_conflicts:
        run = db.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.id == result["run_id"]).one()
        run.status = "partial"
        run.summary = {
            **dict(run.summary or {}),
            "rejected_rows": len(parsed.rejected_rows),
            "conflict_rows": excluded_conflicts,
        }
        db.commit()
        result["status"] = "partial"
        result["rejected_rows"] = len(parsed.rejected_rows)
        result["conflict_rows"] = excluded_conflicts
    return {
        **result,
        "preview_summary": preview["summary"],
        "headers": list(parsed.headers),
    }
