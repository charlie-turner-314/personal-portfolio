"""Dated economic attribution, applied only after account access is checked."""
from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException

from app.models import Account, AccountOwner, AccountOwnershipAllocation, HouseholdMembership, Person
from app.services.financial_access import account_access, household_root


class InvestmentScope:
    def __init__(self, db, actor_id: str, selection: str | None):
        self.whole = selection in (None, "", "all")
        self.accounts = {row.id: row for row in db.query(Account).filter(account_access(Account.id, actor_id)).all()}
        self.identities = set()
        self.identity_users = set()
        self.allocations = {}
        self.legacy = {}
        if self.whole:
            return
        people = db.query(Person).filter(household_root(Person.user_id) == household_root(actor_id)).all()
        memberships = db.query(HouseholdMembership).filter(HouseholdMembership.owner_user_id == household_root(actor_id)).all()
        if selection == "self":
            linked_users = {actor_id}
            selected = set()
        else:
            try:
                selected = {UUID(value) for value in selection.split(",")}
            except (ValueError, AttributeError):
                raise HTTPException(status_code=422, detail="Invalid investment person scope")
            permitted = {person.id for person in people}
            if not selected.issubset(permitted):
                raise HTTPException(status_code=403, detail="Person scope is not available")
            linked_users = {person.user_id for person in people if person.id in selected and person.kind == "self"}
            linked_users.update(person.linked_user_id for person in people if person.id in selected and person.linked_user_id)
            linked_users.update(member.member_user_id for member in memberships if member.person_id in selected)
        self.identity_users = linked_users
        self.identities = selected | {person.id for person in people if (person.kind == "self" and person.user_id in linked_users) or person.linked_user_id in linked_users}
        self.identities.update(member.person_id for member in memberships if member.member_user_id in linked_users)
        ids = list(self.accounts)
        for allocation in db.query(AccountOwnershipAllocation).filter(AccountOwnershipAllocation.account_id.in_(ids)).all():
            self.allocations.setdefault(allocation.account_id, {}).setdefault(allocation.effective_from, []).append(allocation)
        for owner in db.query(AccountOwner).filter(AccountOwner.account_id.in_(ids)).all():
            self.legacy.setdefault(owner.account_id, []).append(owner)

    def share(self, account_id, on: date) -> Decimal:
        if account_id not in self.accounts:
            return Decimal(0)
        if self.whole:
            return Decimal(1)
        history = self.allocations.get(account_id)
        if history:
            dates = [day for day in history if day <= on]
            if not dates:
                return Decimal(0)
            return sum((Decimal(row.share) for row in history[max(dates)] if row.person_id in self.identities), Decimal(0))
        owners = self.legacy.get(account_id)
        if owners:
            return sum((Decimal(row.share) if row.share is not None else Decimal(1) / len(owners) for row in owners if row.person_id in self.identities), Decimal(0))
        return Decimal(1) if self.accounts[account_id].user_id in self.identity_users else Decimal(0)
