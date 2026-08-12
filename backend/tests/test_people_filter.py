"""
Smoke tests for list_people and get_household_summary MCP tools.

Exercises the person filter end-to-end:
  - list_accounts with person_ids excludes accounts not owned by the filter set
  - get_household_summary partitions a joint account's balance evenly across owners
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models import (
    Account,
    AccountOwner,
    Person,
    Property,
    PropertyLiabilityLink,
    PropertyOwner,
    User,
)
from app.mcp.tools.accounts import list_accounts
from app.mcp.tools.analytics import get_financial_summary
from app.mcp.tools.people import get_household_summary, list_people


@pytest.fixture
def seeded_household(db_session):
    """
    Create one user, two people (self + partner), and accounts covering:
      - self_only: owned by self, balance 100, type=checking
      - partner_only: owned by partner, balance 200, type=checking
      - joint: owned by both with NULL share (equal split), balance 1000, type=savings
      - self_overdraft: owned by self, balance -50, type=checking
      - self_card: owned by self, balance 300, type=credit_card
      - joint_loan: owned by both with explicit 25/75 share, balance 400, type=loan
      - self_hecs: owned by self, balance 1200, type=hecs_help

    Yields (user_id, self_id, partner_id, {account_name: uuid}).
    Cleans up on teardown.
    """
    user_id = str(uuid.uuid4())
    user = User(id=user_id, email=f"{user_id}@test.com")
    db_session.add(user)
    db_session.flush()

    self_person = Person(user_id=user_id, name="Me", kind="self", color="#FF0000")
    partner_person = Person(user_id=user_id, name="Partner", kind="member", color="#0000FF")
    db_session.add(self_person)
    db_session.add(partner_person)
    db_session.flush()

    self_id = str(self_person.id)
    partner_id = str(partner_person.id)

    # Create accounts
    self_account = Account(
        user_id=user_id,
        name="Self Checking",
        account_type="checking",
        institution="TestBank",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("100"),
    )
    partner_account = Account(
        user_id=user_id,
        name="Partner Checking",
        account_type="checking",
        institution="TestBank",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("200"),
    )
    joint_account = Account(
        user_id=user_id,
        name="Joint Savings",
        account_type="savings",
        institution="TestBank",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("1000"),
    )
    self_overdraft = Account(
        user_id=user_id,
        name="Self Overdraft",
        account_type="checking",
        institution="TestBank",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("-50"),
    )
    self_card = Account(
        user_id=user_id,
        name="Self Credit Card",
        account_type="credit_card",
        institution="TestBank",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("300"),
    )
    joint_loan = Account(
        user_id=user_id,
        name="Joint Loan",
        account_type="loan",
        institution="TestBank",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("400"),
    )
    self_hecs = Account(
        user_id=user_id,
        name="Self HECS",
        account_type="hecs_help",
        institution="ATO",
        currency="EUR",
        provider="manual",
        is_active=True,
        starting_balance=Decimal("0"),
        functional_balance=Decimal("1200"),
    )
    accounts_to_seed = (
        self_account,
        partner_account,
        joint_account,
        self_overdraft,
        self_card,
        joint_loan,
        self_hecs,
    )
    for acct in accounts_to_seed:
        db_session.add(acct)
    db_session.flush()

    self_acct_id = str(self_account.id)
    partner_acct_id = str(partner_account.id)
    joint_acct_id = str(joint_account.id)
    self_overdraft_id = str(self_overdraft.id)
    self_card_id = str(self_card.id)
    joint_loan_id = str(joint_loan.id)
    self_hecs_id = str(self_hecs.id)

    # Ownership rows
    db_session.add(AccountOwner(account_id=self_account.id, person_id=self_person.id, share=None))
    db_session.add(AccountOwner(account_id=partner_account.id, person_id=partner_person.id, share=None))
    # Joint: both owners, no explicit share → equal split
    db_session.add(AccountOwner(account_id=joint_account.id, person_id=self_person.id, share=None))
    db_session.add(AccountOwner(account_id=joint_account.id, person_id=partner_person.id, share=None))
    db_session.add(AccountOwner(account_id=self_overdraft.id, person_id=self_person.id, share=None))
    db_session.add(AccountOwner(account_id=self_card.id, person_id=self_person.id, share=None))
    db_session.add(AccountOwner(account_id=joint_loan.id, person_id=self_person.id, share=Decimal("0.25")))
    db_session.add(AccountOwner(account_id=joint_loan.id, person_id=partner_person.id, share=Decimal("0.75")))
    db_session.add(AccountOwner(account_id=self_hecs.id, person_id=self_person.id, share=None))

    db_session.commit()

    try:
        yield (
            user_id,
            self_id,
            partner_id,
            {
                "self_only": self_acct_id,
                "partner_only": partner_acct_id,
                "joint": joint_acct_id,
                "self_overdraft": self_overdraft_id,
                "self_card": self_card_id,
                "joint_loan": joint_loan_id,
                "self_hecs": self_hecs_id,
            },
        )
    finally:
        account_ids = [acct.id for acct in accounts_to_seed]
        db_session.query(AccountOwner).filter(
            AccountOwner.account_id.in_(account_ids)
        ).delete(synchronize_session=False)
        db_session.query(Account).filter(Account.user_id == user_id).delete(synchronize_session=False)
        db_session.query(Person).filter(Person.user_id == user_id).delete(synchronize_session=False)
        db_session.query(User).filter(User.id == user_id).delete(synchronize_session=False)
        db_session.commit()


def test_list_people_returns_both(seeded_household):
    user_id, self_id, partner_id, _ = seeded_household
    people = list_people(user_id=user_id)
    ids = {p["id"] for p in people}
    assert self_id in ids
    assert partner_id in ids
    assert len(people) == 2


def test_list_accounts_with_self_filter_excludes_partner_only(seeded_household):
    user_id, self_id, partner_id, accounts = seeded_household
    result = list_accounts(user_id=user_id, person_ids=[self_id])
    ids = {a["id"] for a in result}
    assert accounts["self_only"] in ids
    assert accounts["joint"] in ids
    assert accounts["partner_only"] not in ids


def test_household_summary_partitions_joint_account(seeded_household):
    user_id, self_id, partner_id, _ = seeded_household
    summary = get_household_summary(user_id=user_id)
    by_person = {p["person_id"]: p for p in summary["people"]}
    assert self_id in by_person
    assert partner_id in by_person
    # self: 100 (own) + 500 (half of 1000 joint) = 600
    assert by_person[self_id]["cash"] == pytest.approx(600.0)
    # partner: 200 (own) + 500 (half of 1000 joint) = 700
    assert by_person[partner_id]["cash"] == pytest.approx(700.0)


def test_household_summary_separates_liabilities_from_cash(seeded_household):
    user_id, self_id, partner_id, _ = seeded_household
    summary = get_household_summary(user_id=user_id)
    by_person = {p["person_id"]: p for p in summary["people"]}

    assert by_person[self_id]["cash"] == pytest.approx(600.0)
    assert by_person[self_id]["gross_assets"] == pytest.approx(600.0)
    # self liabilities: 50 overdraft + 300 card + 100 loan share + 1200 HECS
    assert by_person[self_id]["total_liabilities"] == pytest.approx(1650.0)
    assert by_person[self_id]["net_worth"] == pytest.approx(-1050.0)
    assert by_person[self_id]["total"] == pytest.approx(-1050.0)

    assert by_person[partner_id]["cash"] == pytest.approx(700.0)
    assert by_person[partner_id]["gross_assets"] == pytest.approx(700.0)
    # partner liabilities: 300 share of joint loan
    assert by_person[partner_id]["total_liabilities"] == pytest.approx(300.0)
    assert by_person[partner_id]["net_worth"] == pytest.approx(400.0)
    assert by_person[partner_id]["total"] == pytest.approx(400.0)


def test_household_summary_filter_by_person_ids(seeded_household):
    user_id, self_id, _partner_id, _ = seeded_household
    summary = get_household_summary(user_id=user_id, person_ids=[self_id])
    assert len(summary["people"]) == 1
    assert summary["people"][0]["person_id"] == self_id
    assert summary["people"][0]["total_liabilities"] == pytest.approx(1650.0)


def test_household_summary_uses_property_equity_for_linked_mortgage(seeded_household, db_session):
    user_id, self_id, partner_id, seeded_accounts = seeded_household
    self_person = db_session.query(Person).filter(Person.id == self_id).one()
    partner_person = db_session.query(Person).filter(Person.id == partner_id).one()
    joint_loan = db_session.query(Account).filter(Account.id == seeded_accounts["joint_loan"]).one()

    property_row = Property(
        user_id=user_id,
        name="Joint Home",
        property_type="residential",
        current_value=Decimal("900"),
        currency="EUR",
        is_active=True,
    )
    db_session.add(property_row)
    db_session.flush()
    db_session.add(PropertyOwner(property_id=property_row.id, person_id=self_person.id, share=None))
    db_session.add(PropertyOwner(property_id=property_row.id, person_id=partner_person.id, share=None))
    db_session.add(PropertyLiabilityLink(
        property_id=property_row.id,
        account_id=joint_loan.id,
        user_id=user_id,
    ))
    db_session.commit()

    summary = get_household_summary(user_id=user_id)
    by_person = {p["person_id"]: p for p in summary["people"]}

    # Property value is split 50/50, but the linked joint loan keeps its 25/75
    # debt ownership and is no longer reported as a standalone liability.
    assert by_person[self_id]["properties"] == pytest.approx(350.0)
    assert by_person[self_id]["total_liabilities"] == pytest.approx(1550.0)
    assert by_person[self_id]["net_worth"] == pytest.approx(-600.0)

    assert by_person[partner_id]["properties"] == pytest.approx(150.0)
    assert by_person[partner_id]["total_liabilities"] == pytest.approx(0.0)
    assert by_person[partner_id]["net_worth"] == pytest.approx(850.0)


def test_financial_summary_reports_account_net_worth_for_person(seeded_household):
    user_id, self_id, _partner_id, _ = seeded_household
    summary = get_financial_summary(user_id=user_id, person_ids=[self_id])

    assert summary["gross_assets"] == pytest.approx(600.0)
    assert summary["total_liabilities"] == pytest.approx(1650.0)
    assert summary["net_worth"] == pytest.approx(-1050.0)
    assert summary["total_balance"] == pytest.approx(2150.0)
