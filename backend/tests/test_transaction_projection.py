"""No private integration context through a permitted bank record or search."""

from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4
import os
import pytest
from fastapi import HTTPException
from app.models import (
    Account,
    Category,
    HouseholdAccountShare,
    HouseholdMembership,
    Person,
    RecurringTransaction,
    Transaction,
    User,
)
from app.schemas import TransactionUpdate


@pytest.fixture
def shared(db_session, monkeypatch):
    if os.environ.get("HOUSEHOLD_TEST_ISOLATED") != "yes":
        pytest.skip("Dedicated synthetic database required")
    from app.mcp.tools import transactions as tools
    from app.routes import transactions as routes

    db = db_session
    owner = f"projection-owner-{uuid4()}"
    reader = f"projection-reader-{uuid4()}"
    outside = f"projection-outsider-{uuid4()}"
    db.add_all(
        [
            User(id=value, email=f"{uuid4()}@example.test")
            for value in (owner, reader, outside)
        ]
    )
    db.flush()
    person = Person(user_id=owner, name="Reader", kind="member", linked_user_id=reader)
    db.add(person)
    db.flush()
    db.add(
        HouseholdMembership(
            owner_user_id=owner, member_user_id=reader, person_id=person.id
        )
    )
    account = Account(
        user_id=owner, name="Joint", currency="EUR", account_type="checking"
    )
    db.add(account)
    db.flush()
    db.add(
        HouseholdAccountShare(
            account_id=account.id, member_user_id=reader, granted_by_user_id=owner
        )
    )
    category = Category(user_id=owner, name="Transfer", category_type="transfer")
    rule = RecurringTransaction(
        user_id=owner, name="PRIVATE RULE", amount=Decimal(100), frequency="monthly"
    )
    db.add_all([category, rule])
    db.flush()
    transaction = Transaction(
        user_id=owner,
        account_id=account.id,
        external_id=f"mirror-{uuid4()}",
        amount=Decimal(100),
        currency="EUR",
        description="Transfer from PRIVATE COUNTERPART",
        merchant="PRIVATE COUNTERPART",
        booked_at=datetime.utcnow(),
        category_system_id=category.id,
        recurring_transaction_id=rule.id,
        categorization_instructions="PRIVATE GUIDANCE",
        enrichment_data={"private_account": "PRIVATE COUNTERPART"},
    )
    db.add(transaction)
    db.flush()

    @contextmanager
    def same_db():
        yield db

    monkeypatch.setattr(tools, "get_db", same_db)
    monkeypatch.setattr(routes, "get_user_id", lambda value: value)
    return SimpleNamespace(
        db=db,
        owner=owner,
        reader=reader,
        outside=outside,
        account=account,
        transaction=transaction,
        category=category,
        tools=tools,
        routes=routes,
    )


def test_api_and_mcp_strip_private_context_but_preserve_shared_classification(shared):
    m = shared
    data = m.routes.get_transaction(
        m.transaction.id, user_id=m.reader, db=m.db
    ).model_dump()
    assert data["description"] == "Transfer" and data["merchant"] is None
    assert (
        data["external_id"]
        is data["categorization_instructions"]
        is data["enrichment_data"]
        is None
    )
    assert data["category_system_id"] == m.category.id
    listed = m.routes.list_transactions(
        account_id=None,
        category_id=None,
        uncategorized=None,
        from_date=None,
        to_date=None,
        search=None,
        page=1,
        limit=50,
        sort_by=None,
        sort_order=m.routes.SortOrder.desc,
        type=None,
        user_id=m.reader,
        db=m.db,
    )
    assert listed[0].description == "Transfer" and "PRIVATE" not in str(listed)
    hidden = m.routes.list_transactions(
        account_id=None,
        category_id=None,
        uncategorized=None,
        from_date=None,
        to_date=None,
        search="PRIVATE COUNTERPART",
        page=1,
        limit=50,
        sort_by=None,
        sort_order=m.routes.SortOrder.desc,
        type=None,
        user_id=m.reader,
        db=m.db,
    )
    assert hidden == []
    record = m.tools.get_transaction(m.reader, str(m.transaction.id))
    assert record["category_name"] == "Transfer"
    assert record["external_id"] is record["recurring_transaction_id"] is None
    assert "PRIVATE" not in str(record)
    own = m.tools.get_transaction(m.owner, str(m.transaction.id))
    assert (
        own["categorization_instructions"] == "PRIVATE GUIDANCE"
    )  # private guidance remains available to its custodian
    assert (
        m.transaction.description == "Transfer from PRIVATE COUNTERPART"
    )  # source/audit provenance untouched


@pytest.mark.parametrize("mode", ["contains", "starts_with", "word"])
def test_search_counts_and_id_only_results_do_not_reveal_generated_private_names(
    shared, mode
):
    m = shared
    assert (
        m.tools.list_transactions(m.reader, search="PRIVATE COUNTERPART")[
            "transactions"
        ]
        == []
    )
    result = m.tools.search_transactions(
        m.reader, "PRIVATE COUNTERPART", match_mode=mode, ids_only=True
    )
    assert result["total_count"] == 0 and result["transaction_ids"] == []
    multi = m.tools.search_transactions_multi(
        m.reader, ["PRIVATE COUNTERPART"], match_mode=mode, ids_only=True
    )
    assert multi["total_count"] == 0 and multi["transaction_ids"] == []
    normal = m.tools.search_transactions(m.reader, "Transfer", match_mode="contains")
    assert normal["transactions"][0]["description"] == "Transfer"


def test_private_guidance_cannot_be_changed_by_a_collaborator_and_revocation_is_live(
    shared,
):
    m = shared
    with pytest.raises(HTTPException) as denied:
        m.routes.update_transaction(
            m.transaction.id,
            TransactionUpdate(categorization_instructions="replace"),
            user_id=m.reader,
            db=m.db,
        )
    assert (
        denied.value.status_code == 403
        and m.transaction.categorization_instructions == "PRIVATE GUIDANCE"
    )
    m.db.query(HouseholdAccountShare).filter_by(account_id=m.account.id).delete()
    m.db.flush()
    assert m.tools.get_transaction(m.reader, str(m.transaction.id)) is None
    assert m.tools.search_transactions(m.reader, "Transfer")["total_count"] == 0
    with pytest.raises(HTTPException) as missing:
        m.routes.get_transaction(m.transaction.id, user_id=m.reader, db=m.db)
    assert missing.value.status_code == 404
    assert m.tools.get_transaction(m.outside, str(m.transaction.id)) is None
