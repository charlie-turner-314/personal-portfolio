"""Effective-dated account ownership allocation operations.

An allocation is a complete snapshot for an account at ``effective_from``.
The snapshot with the latest date on or before a reporting date applies.  The
service owns the cross-row invariant that shares sum to one, which cannot be
expressed as a normal SQL check constraint.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import Account, AccountOwnershipAllocation, Person


class AccountOwnershipAllocationError(ValueError):
    pass


def validate_complete_allocation_set(allocations: list[tuple[UUID, Decimal]]) -> None:
    if not allocations:
        raise AccountOwnershipAllocationError("at least one allocation is required")
    person_ids = [person_id for person_id, _ in allocations]
    if len(person_ids) != len(set(person_ids)):
        raise AccountOwnershipAllocationError("each person may appear only once in an allocation set")
    if any(share <= 0 or share > 1 for _, share in allocations):
        raise AccountOwnershipAllocationError("each allocation share must be greater than 0 and no more than 1")
    if sum((share for _, share in allocations), Decimal("0")) != Decimal("1"):
        raise AccountOwnershipAllocationError("allocation shares must sum exactly to 1")


class AccountOwnershipAllocationService:
    def __init__(self, db: Session, user_id: str):
        self.db = db
        self.user_id = user_id

    def _account_or_raise(self, account_id: UUID, *, lock: bool = False) -> Account:
        query = self.db.query(Account).filter(
            Account.id == account_id, Account.user_id == self.user_id
        )
        # Serialise replacements for a single account.  PostgreSQL has no
        # declarative way to enforce that a group of rows sums to one, so the
        # parent-row lock keeps two valid replacement requests from interleaving.
        if lock:
            query = query.with_for_update()
        account = query.one_or_none()
        if account is None:
            raise AccountOwnershipAllocationError("account not found")
        return account

    def replace_set(
        self,
        account_id: UUID,
        effective_from: date,
        allocations: list[tuple[UUID, Decimal]],
    ) -> list[AccountOwnershipAllocation]:
        """Atomically replace the complete allocation set for one date."""
        self._account_or_raise(account_id, lock=True)
        validate_complete_allocation_set(allocations)

        person_ids = [person_id for person_id, _ in allocations]
        owned_count = (
            self.db.query(Person.id)
            .filter(Person.user_id == self.user_id, Person.id.in_(person_ids))
            .count()
        )
        if owned_count != len(person_ids):
            raise AccountOwnershipAllocationError("one or more people do not belong to this household")

        # Flush (not commit) so callers retain a single transaction boundary.
        # Deleting before inserting makes retrying the same effective date
        # idempotent and prevents stale members from remaining in the set.
        (
            self.db.query(AccountOwnershipAllocation)
            .filter(
                AccountOwnershipAllocation.account_id == account_id,
                AccountOwnershipAllocation.effective_from == effective_from,
            )
            .delete(synchronize_session=False)
        )
        rows = [
            AccountOwnershipAllocation(
                account_id=account_id,
                person_id=person_id,
                effective_from=effective_from,
                share=share,
            )
            for person_id, share in allocations
        ]
        self.db.add_all(rows)
        self.db.flush()
        return rows

    def effective_set(
        self, account_id: UUID, as_of: date | None = None
    ) -> list[AccountOwnershipAllocation]:
        """Return the allocation set in force on ``as_of`` (today by default)."""
        self._account_or_raise(account_id)
        as_of = as_of or date.today()
        effective_from = (
            self.db.query(AccountOwnershipAllocation.effective_from)
            .filter(
                AccountOwnershipAllocation.account_id == account_id,
                AccountOwnershipAllocation.effective_from <= as_of,
            )
            .order_by(AccountOwnershipAllocation.effective_from.desc())
            .limit(1)
            .scalar()
        )
        if effective_from is None:
            return []
        return (
            self.db.query(AccountOwnershipAllocation)
            .filter(
                AccountOwnershipAllocation.account_id == account_id,
                AccountOwnershipAllocation.effective_from == effective_from,
            )
            .order_by(AccountOwnershipAllocation.person_id)
            .all()
        )

    def history(self, account_id: UUID) -> list[AccountOwnershipAllocation]:
        self._account_or_raise(account_id)
        return (
            self.db.query(AccountOwnershipAllocation)
            .filter(AccountOwnershipAllocation.account_id == account_id)
            .order_by(
                AccountOwnershipAllocation.effective_from.desc(),
                AccountOwnershipAllocation.person_id,
            )
            .all()
        )
