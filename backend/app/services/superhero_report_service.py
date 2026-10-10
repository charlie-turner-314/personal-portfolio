"""Deterministic parsers for Superhero income CSVs and AMIT PDF statements."""
from __future__ import annotations

import base64
import binascii
import csv
import hashlib
import io
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Sequence

from pypdf import PdfReader

from app.services.investment_activity_service import (
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    validate_batch,
)


MAX_REPORT_BYTES = 10 * 1024 * 1024
SUPERHERO_INCOME_NORMALIZATION_VERSION = "superhero-income-v1"
SUPERHERO_AMIT_NORMALIZATION_VERSION = "superhero-amit-v1"

_AUS_INCOME_HEADERS = {
    "income type", "security", "ex date", "payment date",
    "dividend rate per unit", "participating shares", "unfranked amount",
    "franked amount", "total payment", "withholding tax", "net amount",
    "franking credit",
}
_US_INCOME_HEADERS = {
    "security description", "ex date", "payment date", "dividend rate per unit",
    "participating shares", "total payment", "withholding tax", "net amount",
}
_PDF_HEADERS = (
    "Fund", "Symbol", "Financial year end", "Gross cash distribution",
    "Net cash distribution", "Unfranked amount", "Franked amount",
    "Franking credit", "Foreign income", "Foreign tax paid", "TFN withholding",
    "AMIT cost-base increase", "AMIT cost-base decrease",
)
_MONEY = r"\$?\(?-?[0-9][0-9,]*(?:\.[0-9]+)?\)?"


class SuperheroReportError(ValueError):
    """A supplied file is not a supported Superhero report."""


@dataclass(frozen=True)
class SuperheroReportResult:
    batch: InvestmentActivityBatch
    rows: tuple[dict[str, Any], ...]
    rejected_rows: tuple[dict[str, Any], ...]
    headers: tuple[str, ...]
    amount_format: str = "DOT_DECIMAL"


def _token(value: str) -> str:
    return re.sub(r"[\s_-]+", " ", value.strip().casefold())


def _money(value: str | None) -> Decimal | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    negative = raw.startswith("-") or (raw.startswith("(") and raw.endswith(")"))
    cleaned = re.sub(r"[^0-9.]", "", raw.replace(",", ""))
    if not cleaned:
        return None
    try:
        amount = Decimal(cleaned)
    except InvalidOperation as exc:
        raise SuperheroReportError(f"Invalid amount {value!r} in Superhero report.") from exc
    return -amount if negative else amount


def _date(value: str) -> datetime:
    try:
        return datetime.strptime(value.strip(), "%d/%m/%Y")
    except ValueError as exc:
        raise SuperheroReportError(f"Invalid Superhero date {value!r}; expected DD/MM/YYYY.") from exc


def _safe_metadata(rows: Sequence[Sequence[str]]) -> dict[str, str]:
    """Keep period metadata but deliberately exclude names and account identifiers."""
    allowed = {"report start date", "report end date", "report creation date"}
    result: dict[str, str] = {}
    for row in rows:
        if len(row) < 2 or _token(row[0]) not in allowed:
            continue
        result[_token(row[0]).replace(" ", "_")] = row[1].strip()
    return result


def _csv_rows(content: str) -> tuple[list[list[str]], int]:
    if len(content.encode("utf-8")) > MAX_REPORT_BYTES:
        raise SuperheroReportError("The file exceeds the 10 MB import limit.")
    try:
        rows = list(csv.reader(io.StringIO(content)))
    except csv.Error as exc:
        raise SuperheroReportError(f"The Superhero CSV could not be read: {exc}.") from exc
    for index, row in enumerate(rows[:25]):
        headers = {_token(cell) for cell in row if cell.strip()}
        if _AUS_INCOME_HEADERS.issubset(headers) or _US_INCOME_HEADERS.issubset(headers):
            return rows, index
    raise SuperheroReportError("This is not a supported Superhero AUS or US Income Report CSV.")


def is_superhero_income_csv(content: str) -> bool:
    try:
        _csv_rows(content)
        return True
    except SuperheroReportError:
        return False


