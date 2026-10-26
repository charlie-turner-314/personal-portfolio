"""Category meanings and financial access are independent across real workflows."""
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
import pytest

from app.models import Account, Category, HouseholdAccountShare, HouseholdMembership, Person, Transaction, User
from app.services.category_matcher import CategoryMatcher
from app.services.financial_access import category_access, category_definition_for_actor


@pytest.fixture
def household(db_session, monkeypatch):
    admin, member, outsider = ["vocabulary-" + uuid4().hex for _ in range(3)]
    db_session.add_all([User(id=id, email=id + "@example.test") for id in (admin, member, outsider)])
    db_session.flush()
    person = Person(user_id=admin, linked_user_id=member, name="Partner", kind="member")
    db_session.add(person); db_session.flush()
    membership = HouseholdMembership(member_user_id=member, owner_user_id=admin, person_id=person.id)
    db_session.add(membership)
    categories = [
        Category(user_id=admin, name="Housing", category_type="expense", cash_flow_kind="loan_principal",
                 description="ADMIN PRIVATE PROPERTY", categorization_instructions="ADMIN PRIVATE GUIDANCE"),
        Category(user_id=member, name="Housing", category_type="expense", description="MEMBER PRIVATE PROPERTY",
                 categorization_instructions="MEMBER PRIVATE GUIDANCE"),
    ]
    db_session.add_all(categories)
    account = Account(user_id=admin, name="Shared", account_type="checking", currency="AUD")
    db_session.add(account); db_session.flush()
    db_session.add(HouseholdAccountShare(account_id=account.id, member_user_id=member, granted_by_user_id=admin))
    transaction = Transaction(user_id=admin, account_id=account.id, amount=-100, currency="AUD",
                              booked_at=datetime(2026,10,1), description="Payment", transaction_type="debit")
    db_session.add(transaction); db_session.flush()
    monkeypatch.setattr(db_session, "commit", db_session.flush)
    return db_session, admin, member, outsider, membership, account, categories, transaction


def test_same_name_meanings_remain_selectable_without_private_metadata(household):
    db, admin, member, outsider, _, _, categories, _ = household
    available = db.query(Category).filter(category_access(member)).all()
    assert {category.id for category in available} >= {category.id for category in categories}
    assert not db.query(Category).filter(Category.id.in_([category.id for category in categories]), category_access(outsider)).all()
    projected = category_definition_for_actor(categories[0], member)
    assert projected.cash_flow_kind == "loan_principal"
    assert projected.description is None and projected.categorization_instructions is None
    assert projected.parent_id is None and projected.created_at is None
    assert categories[0].description == "ADMIN PRIVATE PROPERTY"


def test_ai_disambiguates_duplicate_names_and_never_inherits_a_partners_guidance(household):
    db, _, member, _, _, _, categories, _ = household
    matcher = CategoryMatcher(db, user_id=member, auto_load_from_db=False)
    vocabulary = matcher._load_categories()
    relevant = [category for category in vocabulary.values() if category.id in {row.id for row in categories}]
    assert len(relevant) == 2 and len({category.name for category in relevant}) == 2
    assert "housing" not in vocabulary  # ambiguous unqualified labels must abstain
    own = next(category for category in relevant if category.id == categories[1].id)
    guidance = "\n".join(matcher._get_category_instructions_from_db())
    assert own.name in guidance and "MEMBER PRIVATE GUIDANCE" in guidance
    assert "ADMIN PRIVATE" not in guidance
    assert all(category.name == "Housing" for category in categories)  # no ORM mutation


def test_shared_edit_accepts_partners_category_and_revocation_denies_current_access(household, monkeypatch):
    from app.routes.transactions import assign_category
    from app.schemas import CategoryAssign
    from app.services.categorization_suggestions import owned_transaction
    db, admin, member, _, membership, _, categories, transaction = household
    from app import db_helpers
    monkeypatch.setattr(db_helpers, "_get_authenticated_user_id", lambda _: member)
    result = assign_category(transaction.id, CategoryAssign(category_id=categories[0].id), user_id=member, db=db)
    assert result.category_id == categories[0].id and result.user_id == admin
    db.delete(membership); db.flush()
    with pytest.raises(HTTPException) as error:
        owned_transaction(db, member, transaction.id)
    assert error.value.status_code == 404
