from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.services.investment_activity_service import (
    ACTIVITY_TYPES,
    ActivityValidationError,
    CanonicalActivityInput,
    InvestmentActivityAdapter,
    InvestmentActivityBatch,
    SourceRecordEnvelope,
    preview_batch,
    sanitize_source_payload,
    source_idempotency_key,
)


OCCURRED_AT = datetime(2025, 7, 3, 4, 5, tzinfo=timezone.utc)
ACCOUNT_ID = "00000000-0000-0000-0000-000000000001"


def _activity(activity_type: str, leg_index: int) -> CanonicalActivityInput:
    common = dict(
        activity_type=activity_type,
        occurred_at=OCCURRED_AT,
        asset_symbol="btc" if activity_type in {"crypto_swap", "staking_reward", "airdrop"} else "vas",
        asset_type="crypto" if activity_type in {"crypto_swap", "staking_reward", "airdrop"} else "equity",
        leg_index=leg_index,
    )
    if activity_type in {"buy", "sell", "drp"}:
        return CanonicalActivityInput(**common, quantity="2", price="50", currency="aud")
    if activity_type in {"dividend", "distribution", "interest"}:
        return CanonicalActivityInput(**common, gross_amount="10", net_amount="9", currency="aud")
    if activity_type in {"deposit", "withdrawal", "staking_reward", "airdrop"}:
        return CanonicalActivityInput(**common, quantity="2")
    if activity_type == "transfer":
        return CanonicalActivityInput(**common, quantity="2", direction="out")
    if activity_type == "fee":
        return CanonicalActivityInput(**common, fee_amount="0.1", fee_currency="btc")
    if activity_type == "crypto_swap":
        return CanonicalActivityInput(
            **common,
            quantity="0.5",
            counter_asset_symbol="eth",
            counter_quantity="8",
        )
    raise AssertionError(activity_type)


def test_contract_accepts_every_canonical_activity_type():
    activities = tuple(_activity(kind, index) for index, kind in enumerate(sorted(ACTIVITY_TYPES)))
    batch = InvestmentActivityBatch(
        provider="contract_test",
        ingestion_type="manual",
        records=(
            SourceRecordEnvelope(
                occurred_at=OCCURRED_AT,
                provider_record_id="all-types",
                raw_payload={"row": 1},
                activities=activities,
            ),
        ),
    )

    preview = preview_batch(batch, account_id=ACCOUNT_ID)

    assert preview.record_count == 1
    assert preview.activity_count == len(ACTIVITY_TYPES)
    assert len(preview.source_keys) == 1


def test_source_key_is_deterministic_and_scoped_to_provider_and_account():
    record = SourceRecordEnvelope(
        occurred_at=OCCURRED_AT,
        provider_record_id="trade-123",
        raw_payload={"amount": Decimal("1.00")},
        activities=(_activity("buy", 0),),
    )
    first = source_idempotency_key(provider="Example", account_id=ACCOUNT_ID, record=record)
    second = source_idempotency_key(provider="example", account_id=ACCOUNT_ID, record=record)
    other_account = source_idempotency_key(
        provider="example",
        account_id="00000000-0000-0000-0000-000000000002",
        record=record,
    )

    assert first == second
    assert first != other_account
    assert len(first) == 64


def test_source_key_without_provider_id_uses_sanitized_payload_and_timestamp():
    left = SourceRecordEnvelope(
        occurred_at=OCCURRED_AT,
        raw_payload={"amount": "10", "api_token": "first-secret"},
        activities=(_activity("buy", 0),),
    )
    right = SourceRecordEnvelope(
        occurred_at=OCCURRED_AT,
        raw_payload={"api_token": "second-secret", "amount": "10"},
        activities=(_activity("buy", 0),),
    )

    assert source_idempotency_key(provider="example", account_id=ACCOUNT_ID, record=left) == source_idempotency_key(
        provider="example", account_id=ACCOUNT_ID, record=right
    )


def test_sanitization_redacts_nested_credentials_without_mutating_input():
    raw = {
        "trade": {"id": "abc", "apiKey": "secret-key"},
        "authorization": "Bearer private",
        "rows": [{"quantity": Decimal("1.25"), "password_hint": "also-secret"}],
    }

    sanitized = sanitize_source_payload(raw)

    assert sanitized == {
        "trade": {"id": "abc", "apiKey": "[REDACTED]"},
        "authorization": "[REDACTED]",
        "rows": [{"quantity": "1.25", "password_hint": "[REDACTED]"}],
    }
    assert raw["trade"]["apiKey"] == "secret-key"


@pytest.mark.parametrize(
    "activity,expected_field",
    [
        (_activity("buy", 0).__class__(activity_type="buy", occurred_at=OCCURRED_AT, asset_symbol="VAS", asset_type="equity"), "quantity"),
        (CanonicalActivityInput(activity_type="transfer", occurred_at=OCCURRED_AT, asset_symbol="BTC", asset_type="crypto", quantity="1"), "direction"),
        (CanonicalActivityInput(activity_type="crypto_swap", occurred_at=OCCURRED_AT, asset_symbol="BTC", asset_type="crypto", quantity="1"), "counter_quantity"),
        (CanonicalActivityInput(activity_type="airdrop", occurred_at=OCCURRED_AT, asset_symbol="ABC", asset_type="crypto", quantity="1", aud_value="2"), "valuation_source"),
    ],
)
def test_contract_rejects_ambiguous_or_incomplete_events(activity, expected_field):
    batch = InvestmentActivityBatch(
        provider="contract_test",
        ingestion_type="manual",
        records=(SourceRecordEnvelope(occurred_at=OCCURRED_AT, raw_payload={}, activities=(activity,)),),
    )

    with pytest.raises(ActivityValidationError) as exc_info:
        preview_batch(batch, account_id=ACCOUNT_ID)

    assert expected_field in {error["field"] for error in exc_info.value.errors}


def test_contract_rejects_duplicate_leg_indices():
    batch = InvestmentActivityBatch(
        provider="contract_test",
        ingestion_type="manual",
        records=(
            SourceRecordEnvelope(
                occurred_at=OCCURRED_AT,
                raw_payload={},
                activities=(_activity("buy", 0), _activity("sell", 0)),
            ),
        ),
    )

    with pytest.raises(ActivityValidationError, match="invalid investment activity batch") as exc_info:
        preview_batch(batch, account_id=ACCOUNT_ID)

    assert any(error["reason"] == "duplicate leg index 0 within source record" for error in exc_info.value.errors)


def test_adapter_protocol_is_runtime_checkable():
    class ExampleAdapter:
        provider = "example"
        normalization_version = "investment-activity-v1"

        def normalize(self, records):
            return InvestmentActivityBatch(provider=self.provider, ingestion_type="manual", records=())

    assert isinstance(ExampleAdapter(), InvestmentActivityAdapter)
