"""Account-level access; household membership alone never exposes finances.

Connection credentials, account deletion and sharing management must continue
using actor ownership, not these collaborator predicates.
"""
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import aliased
from app.models import Account, Property, HouseholdPropertyShare, HouseholdAccountShare, HouseholdMembership, User
from datetime import date
from decimal import Decimal
from sqlalchemy.orm import Session
from fastapi import HTTPException


def household_root(user_id):
    membership = aliased(HouseholdMembership)
    owner = select(membership.owner_user_id).where(
        membership.member_user_id == user_id
    ).correlate_except(membership).scalar_subquery()
    return func.coalesce(owner, user_id)


def account_access(account_id_column, actor_user_id: str):
    account = aliased(Account)
    grant = aliased(HouseholdAccountShare)
    granted = exists(select(grant.account_id).where(and_(
        grant.account_id == account.id,
        grant.member_user_id == actor_user_id,
        grant.granted_by_user_id == account.user_id,
        account.is_active.is_(True),
        household_root(account.user_id) == household_root(actor_user_id),
    )))
    permitted = select(account.id).where(or_(account.user_id == actor_user_id, granted))
    return account_id_column.in_(permitted)


def property_access(property_id_column, actor_user_id: str):
    property_row = aliased(Property)
    grant = aliased(HouseholdPropertyShare)
    granted = exists(select(grant.property_id).where(and_(
        grant.property_id == property_row.id,
        grant.member_user_id == actor_user_id,
        grant.granted_by_user_id == property_row.user_id,
        property_row.is_active.is_(True),
        household_root(property_row.user_id) == household_root(actor_user_id),
    )))
    return property_id_column.in_(select(property_row.id).where(or_(property_row.user_id == actor_user_id, granted)))


def value_in_actor_currency(db: Session, value, owner_user_id: str, actor_user_id: str, on: date) -> Decimal:
    amount = Decimal(value)
    if owner_user_id == actor_user_id:
        return amount
    owner = db.query(User).filter(User.id == owner_user_id).one()
    actor = db.query(User).filter(User.id == actor_user_id).one()
    source = (owner.functional_currency or "EUR").upper()
    target = (actor.functional_currency or "EUR").upper()
    if source == target:
        return amount
    from app.services.exchange_rate_service import ExchangeRateService
    converted = ExchangeRateService(db=db).convert_amount(amount, source, target, on)
    if converted is None:
        raise HTTPException(status_code=503, detail="Currency conversion is unavailable for this shared account")
    return converted


