"""
Ownership resolution and share-weighted attribution.

Public API:
- resolve_shares(owners) -> dict[person_id -> share]
- attribute_amount(amount, owners, person_id_or_none) -> float
- entity_ids_for_people(db, entity, person_ids) -> list[UUID]
- get_owners(db, entity, entity_id) -> list[dict]
"""
from __future__ import annotations

from datetime import date
from typing import Iterable, Literal
from uuid import UUID

from sqlalchemy import func, inspect
from sqlalchemy.orm import Session

from app.models import (
    Account,
    AccountOwner,
    AccountOwnershipAllocation,
    Property,
    PropertyOwner,
    Person,
    Vehicle,
    VehicleOwner,
)

EntityType = Literal["account", "property", "vehicle"]

_ASSOC = {
    "account": (AccountOwner, "account_id"),
    "property": (PropertyOwner, "property_id"),
    "vehicle": (VehicleOwner, "vehicle_id"),
}


def _allocation_table_is_available(db: Session) -> bool:
    """Allow a rolling deploy to keep legacy reporting alive before migration.

    Normal deployments run Drizzle migrations before the API starts.  The
    check also keeps older isolated test databases usable while retaining the
    explicit fallback below; it can be removed once all supported databases
    have passed the SYL-42 migration.
    """
    return inspect(db.bind).has_table("account_ownership_allocations")


def resolve_shares(owners: list[dict]) -> dict[str, float]:
    if not owners:
        return {}
    none_count = sum(1 for o in owners if o.get("share") is None)
    if none_count == len(owners):
        equal = 1.0 / len(owners)
        return {str(o["person_id"]): equal for o in owners}
    if none_count > 0:
        raise ValueError(
            "ownership shares must be all NULL (equal split) or all explicit; "
            f"got {none_count} NULL of {len(owners)}"
        )
    return {str(o["person_id"]): float(o["share"]) for o in owners}


def attribute_amount(amount: float, owners: list[dict], person_id: str | None) -> float:
    if person_id is None:
        return amount
    return amount * resolve_shares(owners).get(str(person_id), 0.0)


def get_owners(
    db: Session,
    entity: EntityType,
    entity_id: UUID | str,
    as_of: date | None = None,
) -> list[dict]:
    """Return owners, resolving account allocations at a reporting date.

    Account allocations became effective-dated in SYL-42.  The legacy
    ``account_owners`` rows remain a fallback for databases/accounts that have
    not yet been backfilled, so legacy reporting data is not silently hidden.
    Property and vehicle ownership remains timeless.
    """
    if entity == "account" and _allocation_table_is_available(db):
        as_of = as_of or date.today()
        effective_from = (
            db.query(AccountOwnershipAllocation.effective_from)
            .filter(
                AccountOwnershipAllocation.account_id == entity_id,
                AccountOwnershipAllocation.effective_from <= as_of,
            )
            .order_by(AccountOwnershipAllocation.effective_from.desc())
            .limit(1)
            .scalar()
        )
        if effective_from is not None:
            rows = (
                db.query(AccountOwnershipAllocation)
                .filter(
                    AccountOwnershipAllocation.account_id == entity_id,
                    AccountOwnershipAllocation.effective_from == effective_from,
                )
                .all()
            )
            return [{"person_id": str(r.person_id), "share": float(r.share)} for r in rows]

        # If an account has dated allocations but none apply yet, do not
        # resurrect the legacy timeless owners.  A future-dated complete set
        # intentionally means the account has no allocation before that date.
        has_allocation_history = (
            db.query(AccountOwnershipAllocation.id)
            .filter(AccountOwnershipAllocation.account_id == entity_id)
            .first()
            is not None
        )
        if has_allocation_history:
            return []

    Assoc, fk = _ASSOC[entity]
    rows = db.query(Assoc).filter(getattr(Assoc, fk) == entity_id).all()
    owners = [
        {"person_id": str(r.person_id), "share": float(r.share) if r.share is not None else None}
        for r in rows
    ]
    if entity == "account" and not owners:
        # Accounts created by a non-UI importer may predate their allocation
        # row. Treat the household's authenticated user as the safe default
        # until the account is explicitly split; this keeps personal reports
        # complete without inventing ownership for placeholders.
        account = db.query(Account).filter(Account.id == entity_id).first()
        if account is not None:
            self_person = (
                db.query(Person)
                .filter(Person.user_id == account.user_id, Person.kind == "self")
                .first()
            )
            if self_person is not None:
                return [{"person_id": str(self_person.id), "share": 1.0}]
    return owners


def entity_ids_for_people(
    db: Session,
    entity: EntityType,
    person_ids: Iterable[UUID | str],
    as_of: date | None = None,
) -> list[UUID]:
    pids = list(person_ids)
    if not pids:
        return []
    if entity == "account" and _allocation_table_is_available(db):
        as_of = as_of or date.today()
        # Resolve the latest effective date per account first, then join back
        # to the complete set. This avoids relying on a correlated subquery
        # whose outer query does not otherwise include the accounts table.
        latest_for_account = (
            db.query(
                AccountOwnershipAllocation.account_id.label("account_id"),
                func.max(AccountOwnershipAllocation.effective_from).label("effective_from"),
            )
            .filter(AccountOwnershipAllocation.effective_from <= as_of)
            .group_by(AccountOwnershipAllocation.account_id)
            .subquery()
        )
        rows = (
            db.query(AccountOwnershipAllocation.account_id)
            .filter(
                AccountOwnershipAllocation.person_id.in_(pids),
            )
            .join(
                latest_for_account,
                (AccountOwnershipAllocation.account_id == latest_for_account.c.account_id)
                & (AccountOwnershipAllocation.effective_from == latest_for_account.c.effective_from),
            )
            .distinct()
            .all()
        )
        # During/after backfill, only use legacy ownership for accounts with
        # no allocation history at all.  In particular, do *not* resurrect a
        # person removed by a newer complete allocation set.
        legacy_has_allocation = (
            db.query(AccountOwnershipAllocation.id)
            .filter(AccountOwnershipAllocation.account_id == AccountOwner.account_id)
            .exists()
        )
        legacy_rows = (
            db.query(AccountOwner.account_id)
            .filter(
                AccountOwner.person_id.in_(pids),
                ~legacy_has_allocation,
            )
            .distinct()
            .all()
        )
        unallocated_self_rows = (
            db.query(Account.id)
            .join(Person, Person.user_id == Account.user_id)
            .filter(
                Person.id.in_(pids),
                Person.kind == "self",
                ~db.query(AccountOwnershipAllocation.id)
                .filter(AccountOwnershipAllocation.account_id == Account.id)
                .exists(),
            )
            .distinct()
            .all()
        )
        return list(dict.fromkeys(
            [r[0] for r in rows]
            + [r[0] for r in legacy_rows]
            + [r[0] for r in unallocated_self_rows]
        ))
    Assoc, fk = _ASSOC[entity]
    rows = db.query(getattr(Assoc, fk)).filter(Assoc.person_id.in_(pids)).distinct().all()
    return [r[0] for r in rows]
