"""Crypto.com App Token Wallet CSV normalization.

Crypto.com App exports encode the economic meaning in ``Transaction Kind``.
The provider does not publish a stable per-row identifier and some balance
conversions are emitted as a debit/credit row pair, so this preset preserves
the source payload and derives deterministic identities without row numbers.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from app.services.investment_activity_service import (
    ActivityValidationError,
    CanonicalActivityInput,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    validate_batch,
)


PROVIDER = "crypto.com_app"
REQUIRED_HEADERS = frozenset({
    "Timestamp (UTC)",
    "Transaction Description",
    "Currency",
    "Amount",
    "To Currency",
    "To Amount",
    "Native Currency",
    "Native Amount",
    "Native Amount (in USD)",
    "Transaction Kind",
})
FIAT_CODES = frozenset({
    "AUD", "CAD", "CHF", "CNY", "DKK", "EUR", "GBP", "HKD", "JPY",
    "NOK", "NZD", "PLN", "SEK", "SGD", "USD", "ZAR",
})

TRADE_KINDS = frozenset({
    "viban_purchase",
    "van_purchase",
    "crypto_viban_exchange",
    "crypto_exchange",
    "crypto_to_van_sell_order",
    "trading.limit_order.fiat_wallet.sell_commit",
    "trading.limit_order.cash_account.purchase_commit",
    "trading.limit_order.crypto_wallet.exchange",
    "recurring_buy_order",
})
SIMPLE_TRADE_KINDS = frozenset({
    "crypto_purchase",
    "trading.crypto_purchase.google_pay",
})
INTEREST_KINDS = frozenset({
    "crypto_earn_interest_paid",
    "crypto_earn_extra_interest_paid",
    "finance.crypto_earn.loyalty_program_extra_interest_paid.crypto_wallet",
})
STAKING_REWARD_KINDS = frozenset({
    "mco_stake_reward",
    "supercharger_reward_to_app_credited",
    "finance.lockup.dpos_compound_interest.crypto_wallet",
    "finance.dpos.non_compound_interest.crypto_wallet",
    "finance.dpos.compound_interest.crypto_wallet",
})
REWARD_KINDS = frozenset({
    "rewards_platform_deposit_credited",
    "referral_bonus",
    "referral_gift",
    "admin_wallet_credited",
    "campaign_reward",
})
DEPOSIT_KINDS = frozenset({"crypto_deposit", "exchange_to_crypto_transfer"})
WITHDRAWAL_KINDS = frozenset({"crypto_withdrawal", "crypto_to_exchange_transfer"})
SPEND_KINDS = frozenset({"crypto_payment", "card_top_up"})
CARD_REVIEW_KINDS = frozenset({
    "referral_card_cashback",
    "transfer_cashback",
    "card_cashback_reverted",
    "reimbursement",
    "reimbursement_reverted",
    "gift_card_reward",
})
INTERNAL_REVIEW_KINDS = frozenset({
    "crypto_earn_program_created",
    "crypto_earn_program_withdrawn",
    "lockup_lock",
    "lockup_unlock",
    "lockup_upgrade",
    "lockup_swap_credited",
    "lockup_swap_debited",
    "interest_swap_credited",
    "interest_swap_debited",
    "supercharger_deposit",
    "supercharger_withdrawal",
    "council_node_deposit_created",
    "trading.limit_order.fiat_wallet.purchase_lock",
    "trading.limit_order.fiat_wallet.purchase_unlock",
    "trading.limit_order.fiat_wallet.sell_lock",
    "trading.limit_order.fiat_wallet.sell_unlock",
    "trading.limit_order.cash_account.purchase_lock",
    "trading.limit_order.cash_account.purchase_unlock",
    "trading.limit_order.cash_account.sell_unlock",
    "trading.limit_order.cash_account.sell_lock",
    "trading.limit_order.crypto_wallet.fund_lock",
    "trading.limit_order.crypto_wallet.fund_unlock",
    "finance.lockup.dpos_lock.crypto_wallet",
    "finance.dpos.staking.crypto_wallet",
    "finance.dpos.unstaking.crypto_wallet",
    "viban_deposit_precredit",
    "viban_deposit_precredit_repayment",
})
PAIRED_SWAP_STEMS = frozenset({
    "crypto_wallet_swap",
    "dynamic_coin_swap",
    "dust_conversion",
})


@dataclass(frozen=True)
class CryptoComAppParseResult:
    records: tuple[SourceRecordEnvelope, ...]
    rows: tuple[dict[str, Any], ...]
    rejected_rows: tuple[dict[str, Any], ...]


def is_crypto_com_app_provider(provider: str) -> bool:
    token = "".join(character for character in provider.casefold() if character.isalnum())
    return token in {"cryptocom", "cryptocomapp"}


def _parse_timestamp(raw: str) -> datetime:
    value = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        parsed = None
    if parsed is None:
        for pattern in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
            try:
                parsed = datetime.strptime(value, pattern)
                break
            except ValueError:
                continue
    if parsed is None:
        raise ValueError(f"Timestamp (UTC) is not supported: {raw!r}")
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _decimal(raw: str | None, *, field: str, required: bool = False) -> Decimal | None:
    value = (raw or "").strip()
    if not value:
        if required:
            raise ValueError(f"{field} is required")
        return None
    try:
        result = Decimal(value.replace(",", ""))
    except InvalidOperation as exc:
        raise ValueError(f"{field} must be a dot-decimal number") from exc
    if not result.is_finite():
        raise ValueError(f"{field} must be finite")
    return result


def _code(raw: str | None, *, field: str, required: bool = False) -> str | None:
    value = (raw or "").strip().upper()
    if required and not value:
        raise ValueError(f"{field} is required")
    return value or None


def _aud_value(row: Mapping[str, str]) -> Decimal | None:
    if _code(row.get("Native Currency"), field="Native Currency") != "AUD":
        return None
    value = _decimal(row.get("Native Amount"), field="Native Amount")
    return abs(value) if value is not None else None


def _valuation_fields(row: Mapping[str, str], occurred_at: datetime) -> dict[str, Any]:
    value = _aud_value(row)
    if value is None:
        return {}
    return {
        "aud_value": value,
        "valuation_source": "crypto.com_app_native_amount",
        "valuation_timestamp": occurred_at,
    }


def _warnings_for_native(row: Mapping[str, str]) -> tuple[str, ...]:
    native = _code(row.get("Native Currency"), field="Native Currency")
    if native and native != "AUD":
        return (f"Provider value is in {native}; an AUD event-time value is still required for complete tax reporting.",)
    return ()


def _metadata(row: Mapping[str, str], kind: str) -> dict[str, Any]:
    result: dict[str, Any] = {
        "description": row.get("Transaction Description") or None,
        "crypto_com_transaction_kind": kind,
        "transaction_hash": row.get("Transaction Hash") or None,
        "native_currency": row.get("Native Currency") or None,
        "native_amount": row.get("Native Amount") or None,
        "native_amount_usd": row.get("Native Amount (in USD)") or None,
    }
    return {key: value for key, value in result.items() if value is not None}


def _provider_record_id(row: Mapping[str, str], kind: str) -> str | None:
    tx_hash = (row.get("Transaction Hash") or "").strip()
    if not tx_hash:
        return None
    parts = (
        tx_hash, kind, row.get("Currency", ""), row.get("Amount", ""),
        row.get("To Currency", ""), row.get("To Amount", ""),
    )
    digest = hashlib.sha256(
        json.dumps(parts, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"tx:{digest}"


def _price_terms(
    row: Mapping[str, str],
    *,
    quantity: Decimal,
    occurred_at: datetime,
) -> dict[str, Any]:
    valuation = _valuation_fields(row, occurred_at)
    if valuation:
        return {**valuation, "price": valuation["aud_value"] / quantity, "currency": "AUD"}
    native_value = _decimal(row.get("Native Amount"), field="Native Amount")
    native_currency = _code(row.get("Native Currency"), field="Native Currency")
    if native_value is None or native_currency is None:
        raise ValueError("A buy or disposal requires Native Currency and Native Amount")
    return {"price": abs(native_value) / quantity, "currency": native_currency}


def _trade_activity(row: Mapping[str, str], kind: str, occurred_at: datetime) -> CanonicalActivityInput:
    source = _code(row.get("Currency"), field="Currency", required=True)
    destination = _code(row.get("To Currency"), field="To Currency", required=True)
    source_amount = abs(_decimal(row.get("Amount"), field="Amount", required=True) or Decimal(0))
    destination_amount = abs(_decimal(row.get("To Amount"), field="To Amount", required=True) or Decimal(0))
    if source_amount <= 0 or destination_amount <= 0:
        raise ValueError("Trade Amount and To Amount must both be non-zero")
    metadata = _metadata(row, kind)
    warnings = _warnings_for_native(row)
    group = row.get("Transaction Hash") or None
    source_is_fiat = source in FIAT_CODES
    destination_is_fiat = destination in FIAT_CODES
    if source_is_fiat and not destination_is_fiat:
        terms = _price_terms(row, quantity=destination_amount, occurred_at=occurred_at)
        return CanonicalActivityInput(
            activity_type="buy", occurred_at=occurred_at, asset_symbol=destination,
            asset_type="crypto", quantity=destination_amount, external_group_id=group,
            warnings=warnings, metadata=metadata, **terms,
        )
    if not source_is_fiat and destination_is_fiat:
        aud_value = destination_amount if destination == "AUD" else _aud_value(row)
        price = destination_amount / source_amount
        terms: dict[str, Any] = {"price": price, "currency": destination}
        if aud_value is not None:
            terms.update(
                aud_value=aud_value,
                valuation_source="crypto.com_app_trade_amount" if destination == "AUD" else "crypto.com_app_native_amount",
                valuation_timestamp=occurred_at,
            )
        return CanonicalActivityInput(
            activity_type="sell", occurred_at=occurred_at, asset_symbol=source,
            asset_type="crypto", quantity=source_amount, external_group_id=group,
            warnings=warnings, metadata=metadata, **terms,
        )
    if not source_is_fiat and not destination_is_fiat:
        return CanonicalActivityInput(
            activity_type="crypto_swap", occurred_at=occurred_at, asset_symbol=source,
            asset_type="crypto", quantity=source_amount, counter_asset_symbol=destination,
            counter_quantity=destination_amount, external_group_id=group,
            warnings=warnings, metadata=metadata, **_valuation_fields(row, occurred_at),
        )
    raise ValueError("Fiat-to-fiat cash movement is outside the investment preset; review it in the cash account")


def _simple_trade_activity(row: Mapping[str, str], kind: str, occurred_at: datetime) -> CanonicalActivityInput:
    symbol = _code(row.get("Currency"), field="Currency", required=True)
    amount = _decimal(row.get("Amount"), field="Amount", required=True) or Decimal(0)
    if symbol in FIAT_CODES:
        raise ValueError("Fiat-only cash movement is outside the investment preset")
    if amount == 0:
        raise ValueError("Amount must be non-zero")
    quantity = abs(amount)
    return CanonicalActivityInput(
        activity_type="buy" if amount > 0 else "sell",
        occurred_at=occurred_at,
        asset_symbol=symbol,
        asset_type="crypto",
        quantity=quantity,
        external_group_id=row.get("Transaction Hash") or None,
        warnings=_warnings_for_native(row),
        metadata=_metadata(row, kind),
        **_price_terms(row, quantity=quantity, occurred_at=occurred_at),
    )


def _single_activity(row: Mapping[str, str]) -> tuple[datetime, CanonicalActivityInput]:
    occurred_at = _parse_timestamp(row.get("Timestamp (UTC)", ""))
    kind = (row.get("Transaction Kind") or "").strip().lower()
    if not kind:
        symbol = _code(row.get("Currency"), field="Currency", required=True)
        amount = _decimal(row.get("Amount"), field="Amount", required=True) or Decimal(0)
        description = (row.get("Transaction Description") or "").strip().lower()
        if symbol not in FIAT_CODES or amount == 0:
            raise ValueError("Blank Transaction Kind is not an identifiable fiat funding movement; review before import")
        if "deposit" in description:
            activity_type = "deposit"
        elif "withdraw" in description:
            activity_type = "withdrawal"
        else:
            raise ValueError("Blank Transaction Kind may be card or cash spending; review outside this investment preset")
        return occurred_at, CanonicalActivityInput(
            activity_type=activity_type,
            occurred_at=occurred_at,
            asset_symbol=symbol,
            asset_type="cash",
            quantity=abs(amount),
            direction="in" if activity_type == "deposit" else "out",
            warnings=("Cash Account funding is retained as audit activity and does not alter crypto holdings or CGT.",),
            metadata=_metadata(row, "cash_wallet_funding"),
        )
    if kind in TRADE_KINDS:
        return occurred_at, _trade_activity(row, kind, occurred_at)
    if kind in SIMPLE_TRADE_KINDS:
        return occurred_at, _simple_trade_activity(row, kind, occurred_at)

    symbol = _code(row.get("Currency"), field="Currency", required=True)
    amount = _decimal(row.get("Amount"), field="Amount", required=True) or Decimal(0)
    quantity = abs(amount)
    if quantity <= 0:
        raise ValueError("Amount must be non-zero")
    common = {
        "occurred_at": occurred_at,
        "asset_symbol": symbol,
        "asset_type": "crypto",
        "quantity": quantity,
        "external_group_id": row.get("Transaction Hash") or None,
        "metadata": _metadata(row, kind),
    }
    if kind in INTEREST_KINDS:
        return occurred_at, CanonicalActivityInput(
            activity_type="interest", warnings=_warnings_for_native(row),
            **common, **_valuation_fields(row, occurred_at),
        )
    if kind in STAKING_REWARD_KINDS:
        return occurred_at, CanonicalActivityInput(
            activity_type="staking_reward", warnings=_warnings_for_native(row),
            **common, **_valuation_fields(row, occurred_at),
        )
    if kind in REWARD_KINDS or "airdrop" in kind:
        return occurred_at, CanonicalActivityInput(
            activity_type="airdrop",
            assumptions=("Provider reward is treated as ordinary income on receipt; review if its legal character differs.",),
            warnings=_warnings_for_native(row), **common, **_valuation_fields(row, occurred_at),
        )
    if kind in DEPOSIT_KINDS or (kind == "crypto_transfer" and amount > 0):
        return occurred_at, CanonicalActivityInput(
            activity_type="deposit",
            warnings=("Transfer quantity is treated as net because this export has no separate network-fee column.",),
            **common,
        )
    if kind in WITHDRAWAL_KINDS or (kind == "crypto_transfer" and amount < 0):
        return occurred_at, CanonicalActivityInput(
            activity_type="withdrawal",
            warnings=("Transfer quantity is treated as net because this export has no separate network-fee column.",),
            **common,
        )
    if kind in SPEND_KINDS:
        return occurred_at, CanonicalActivityInput(
            activity_type="sell", warnings=_warnings_for_native(row),
            **common, **_price_terms(row, quantity=quantity, occurred_at=occurred_at),
        )
    if kind in CARD_REVIEW_KINDS or "cashback" in kind:
        raise ValueError("Card cashback/reimbursement tax treatment is ambiguous; classify this row manually before import")
    if kind in INTERNAL_REVIEW_KINDS:
        raise ValueError("Internal lock, stake, or cash movement is excluded pending review because beneficial ownership may be unchanged")
    if "fee" in kind and amount < 0:
        aud_value = _aud_value(row)
        fee_fields: dict[str, Any] = {}
        if aud_value is not None:
            fee_fields = {
                "fee_aud_value": aud_value,
                "fee_valuation_source": "crypto.com_app_native_amount",
                "fee_valuation_timestamp": occurred_at,
            }
        return occurred_at, CanonicalActivityInput(
            activity_type="fee", fee_amount=quantity, fee_currency=symbol,
            warnings=_warnings_for_native(row), **common, **fee_fields,
        )
    raise ValueError(f"Unsupported Crypto.com App Transaction Kind {kind!r}; review before import")


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


def _pair_stem(kind: str) -> str | None:
    for suffix in ("_debited", "_credited"):
        if kind.endswith(suffix):
            stem = kind.removesuffix(suffix)
            return stem if stem in PAIRED_SWAP_STEMS else None
    return None


def _paired_swap(
    debit: tuple[int, Mapping[str, str]],
    credit: tuple[int, Mapping[str, str]],
) -> tuple[SourceRecordEnvelope, dict[str, Any]]:
    debit_number, debit_row = debit
    credit_number, credit_row = credit
    occurred_at = _parse_timestamp(debit_row.get("Timestamp (UTC)", ""))
    sold = _code(debit_row.get("Currency"), field="Currency", required=True)
    bought = _code(credit_row.get("Currency"), field="Currency", required=True)
    sold_quantity = abs(_decimal(debit_row.get("Amount"), field="Amount", required=True) or Decimal(0))
    bought_quantity = abs(_decimal(credit_row.get("Amount"), field="Amount", required=True) or Decimal(0))
    if sold == bought or sold_quantity <= 0 or bought_quantity <= 0:
        raise ValueError("Paired conversion requires different assets with non-zero debit and credit amounts")
    canonical_payload = {
        "debit": dict(debit_row),
        "credit": dict(credit_row),
    }
    digest = hashlib.sha256(
        json.dumps(canonical_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    raw = {
        **{f"Debit {key}": value for key, value in debit_row.items()},
        **{f"Credit {key}": value for key, value in credit_row.items()},
    }
    activity = CanonicalActivityInput(
        activity_type="crypto_swap",
        occurred_at=occurred_at,
        asset_symbol=sold,
        asset_type="crypto",
        quantity=sold_quantity,
        counter_asset_symbol=bought,
        counter_quantity=bought_quantity,
        external_group_id=f"crypto.com-app-swap:{digest}",
        assumptions=("Debit and credit rows with the same timestamp, description, and conversion kind were paired as one swap.",),
        warnings=_warnings_for_native(debit_row),
        metadata={
            "description": debit_row.get("Transaction Description") or None,
            "crypto_com_transaction_kind": _pair_stem((debit_row.get("Transaction Kind") or "").lower()),
            "source_row_numbers": [debit_number, credit_number],
        },
        **_valuation_fields(debit_row, occurred_at),
    )
    validated = validate_batch(
        InvestmentActivityBatch(
            provider=PROVIDER,
            ingestion_type="csv_import",
            records=(SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=f"paired-swap:{digest}",
                raw_payload=raw,
                activities=(activity,),
                metadata={"source_row_numbers": [debit_number, credit_number]},
            ),),
        ),
        account_id="00000000-0000-0000-0000-000000000000",
    ).records[0]
    return validated, {
        "row_number": min(debit_number, credit_number),
        "status": "ready",
        "normalized": _serialize(validated.activities[0]),
        "warnings": list(validated.activities[0].warnings),
        "raw": raw,
    }


def normalize_crypto_com_app_rows(
    *,
    headers: Sequence[str],
    source_rows: Sequence[Sequence[str]],
    file_name: str,
) -> CryptoComAppParseResult:
    header_set = set(headers)
    missing = sorted(REQUIRED_HEADERS - header_set)
    if missing:
        raise ValueError("Crypto.com App preset is missing required columns: " + ", ".join(missing))

    indexed: list[tuple[int, dict[str, str]]] = []
    for source_index, values in enumerate(source_rows):
        indexed.append((
            source_index + 2,
            {header: values[index].strip() if index < len(values) else "" for index, header in enumerate(headers)},
        ))

    paired_groups: dict[tuple[str, str, str], list[tuple[int, Mapping[str, str]]]] = {}
    singles: list[tuple[int, Mapping[str, str]]] = []
    for row_number, row in indexed:
        kind = (row.get("Transaction Kind") or "").strip().lower()
        stem = _pair_stem(kind)
        if stem:
            key = (row.get("Timestamp (UTC)", ""), row.get("Transaction Description", ""), stem)
            paired_groups.setdefault(key, []).append((row_number, row))
        else:
            singles.append((row_number, row))

    records: list[SourceRecordEnvelope] = []
    preview_rows: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    for _key, candidates in sorted(paired_groups.items()):
        debits = [item for item in candidates if (item[1].get("Transaction Kind") or "").lower().endswith("_debited")]
        credits = [item for item in candidates if (item[1].get("Transaction Kind") or "").lower().endswith("_credited")]
        if len(debits) == 1 and len(credits) == 1:
            try:
                record, preview = _paired_swap(debits[0], credits[0])
                records.append(record)
                preview_rows.append(preview)
            except (ValueError, ActivityValidationError) as exc:
                reason = str(exc) if not isinstance(exc, ActivityValidationError) else "; ".join(
                    item["reason"] for item in exc.errors
                )
                rejected.append({
                    "row_number": min(item[0] for item in candidates),
                    "reasons": [reason],
                    "raw": {
                        f"Row {item[0]} {header}": value
                        for item in candidates
                        for header, value in item[1].items()
                    },
                })
        else:
            rejected.append({
                "row_number": min(item[0] for item in candidates),
                "reasons": ["Conversion debit/credit rows could not be paired uniquely; review before import"],
                "raw": {
                    f"Row {item[0]} {header}": value
                    for item in candidates
                    for header, value in item[1].items()
                },
            })

    for row_number, row in singles:
        try:
            occurred_at, activity = _single_activity(row)
            kind = (row.get("Transaction Kind") or "").strip().lower()
            record = SourceRecordEnvelope(
                occurred_at=occurred_at,
                provider_record_id=_provider_record_id(row, kind),
                raw_payload=row,
                activities=(activity,),
                metadata={"source_row_number": row_number, "file_name": file_name},
            )
            record = validate_batch(
                InvestmentActivityBatch(provider=PROVIDER, ingestion_type="csv_import", records=(record,)),
                account_id="00000000-0000-0000-0000-000000000000",
            ).records[0]
            records.append(record)
            preview_rows.append({
                "row_number": row_number,
                "status": "ready",
                "normalized": _serialize(record.activities[0]),
                "warnings": list(record.activities[0].warnings),
                "raw": dict(row),
            })
        except ActivityValidationError as exc:
            rejected.append({
                "row_number": row_number,
                "reasons": [item["reason"] for item in exc.errors],
                "raw": dict(row),
            })
        except (ValueError, TypeError) as exc:
            rejected.append({"row_number": row_number, "reasons": [str(exc)], "raw": dict(row)})

    ordered = sorted(zip(records, preview_rows, strict=True), key=lambda item: item[1]["row_number"])
    return CryptoComAppParseResult(
        records=tuple(item[0] for item in ordered),
        rows=tuple(item[1] for item in ordered),
        rejected_rows=tuple(sorted(rejected, key=lambda item: item["row_number"])),
    )