def _us_symbol(description: str) -> str:
    value = description.strip().upper()
    if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,15}", value):
        return value
    raise SuperheroReportError(
        "Security Description is not an unambiguous ticker; this row needs provider-format validation before import."
    )


def parse_superhero_income_csv(*, file_name: str, content: str) -> SuperheroReportResult:
    rows, header_index = _csv_rows(content)
    headers = [cell.strip() for cell in rows[header_index]]
    indices = {_token(header): index for index, header in enumerate(headers)}
    market = "AUS" if _AUS_INCOME_HEADERS.issubset(indices) else "US"
    currency = "AUD" if market == "AUS" else "USD"
    safe_report = {**_safe_metadata(rows[:header_index]), "market": market, "report_type": "income_report"}
    records: list[SourceRecordEnvelope] = []
    preview: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    def value(row: Sequence[str], name: str) -> str:
        index = indices[name]
        return row[index].strip() if index < len(row) else ""

    for row_index, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        if not any(cell.strip() for cell in row):
            continue
        first = next((cell.strip() for cell in row if cell.strip()), "")
        if _token(first) == "total":
            continue
        raw = {header: (row[index].strip() if index < len(row) else "") for index, header in enumerate(headers)}
        try:
            if market == "AUS":
                income_type = value(row, "income type") or "Dividend"
                symbol = value(row, "security").upper()
                name = None
                franked = _money(value(row, "franked amount"))
                unfranked = _money(value(row, "unfranked amount"))
                franking = _money(value(row, "franking credit"))
                foreign_income = None
                # The CSV says only "Withholding Tax". Preserve it without
                # guessing whether it is TFN/ABN or another withholding class.
                withholding_key = "withholding_tax"
            else:
                income_type = "Dividend"
                description = value(row, "security description")
                symbol = _us_symbol(description)
                name = description if description.upper() != symbol else None
                franked = unfranked = franking = None
                foreign_income = _money(value(row, "total payment"))
                withholding_key = "foreign_tax_paid"
            if not symbol:
                raise SuperheroReportError("Security is required.")
            occurred_at = _date(value(row, "payment date"))
            ex_date = _date(value(row, "ex date")).date().isoformat()
            gross = _money(value(row, "total payment"))
            net = _money(value(row, "net amount"))
            withholding = _money(value(row, "withholding tax"))
            metadata: dict[str, Any] = {
                "description": income_type,
                "income_data_kind": "cash_activity",
                "ex_date": ex_date,
                "superhero_report": safe_report,
            }
            for key, amount in {
                "franked_amount": franked,
                "unfranked_amount": unfranked,
                "franking_credit": franking,
                "foreign_income": foreign_income,
                withholding_key: withholding,
            }.items():
                if amount is not None:
                    metadata[key] = amount
            activity = CanonicalActivityInput(
                activity_type="dividend",
                occurred_at=occurred_at,
                asset_symbol=symbol,
                asset_name=name,
                asset_type="equity",
                gross_amount=gross,
                net_amount=net,
                currency=currency,
                tax_amount=withholding,
                tax_currency=currency if withholding is not None else None,
                metadata=metadata,
            )
            provider_id = ":".join((market, symbol, ex_date, occurred_at.date().isoformat(), format(gross or Decimal("0"), "f")))
            envelope = SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=provider_id,
                raw_payload=raw,
                activities=(activity,),
                metadata={
                    "source_row_number": row_index,
                    "source_name": f"Superhero Income Report ({market}).csv",
                    "superhero_report": safe_report,
                },
            )
            envelope = validate_batch(
                InvestmentActivityBatch(provider="superhero", ingestion_type="csv_import", records=(envelope,)),
                account_id="00000000-0000-0000-0000-000000000000",
            ).records[0]
            records.append(envelope)
            preview.append({
                "row_number": row_index,
                "status": "ready",
                "normalized": _serialize(envelope.activities[0]),
                "warnings": list(envelope.activities[0].warnings),
                "raw": raw,
            })
        except (SuperheroReportError, ValueError) as exc:
            rejected.append({"row_number": row_index, "reasons": [str(exc)], "raw": raw})
    source_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return SuperheroReportResult(
        batch=InvestmentActivityBatch(
            provider="superhero",
            ingestion_type="csv_import",
            source_name=f"Superhero Income Report ({market}).csv",
            source_hash=source_hash,
            records=tuple(records),
            normalization_version=SUPERHERO_INCOME_NORMALIZATION_VERSION,
            warnings=(f"Superhero Income Report ({market}) preset applied; report metadata rows and TOTAL were excluded.",),
        ),
        rows=tuple(preview),
        rejected_rows=tuple(rejected),
        headers=tuple(headers),
    )


