from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas import AccountOwnershipAllocationSetUpsert
from app.services.account_ownership_allocation_service import (
    AccountOwnershipAllocationError,
    validate_complete_allocation_set,
)


def test_allocation_payload_accepts_frontend_camel_case_and_serializes_it():
    first, second = uuid4(), uuid4()
    payload = AccountOwnershipAllocationSetUpsert.model_validate(
        {
            "effectiveFrom": "2026-08-01",
            "allocations": [
                {"personId": str(first), "share": "0.5"},
                {"personId": str(second), "share": "0.5"},
            ],
        }
    )

    assert payload.effective_from == date(2026, 8, 1)
    assert payload.model_dump(by_alias=True)["effectiveFrom"] == date(2026, 8, 1)
    assert payload.model_dump(by_alias=True)["allocations"][0]["personId"] == first


def test_allocation_payload_also_accepts_snake_case_requests():
    payload = AccountOwnershipAllocationSetUpsert.model_validate(
        {
            "effective_from": "2026-08-01",
            "allocations": [{"person_id": str(uuid4()), "share": "1"}],
        }
    )
    assert payload.effective_from == date(2026, 8, 1)


@pytest.mark.parametrize(
    "allocations, message",
    [
        ([], "at least one"),
        ([(uuid4(), Decimal("0.5")), (uuid4(), Decimal("0.4"))], "sum exactly"),
        ([(uuid4(), Decimal("0")), (uuid4(), Decimal("1"))], "greater than 0"),
    ],
)
def test_complete_allocation_set_rejects_invalid_sets(allocations, message):
    with pytest.raises(AccountOwnershipAllocationError, match=message):
        validate_complete_allocation_set(allocations)


def test_complete_allocation_set_rejects_duplicate_person():
    person_id = uuid4()
    with pytest.raises(AccountOwnershipAllocationError, match="only once"):
        validate_complete_allocation_set(
            [(person_id, Decimal("0.5")), (person_id, Decimal("0.5"))]
        )


def test_payload_rejects_a_non_complete_split():
    with pytest.raises(ValidationError, match="sum exactly"):
        AccountOwnershipAllocationSetUpsert.model_validate(
            {
                "effectiveFrom": "2026-08-01",
                "allocations": [{"personId": str(uuid4()), "share": "0.9"}],
            }
        )
