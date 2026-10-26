"""Account-level access; household membership alone never exposes finances.

Connection credentials, account deletion and sharing management must continue
using actor ownership, not these collaborator predicates.
"""
from sqlalchemy import and_, exists, func, or_, select, case
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
    permitted = select(account.id).where(account.consolidated_into_account_id.is_(None), or_(account.user_id == actor_user_id, granted))
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



def category_access(actor_user_id: str):
    """Definition access never grants access to activity or private guidance.

    Household definitions form one selectable vocabulary. Classifications on
    permitted accounts remain applicable when an account changes household.
    """
    from app.models import Category
    from sqlalchemy import column, table
    vocabulary = table("category_vocabulary_entries", column("owner_user_id"), column("category_id"))
    retained = exists(select(vocabulary.c.category_id).where(and_(
        vocabulary.c.category_id == Category.id,
        vocabulary.c.owner_user_id == household_root(actor_user_id),
    )))
    return or_(household_root(Category.user_id) == household_root(actor_user_id), retained)


def category_definition_for_actor(category, actor_user_id: str, selection_hidden=None):
    """Return a detached safe projection, never mutate the ORM source row."""
    from types import SimpleNamespace
    own = category.user_id == actor_user_id
    return SimpleNamespace(
        id=category.id, name=category.name, category_type=category.category_type,
        cash_flow_kind=getattr(category, "cash_flow_kind", None),
        color=category.color, icon=category.icon, is_system=bool(category.is_system),
        hide_from_selection=bool(getattr(category, "hide_from_selection", False)) if selection_hidden is None else bool(selection_hidden),
        parent_id=category.parent_id if own else None,
        description=category.description if own else None,
        categorization_instructions=category.categorization_instructions if own else None,
        created_at=category.created_at if own else None,
        user_id=actor_user_id if own else None,
    )


def category_selection_hidden(actor_user_id: str):
    from app.models import Category
    from sqlalchemy import column, table
    vocabulary = table("category_vocabulary_entries", column("owner_user_id"), column("category_id"), column("hidden_from_selection"))
    scoped = select(vocabulary.c.hidden_from_selection).where(
        vocabulary.c.category_id == Category.id,
        vocabulary.c.owner_user_id == household_root(actor_user_id)).correlate(Category).scalar_subquery()
    return func.coalesce(scoped, case((household_root(Category.user_id) == household_root(actor_user_id),
        func.coalesce(Category.hide_from_selection, False)), else_=False))


def category_definitions_for_actor(db, actor_user_id: str, *, selectable_only=False):
    from app.models import Category
    hidden = category_selection_hidden(actor_user_id)
    query = db.query(Category, hidden).filter(category_access(actor_user_id))
    if selectable_only:
        query = query.filter(hidden.isnot(True))
    return [category_definition_for_actor(category, actor_user_id, selection_hidden) for category, selection_hidden in query.order_by(Category.name, Category.id).all()]