def _serialize(activity: CanonicalActivityInput) -> dict[str, Any]:
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


def _decode_pdf(encoded: str) -> bytes:
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SuperheroReportError("The PDF payload is not valid base64.") from exc
    if not payload.startswith(b"%PDF-"):
        raise SuperheroReportError("The uploaded file is not a PDF.")
    if len(payload) > MAX_REPORT_BYTES:
        raise SuperheroReportError("The file exceeds the 10 MB import limit.")
    return payload


def _amount_after(text: str, label: str, *, last: bool = False) -> Decimal | None:
    match = re.search(re.escape(label) + rf"\s+({_MONEY}(?:\s+{_MONEY})*)", text, re.IGNORECASE)
    if not match:
        return None
    values = re.findall(_MONEY, match.group(1))
    return _money(values[-1 if last else 0]) if values else None


def _ato_amount(text: str, code: str) -> Decimal | None:
    match = re.search(rf"\b{re.escape(code)}\s+({_MONEY})", text, re.IGNORECASE)
    return _money(match.group(1)) if match else None


def parse_superhero_amit_pdf(*, file_name: str, encoded_content: str) -> SuperheroReportResult:
    payload = _decode_pdf(encoded_content)
    try:
        reader = PdfReader(io.BytesIO(payload))
        pages = [(page.extract_text() or "") for page in reader.pages]
    except Exception as exc:
        raise SuperheroReportError("The PDF could not be read.") from exc
    start_pages = [
        index for index, text in enumerate(pages)
        if "ATTRIBUTION MANAGED INVESTMENT TRUST MEMBER ANNUAL STATEMENT" in text.upper()
    ]
    if not start_pages:
        raise SuperheroReportError("This is not a Superhero AMIT member annual statement PDF.")

    records: list[SourceRecordEnvelope] = []
    preview: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for start in start_pages:
        page_number = start + 1
        raw: dict[str, str] = {}
        try:
            if start + 3 >= len(pages):
                raise SuperheroReportError("An AMIT holding section is incomplete.")
            summary, components, distributions, adjustments = pages[start : start + 4]
            if (
                "COMPONENTS OF ATTRIBUTION" not in components.upper()
                or "GROSS CASH DISTRIBUTION" not in distributions.upper()
                or "AMIT') COST BASE ADJUSTMENTS" not in adjustments.upper()
            ):
                raise SuperheroReportError("The AMIT holding section does not match the expected four-page layout.")
            title = next(
                (line.strip() for line in summary.splitlines() if re.search(r"\s-\s[A-Z0-9.-]{1,20}$", line.strip())),
                "",
            )
            title_match = re.match(r"^(.+?)\s+-\s+([A-Z0-9.-]{1,20})$", title)
            if not title_match:
                raise SuperheroReportError("Could not identify the fund name and ticker.")
            fund_name, symbol = title_match.groups()
            year_match = re.search(r"FOR THE YEAR ENDED\s+30 JUNE\s+(\d{4})", summary, re.IGNORECASE)
            if not year_match:
                raise SuperheroReportError("Could not identify the AMIT financial-year end.")
            year = int(year_match.group(1))
            occurred_at = datetime(year, 6, 30)
            gross_cash = _amount_after(distributions, "Gross Cash Distribution")
            net_cash = _amount_after(distributions, "Net Cash Distribution")
            if gross_cash is None and net_cash is None:
                raise SuperheroReportError("Could not identify the cash distribution total.")
            franked = _ato_amount(summary, "13C")
            unfranked = _ato_amount(summary, "13U")
            franking = _ato_amount(summary, "13Q")
            foreign_income = _ato_amount(summary, "20M")
            foreign_tax = _ato_amount(summary, "20O")
            tfn = _amount_after(distributions, "Less: TFN/ABN Withholding Tax")
            increase = _amount_after(adjustments, "AMIT cost base net increase amount")
            decrease = _amount_after(adjustments, "AMIT cost base net decrease amount")
            amma = {
                key: format(value, "f")
                for key, value in {
                    "ato_10l_gross_interest": _ato_amount(summary, "10L"),
                    "ato_18a_net_capital_gain": _ato_amount(summary, "18A"),
                    "ato_18h_total_current_year_capital_gains": _ato_amount(summary, "18H"),
                    "tax_deferred": _amount_after(distributions, "Tax-Deferred Amount", last=True),
                    "tax_free": _amount_after(distributions, "Tax Free Income", last=True),
                    "other_non_assessable": _amount_after(distributions, "Total Non-assessable amounts", last=True),
                }.items()
                if value is not None
            }
            metadata: dict[str, Any] = {
                "income_data_kind": "annual_statement",
                "is_annual_statement": True,
                "annual_aggregate": True,
                "income_type": "distribution",
                "statement_period_start": f"{year - 1}-07-01",
                "statement_period_end": f"{year}-06-30",
                "annual_statement_reference": f"Superhero AMIT FY{year} {symbol}",
                "amit_amma_components": amma,
                "cost_base_effective_date": f"{year}-06-30",
            }
            for key, amount in {
                "franked_amount": franked,
                "unfranked_amount": unfranked,
                "franking_credit": franking,
                "foreign_income": foreign_income,
                "foreign_tax_paid": foreign_tax,
                "tfn_withholding": tfn,
                "cost_base_increase": increase,
                "cost_base_decrease": decrease,
            }.items():
                if amount is not None:
                    metadata[key] = amount
            activity = CanonicalActivityInput(
                activity_type="distribution",
                occurred_at=occurred_at,
                asset_symbol=symbol,
                asset_name=fund_name,
                asset_type="fund",
                gross_amount=gross_cash,
                net_amount=net_cash,
                currency="AUD",
                metadata=metadata,
            )
            raw = {
                "Fund": fund_name,
                "Symbol": symbol,
                "Financial year end": f"{year}-06-30",
                "Gross cash distribution": format(gross_cash or Decimal("0"), "f"),
                "Net cash distribution": format(net_cash or Decimal("0"), "f"),
                "AMIT cost-base increase": format(increase or Decimal("0"), "f"),
                "AMIT cost-base decrease": format(decrease or Decimal("0"), "f"),
            }
            envelope = SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=f"amit:{year}:{symbol}",
                raw_payload=raw,
                activities=(activity,),
                metadata={
                    "source_page_number": page_number,
                    "source_name": "Superhero AMIT Statement.pdf",
                    "report_type": "amit_member_annual_statement",
                },
            )
            envelope = validate_batch(
                InvestmentActivityBatch(provider="superhero", ingestion_type="csv_import", records=(envelope,)),
                account_id="00000000-0000-0000-0000-000000000000",
            ).records[0]
            records.append(envelope)
            preview.append({
                "row_number": page_number,
                "status": "ready",
                "normalized": _serialize(envelope.activities[0]),
                "warnings": ["Annual totals require reconciliation to one recorded distribution for this holding and financial year."],
                "raw": raw,
            })
        except (SuperheroReportError, ValueError) as exc:
            rejected.append({"row_number": page_number, "reasons": [str(exc)], "raw": raw})
    return SuperheroReportResult(
        batch=InvestmentActivityBatch(
            provider="superhero",
            ingestion_type="csv_import",
            source_name="Superhero AMIT Statement.pdf",
            source_hash=hashlib.sha256(payload).hexdigest(),
            records=tuple(records),
            normalization_version=SUPERHERO_AMIT_NORMALIZATION_VERSION,
            warnings=(
                "Superhero AMIT PDF preset applied; personal header text was not retained in source records.",
                "Statement values are annual aggregates and remain in reconciliation review until linked.",
            ),
        ),
        rows=tuple(preview),
        rejected_rows=tuple(rejected),
        headers=_PDF_HEADERS,
    )
