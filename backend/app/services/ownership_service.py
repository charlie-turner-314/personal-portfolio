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

from sqlalchemy import func, inspect, or_, and_, select
from sqlalchemy.orm import Session

from app.models import (
    Account,
    AccountOwner,
    AccountOwnershipAllocation,
    PropertyOwnershipAllocation,
    VehicleOwnershipAllocation,
    Property,
    PropertyOwner,
    Person,
    HouseholdMembership,
    Vehicle,
    VehicleOwner,
)

EntityType = Literal["account", "property", "vehicle"]

_ASSOC = {
    "account": (AccountOwner, "account_id"),
    "property": (PropertyOwner, "property_id"),
    "vehicle": (VehicleOwner, "vehicle_id"),
}


def _allocation_table_is_available(db: Session, entity: EntityType = "account") -> bool:
    """Allow a rolling deploy to keep legacy reporting alive before migration.

    Normal deployments run Drizzle migrations before the API starts.  The
    check also keeps older isolated test databases usable while retaining the
    explicit fallback below; it can be removed once all supported databases
    have passed the SYL-42 migration.
    """
    return inspect(db.bind).has_table(f"{entity}_ownership_allocations")


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


def identity_person_ids(db: Session, person_ids: Iterable[UUID | str]) -> list[UUID]:
    """Economic aliases survive membership removal; never use as authorization."""
    ids = {UUID(str(value)) for value in person_ids}
    if not ids:
        return []
    selected = db.query(Person).filter(Person.id.in_(ids)).all()
    logins = {person.user_id if person.kind == "self" else person.linked_user_id for person in selected}
    logins.discard(None)
    logins.update(row[0] for row in db.query(HouseholdMembership.member_user_id)
                  .filter(HouseholdMembership.person_id.in_(ids)).all())
    if logins:
        ids.update(row[0] for row in db.query(Person.id).filter(or_(
            Person.linked_user_id.in_(logins), and_(Person.kind == "self", Person.user_id.in_(logins)))).all())
    return list(ids)


def attribute_amount(amount: float, owners: list[dict], person_id: str | None, *, db: Session | None = None) -> float:
    if person_id is None:
        return amount
    identities = {str(value) for value in identity_person_ids(db, [person_id])} if db is not None else {str(person_id)}
    shares = resolve_shares(owners)
    return amount * sum(share for owner_id, share in shares.items() if owner_id in identities)


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
    Properties and vehicles resolve the same dated complete-set rule.
    """
    Allocation = {"account": AccountOwnershipAllocation, "property": PropertyOwnershipAllocation, "vehicle": VehicleOwnershipAllocation}[entity]
    allocation_fk = getattr(Allocation, f"{entity}_id")
    if _allocation_table_is_available(db, entity):
        as_of = as_of or date.today()
        effective_from = (
            db.query(Allocation.effective_from)
            .filter(
                allocation_fk == entity_id,
                Allocation.effective_from <= as_of,
            )
            .order_by(Allocation.effective_from.desc())
            .limit(1)
            .scalar()
        )
        if effective_from is not None:
            rows = (
                db.query(Allocation)
                .filter(
                    allocation_fk == entity_id,
                    Allocation.effective_from == effective_from,
                )
                .all()
            )
            return [{"person_id": str(r.person_id), "share": float(r.share)} for r in rows]

        # If an account has dated allocations but none apply yet, do not
        # resurrect the legacy timeless owners.  A future-dated complete set
        # intentionally means the account has no allocation before that date.
        has_allocation_history = (
            db.query(Allocation.id)
            .filter(allocation_fk == entity_id)
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
    if not owners:
        # Accounts created by a non-UI importer may predate their allocation
        # row. Treat the household's authenticated user as the safe default
        # until the account is explicitly split; this keeps personal reports
        # complete without inventing ownership for placeholders.
        Resource = {"account": Account, "property": Property, "vehicle": Vehicle}[entity]
        account = db.query(Resource).filter(Resource.id == entity_id).first()
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
    pids = identity_person_ids(db, person_ids)
    if not pids:
        return []
    Assoc, fk = _ASSOC[entity]
    Resource = {"account": Account, "property": Property, "vehicle": Vehicle}[entity]
    Allocation = {"account": AccountOwnershipAllocation, "property": PropertyOwnershipAllocation, "vehicle": VehicleOwnershipAllocation}[entity]
    association_fk = getattr(Assoc, fk)
    allocation_fk = getattr(Allocation, fk)
    available = _allocation_table_is_available(db, entity)
    result = []
    if available:
        latest = db.query(allocation_fk.label("entity_id"), func.max(Allocation.effective_from).label("effective_from"))\
            .filter(Allocation.effective_from <= (as_of or date.today())).group_by(allocation_fk).subquery()
        result.extend(row[0] for row in db.query(allocation_fk).join(latest,
            and_(allocation_fk == latest.c.entity_id, Allocation.effective_from == latest.c.effective_from))
            .filter(Allocation.person_id.in_(pids), Allocation.share > 0).distinct().all())
    legacy = db.query(association_fk).filter(Assoc.person_id.in_(pids))
    if available:
        legacy = legacy.filter(~db.query(Allocation.id).filter(allocation_fk == association_fk).exists())
    result.extend(row[0] for row in legacy.distinct().all())
    logins = select(Person.user_id).where(Person.id.in_(pids), Person.kind == "self").union(
        select(Person.linked_user_id).where(Person.id.in_(pids), Person.linked_user_id.isnot(None)))
    defaults = db.query(Resource.id).filter(Resource.user_id.in_(logins),
        ~db.query(association_fk).filter(association_fk == Resource.id).exists())
    if available:
        defaults = defaults.filter(~db.query(Allocation.id).filter(allocation_fk == Resource.id).exists())
    result.extend(row[0] for row in defaults.all())
    return list(dict.fromkeys(result))
