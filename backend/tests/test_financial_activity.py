"""Model tests over a migrated isolated PostgreSQL database, rollback per test."""

import os
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from app.models import (
    Account,
    AccountOwnershipAllocation,
    Category,
    ExchangeRate,
    HouseholdAccountShare,
    HouseholdMembership,
    Person,
    Transaction,
    TransactionLink,
    User,
)
from app.services.financial_activity import FinancialActivity

D = Decimal


@pytest.fixture
def model(db_session):
    if os.environ.get(
        "HOUSEHOLD_TEST_ISOLATED"
    ) != "yes" or "household_model_test" not in os.environ.get("DATABASE_URL", ""):
        pytest.skip("Dedicated synthetic database required")
    db = db_session
    suffix = str(uuid4())
    charlie, jessica, outsider = [
        f"activity-{name}-{suffix}" for name in ("charlie", "jessica", "outsider")
    ]
    for actor in (charlie, jessica, outsider):
        db.add(
            User(
                id=actor,
                name=actor,
                email=f"{actor}@example.test",
                functional_currency="AUD",
            )
        )
    db.flush()
    cp, jp, self_jessica = uuid4(), uuid4(), uuid4()
    db.add_all(
        [
            Person(id=cp, user_id=charlie, name="Charlie", kind="self"),
            Person(
                id=jp,
                user_id=charlie,
                name="Jessica",
                kind="member",
                linked_user_id=jessica,
            ),
            Person(id=self_jessica, user_id=jessica, name="Jessica", kind="self"),
        ]
    )
    db.flush()
    db.add(
        HouseholdMembership(owner_user_id=charlie, member_user_id=jessica, person_id=jp)
    )
    joint = Account(
        user_id=charlie, name="Joint", account_type="checking", currency="AUD"
    )
    source = Account(
        user_id=jessica,
        name="JESSICA PRIVATE SOURCE",
        account_type="savings",
        currency="AUD",
    )
    private = Account(
        user_id=charlie, name="CHARLIE PRIVATE", account_type="checking", currency="AUD"
    )
    db.add_all([joint, source, private])
    db.flush()
    db.add(
        HouseholdAccountShare(
            account_id=joint.id, member_user_id=jessica, granted_by_user_id=charlie
        )
    )
    db.add_all(
        [
            AccountOwnershipAllocation(
                account_id=joint.id,
                person_id=cp,
                effective_from=datetime(2026, 1, 1).date(),
                share=D("0.5"),
            ),
            AccountOwnershipAllocation(
                account_id=joint.id,
                person_id=jp,
                effective_from=datetime(2026, 1, 1).date(),
                share=D("0.5"),
            ),
        ]
    )
    spend = Category(user_id=charlie, name="Housing", category_type="expense")
    income = Category(user_id=charlie, name="Salary", category_type="income")
    transfer = Category(user_id=charlie, name="Transfers", category_type="transfer")
    db.add_all([spend, income, transfer])
    db.flush()

    def txn(account, amount, day, category=None, **extra):
        row = Transaction(
            user_id=account.user_id,
            account_id=account.id,
            amount=D(str(amount)),
            functional_amount=D(str(amount)),
            currency="AUD",
            booked_at=datetime.fromisoformat(day),
            category_id=category.id if category else None,
            include_in_analytics=True,
            **extra,
        )
        db.add(row)
        db.flush()
        return row

    debit = txn(source, -70000, "2026-07-09", transfer)
    credit = txn(joint, 70000, "2026-07-09", transfer)
    principal = txn(joint, -70000, "2026-07-12", spend, cash_flow_kind="loan_principal")
    txn(private, 6000, "2026-07-01", income)
    txn(private, -2000, "2026-07-02", spend)
    group = uuid4()
    db.add_all(
        [
            TransactionLink(
                user_id=jessica,
                transaction_id=debit.id,
                group_id=group,
                link_role="primary",
            ),
            TransactionLink(
                user_id=jessica,
                transaction_id=credit.id,
                group_id=group,
                link_role="reimbursement",
            ),
        ]
    )
    db.flush()
    return SimpleNamespace(
        db=db,
        charlie=charlie,
        jessica=jessica,
        outsider=outsider,
        cp=cp,
        jp=jp,
        joint=joint,
        source=source,
        private=private,
        spend=spend,
        income=income,
        transfer=transfer,
        debit=debit,
        credit=credit,
        principal=principal,
        txn=txn,
    )


def july(model, actor, **scope):
    return FinancialActivity(model.db, actor, **scope).summarize(
        from_date="2026-07-01", to_date="2026-07-31"
    )


def test_contribution_is_neither_income_nor_consumption_and_private_source_is_not_inspected(
    model,
):
    m = model
    charlie = july(m, m.charlie)
    assert (
        charlie["income"],
        charlie["expenses"],
        charlie["loan_principal"],
        charlie["boundary_transfers_in"],
    ) == (D(6000), D(2000), D(35000), D(35000))
    assert charlie["ownership_transfers_in"] == 0
    assert "JESSICA PRIVATE SOURCE" not in str(charlie)
    jessica = july(m, m.jessica)
    assert (
        jessica["income"],
        jessica["expenses"],
        jessica["loan_principal"],
        jessica["ownership_transfers_out"],
        jessica["explained_cash_flow"],
    ) == (0, 0, D(35000), D(35000), D(-70000))
    household = july(m, m.jessica, scope="household")
    assert household["loan_principal"] == D(70000)
    assert household["transfers_in"] == household["transfers_out"] == 0
    assert household["scope"] == "household"


@pytest.mark.parametrize(
    "amount,share", [(D("12000"), D("0.3")), (D("918.24"), D("0.8"))]
)
def test_general_amounts_and_dated_ratios_reconcile_over_the_same_permitted_records(
    model, amount, share
):
    m = model
    for row in (m.debit, m.credit, m.principal):
        row.amount = row.functional_amount = amount * (-1 if row.amount < 0 else 1)
    for owner in m.db.query(AccountOwnershipAllocation).filter_by(
        account_id=m.joint.id
    ):
        owner.share = share if owner.person_id == m.jp else 1 - share
    m.db.flush()
    jessica = july(m, m.jessica)
    assert jessica["loan_principal"] == amount * share
    assert jessica["ownership_transfers_out"] == amount * (1 - share)
    boundary = dict(
        from_date="2026-07-01", to_date="2026-07-31", account_ids=[m.joint.id]
    )
    c = FinancialActivity(m.db, m.charlie).summarize(**boundary)
    j = FinancialActivity(m.db, m.jessica).summarize(**boundary)
    h = FinancialActivity(m.db, m.charlie, scope="household").summarize(**boundary)
    assert c["loan_principal"] + j["loan_principal"] == h["loan_principal"] == amount
    assert (
        c["boundary_transfers_in"] + j["boundary_transfers_in"]
        == h["boundary_transfers_in"]
        == amount
    )


def test_date_straddles_and_selected_accounts_are_transfer_boundaries(model):
    m = model
    m.debit.booked_at = datetime(2026, 7, 8)
    m.db.flush()
    result = FinancialActivity(m.db, m.jessica).summarize(
        from_date="2026-07-09", to_date="2026-07-09"
    )
    assert result["boundary_transfers_in"] == D(35000)
    assert result["ownership_transfers_out"] == 0
    selected = FinancialActivity(m.db, m.jessica).summarize(
        from_date="2026-07-01", to_date="2026-07-31", account_ids=[m.source.id]
    )
    assert selected["boundary_transfers_out"] == D(70000)
    assert selected["income"] == selected["expenses"] == 0


def test_mixed_portions_refunds_dated_shares_and_functional_currency(model):
    m = model
    m.db.add_all(
        [
            AccountOwnershipAllocation(
                account_id=m.joint.id,
                person_id=m.cp,
                effective_from=datetime(2026, 8, 1).date(),
                share=D("0.75"),
            ),
            AccountOwnershipAllocation(
                account_id=m.joint.id,
                person_id=m.jp,
                effective_from=datetime(2026, 8, 1).date(),
                share=D("0.25"),
            ),
        ]
    )
    row = m.txn(
        m.joint,
        -2000,
        "2026-08-15",
        m.spend,
        cash_flow_parts=[
            {"kind": "capital", "detail": "loan_principal", "amount": 1200},
            {"kind": "consumption", "amount": 800},
        ],
    )
    row.currency = "USD"
    row.functional_amount = D(-1000)
    m.txn(m.joint, 40, "2026-08-16", m.spend)
    m.db.flush()
    result = FinancialActivity(m.db, m.jessica).summarize(
        from_date="2026-08-01", to_date="2026-08-31"
    )
    assert result["loan_principal"] == D(150)
    assert result["expenses"] == D(90)
    assert result["explained_cash_flow"] == D(-240)


def test_invisible_or_out_of_period_primary_does_not_swallow_a_visible_secondary(model):
    m = model
    primary = m.txn(m.private, -100, "2026-08-01", m.spend)
    secondary = m.txn(m.joint, -20, "2026-08-02", m.spend)
    group = uuid4()
    m.db.add_all(
        [
            TransactionLink(
                user_id=m.charlie,
                transaction_id=primary.id,
                group_id=group,
                link_role="primary",
            ),
            TransactionLink(
                user_id=m.charlie,
                transaction_id=secondary.id,
                group_id=group,
                link_role="expense",
            ),
        ]
    )
    m.db.flush()
    result = FinancialActivity(m.db, m.jessica).summarize(
        from_date="2026-08-01", to_date="2026-08-31"
    )
    assert result["expenses"] == D(10)
    # A secondary booked before its primary still contributes to the primary's
    # net; iterating rows may not zero it before calculating immutable leg sums.
    primary.booked_at = datetime(2026, 8, 3)
    m.db.flush()
    assert FinancialActivity(m.db, m.charlie).summarize(
        from_date="2026-08-01", to_date="2026-08-31"
    )["expenses"] == D(110)
    assert FinancialActivity(m.db, m.charlie).summarize(
        from_date="2026-08-02", to_date="2026-08-02"
    )["expenses"] == D(10)


def test_permission_revocation_outsider_and_unavailable_selection(model):
    m = model
    assert july(m, m.outsider)["entries"] == []
    with pytest.raises(HTTPException) as denied:
        FinancialActivity(m.db, m.outsider).summarize(account_ids=[m.joint.id])
    assert denied.value.status_code == 409
    m.db.query(HouseholdAccountShare).filter_by(account_id=m.joint.id).delete()
    m.db.flush()
    result = july(m, m.jessica)
    assert result["loan_principal"] == 0
    assert result["boundary_transfers_out"] == D(70000)
    with pytest.raises(HTTPException):
        FinancialActivity(m.db, m.jessica).summarize(account_ids=[m.joint.id])


def test_missing_and_future_only_conversion_remain_unknown(model):
    m = model
    m.principal.currency = "ZZZ"
    m.principal.functional_amount = None
    m.db.add(
        ExchangeRate(
            base_currency="ZZZ",
            target_currency="AUD",
            rate=D(2),
            date=datetime(2026, 8, 1),
        )
    )
    m.db.flush()
    result = july(m, m.jessica)
    assert not result["complete"] and result["missing_conversions"] == 1
    assert str(m.spend.id) in result["incomplete_category_ids"]
    m.db.add(
        ExchangeRate(
            base_currency="AUD",
            target_currency="ZZZ",
            rate=D("0.5"),
            date=datetime(2026, 7, 1),
        )
    )
    m.db.flush()
    result = july(m, m.jessica)
    assert result["complete"] and result["loan_principal"] == D(70000)


def test_same_label_definitions_and_manual_override_are_not_merged(model):
    m = model
    other = Category(user_id=m.jessica, name="Housing", category_type="income")
    m.db.add(other)
    m.db.flush()
    m.principal.cash_flow_kind = None
    m.principal.category_system_id = other.id
    m.txn(m.source, 30, "2026-07-20", other)
    m.db.flush()
    result = july(m, m.jessica)
    categories = {
        (row["id"], row["kind"]): row["amount"] for row in result["categories"]
    }
    assert categories[(str(m.spend.id), "consumption")] == D(35000)
    assert categories[(str(other.id), "income")] == D(30)
    assert result["income"] == D(30)


def test_api_and_mcp_use_same_purposes_and_current_observations(model, monkeypatch):
    from contextlib import contextmanager
    from app.mcp.tools import analytics as tools
    from app.routes import analytics as routes

    m = model

    @contextmanager
    def same_db():
        yield m.db

    monkeypatch.setattr(tools, "get_db", same_db)
    monkeypatch.setattr(routes, "get_user_id", lambda value: value)
    m.joint.functional_balance = D(300)
    m.private.functional_balance = D(400)
    m.source.functional_balance = D(100)
    m.db.flush()
    summary = tools.get_financial_summary(m.charlie, "2026-07-01", "2026-07-31")
    assert summary["total_income"] == 6000 and summary["total_expenses"] == 2000
    assert (
        summary["loan_principal"] == 35000 and summary["boundary_transfers_in"] == 35000
    )
    assert summary["net_cashflow"] == 4000 and summary["savings_from_income"] == 4000
    assert summary["total_balance"] == 550 and summary["net_worth"] == 550
    spending = tools.get_spending_by_category(m.charlie, "2026-07-01", "2026-07-31")
    assert spending[0]["total"] == 2000
    assert tools.get_spending_by_category(m.jessica, "2026-07-01", "2026-07-31") == []
    assert tools.get_monthly_cashflow(m.jessica, "2026-07-01", "2026-07-31") == []
    kwargs = dict(
        from_date=datetime(2026, 7, 1),
        to_date=datetime(2026, 7, 31, 23, 59, 59),
        account_id=None,
        uncategorized=None,
        user_id=m.charlie,
        db=m.db,
        scope="my",
        person_ids=None,
    )
    monthly = routes.get_monthly_cashflow(category_id=None, **kwargs)
    assert monthly[0]["income"] == 6000 and monthly[0]["expenses"] == 2000
    from app.routes.transactions import get_spending_by_category as stats

    monkeypatch.setattr("app.routes.transactions.get_user_id", lambda value: value)
    category_stats = stats(
        from_date=kwargs["from_date"],
        to_date=kwargs["to_date"],
        user_id=m.charlie,
        db=m.db,
        account_id=None,
        scope="my",
        person_ids=None,
    )
    assert category_stats[0].total == D(2000)
    assert category_stats[0].scope == "my" and category_stats[0].currency == "AUD"
    chart = routes.get_sankey_data(**kwargs)
    assert (
        chart["totalIncome"] == 6000
        and chart["totalExpenses"] == 2000
        and chart["savings"] == 4000
    )
    assert any(
        node["name"] == "Loan principal" and node["total"] == 35000
        for node in chart["nodes"]
    )
    assert "do not trace funding" in chart["explanation"]
    assert "JESSICA PRIVATE SOURCE" not in str(chart)


def test_missing_conversion_propagates_to_mcp_categories_and_totals(model, monkeypatch):
    from contextlib import contextmanager
    from app.mcp.tools import analytics as tools

    m = model

    @contextmanager
    def same_db():
        yield m.db

    monkeypatch.setattr(tools, "get_db", same_db)
    m.principal.cash_flow_kind = None
    m.principal.currency = "ZZZ"
    m.principal.functional_amount = None
    m.principal.merchant = "Unknown FX"
    m.db.flush()
    summary = tools.get_financial_summary(m.jessica, "2026-07-01", "2026-07-31")
    assert summary["total_expenses"] is None and not summary["activity_complete"]
    categories = tools.get_spending_by_category(m.jessica, "2026-07-01", "2026-07-31")
    assert categories[0]["total"] is None and categories[0]["known_total"] == 0
    assert (
        tools.get_top_merchants(m.jessica, "2026-07-01", "2026-07-31")[0]["total"]
        is None
    )
    assert (
        tools.get_monthly_cashflow(m.jessica, "2026-07-01", "2026-07-31")[0]["expenses"]
        is None
    )


def test_independent_cash_reconciliation_needs_exact_boundaries(model):
    from app.models import AccountBalance
    from app.services.financial_values import cash_reconciliation

    m = model
    activity = FinancialActivity(m.db, m.charlie)
    m.db.add_all(
        [
            AccountBalance(
                account_id=m.joint.id,
                date=datetime(2026, 6, 30),
                balance_in_account_currency=D(1000),
                balance_in_functional_currency=D(1000),
            ),
            AccountBalance(
                account_id=m.joint.id,
                date=datetime(2026, 7, 31),
                balance_in_account_currency=D(1800),
                balance_in_functional_currency=D(1800),
            ),
        ]
    )
    m.db.flush()
    boundary = dict(
        from_date="2026-07-01", to_date="2026-07-31", account_ids=[m.joint.id]
    )
    summary = activity.summarize(**boundary)
    assert summary["explained_cash_flow"] == 0
    reconciliation = cash_reconciliation(
        activity, **boundary, explained=summary["explained_cash_flow"]
    )
    assert reconciliation == {
        "recorded_change": D(400),
        "difference": D("400.00"),
        "missing_accounts": 0,
        "status": "difference",
    }
    m.db.query(AccountBalance).filter(
        AccountBalance.account_id == m.joint.id,
        AccountBalance.date == datetime(2026, 6, 30),
    ).delete()
    m.db.flush()
    assert (
        cash_reconciliation(activity, **boundary, explained=D(0))["recorded_change"]
        is None
    )


def test_net_worth_counts_permitted_assets_once_and_missing_holdings_are_not_zero(
    model,
):
    from datetime import date
    from app.models import Holding, Property
    from app.services.financial_values import net_worth

    m = model
    m.joint.functional_balance = D(300)
    m.private.functional_balance = D(400)
    m.db.flush()
    home = Property(
        user_id=m.charlie,
        name="Home",
        property_type="residential",
        current_value=D(10000),
        currency="AUD",
    )
    m.db.add(home)
    m.db.flush()
    activity = FinancialActivity(m.db, m.charlie)
    values = net_worth(activity)
    assert values["net_worth"] == D(10550)
    assert len(values["assets"]) == 1
    assert net_worth(FinancialActivity(m.db, m.jessica))["assets"] == []
    broker = Account(
        user_id=m.charlie,
        name="Broker",
        account_type="investment_brokerage",
        currency="AUD",
        functional_balance=D(999),
    )
    m.db.add(broker)
    m.db.flush()
    m.db.add(
        Holding(
            user_id=m.charlie,
            account_id=broker.id,
            symbol="SYNTH",
            currency="AUD",
            instrument_type="equity",
            quantity=D(1),
            source="manual",
        )
    )
    m.db.flush()
    values = net_worth(FinancialActivity(m.db, m.charlie))
    assert values["net_worth"] is None and str(broker.id) in values["missing_values"]
    assert values["known_gross_assets"] == D(10550)


def test_property_and_vehicle_values_use_dated_shares_without_granting_access(model):
    from datetime import date
    from app.models import (
        HouseholdPropertyShare,
        Property,
        PropertyOwnershipAllocation,
        Vehicle,
        VehicleOwnershipAllocation,
    )
    from app.services.financial_values import net_worth

    m = model
    m.joint.functional_balance = D(300)
    m.private.functional_balance = D(400)
    m.source.functional_balance = D(100)
    home = Property(
        user_id=m.charlie,
        name="Shared home",
        property_type="residential",
        current_value=D(10000),
        currency="AUD",
    )
    vehicle = Vehicle(
        user_id=m.charlie,
        name="Private car",
        vehicle_type="car",
        current_value=D(1000),
        currency="AUD",
    )
    m.db.add_all([home, vehicle])
    m.db.flush()
    m.db.add_all(
        [
            PropertyOwnershipAllocation(
                property_id=home.id,
                person_id=m.cp,
                effective_from=date(2026, 1, 1),
                share=D("0.4"),
            ),
            PropertyOwnershipAllocation(
                property_id=home.id,
                person_id=m.jp,
                effective_from=date(2026, 1, 1),
                share=D("0.6"),
            ),
            VehicleOwnershipAllocation(
                vehicle_id=vehicle.id,
                person_id=m.cp,
                effective_from=date(2026, 1, 1),
                share=D("0.4"),
            ),
            VehicleOwnershipAllocation(
                vehicle_id=vehicle.id,
                person_id=m.jp,
                effective_from=date(2026, 1, 1),
                share=D("0.6"),
            ),
        ]
    )
    m.db.flush()
    assert net_worth(FinancialActivity(m.db, m.charlie))["net_worth"] == D(4950)
    assert net_worth(FinancialActivity(m.db, m.jessica))["assets"] == []
    m.db.add(
        HouseholdPropertyShare(
            property_id=home.id, member_user_id=m.jessica, granted_by_user_id=m.charlie
        )
    )
    m.db.flush()
    jessica = net_worth(FinancialActivity(m.db, m.jessica))
    assert jessica["net_worth"] == D(6250)
    assert [row["name"] for row in jessica["assets"]] == ["Shared home"]


def test_invalid_purpose_portions_fail_closed(model):
    m = model
    m.principal.cash_flow_parts = [{"kind": "consumption", "amount": 1}]
    m.db.flush()
    with pytest.raises(HTTPException) as invalid:
        july(m, m.charlie)
    assert invalid.value.status_code == 409


def test_viewer_currency_uses_native_units_or_converts_custodian_functional_units(
    model,
):
    m = model
    m.db.query(User).filter(User.id == m.jessica).update({"functional_currency": "USD"})
    # Keep the source account's stored functional observation correctly denominated.
    m.debit.functional_amount = D(-140000)
    m.db.add(
        ExchangeRate(
            base_currency="AUD",
            target_currency="USD",
            rate=D(2),
            date=datetime(2026, 8, 1),
        )
    )
    native = m.txn(
        m.joint,
        -2000,
        "2026-08-15",
        m.spend,
        cash_flow_parts=[
            {"kind": "capital", "detail": "loan_principal", "amount": 1200},
            {"kind": "consumption", "amount": 800},
        ],
    )
    native.currency = "USD"
    native.functional_amount = D(-1000)
    functional = m.txn(m.joint, -3000, "2026-08-16", m.spend)
    functional.currency = "NZD"
    functional.functional_amount = D(-1000)
    m.db.flush()
    result = FinancialActivity(m.db, m.jessica).summarize(
        from_date="2026-08-01", to_date="2026-08-31", account_ids=[m.joint.id]
    )
    assert result["currency"] == "USD" and result["complete"]
    assert result["loan_principal"] == D(600) and result["expenses"] == D(1400)


def test_automatic_mirrors_remain_boundary_facts_without_generated_private_text(model):
    from app.models import InternalTransfer

    m = model
    source = m.txn(m.source, -100, "2026-08-05", m.transfer)
    mirror = m.txn(m.joint, 100, "2026-08-05", m.transfer)
    mirror.external_id = f"mirror-{source.id}"
    mirror.description = "Transfer from JESSICA PRIVATE SOURCE"
    mirror.merchant = "JESSICA PRIVATE SOURCE"
    source.include_in_analytics = False
    mirror.include_in_analytics = False
    m.db.flush()
    link = InternalTransfer(
        user_id=m.jessica,
        source_txn_id=source.id,
        mirror_txn_id=mirror.id,
        source_account_id=m.source.id,
        pocket_account_id=m.joint.id,
        amount=D(100),
        currency="AUD",
    )
    m.db.add(link)
    m.db.flush()
    source.internal_transfer_id = link.id
    m.db.flush()
    boundary = dict(from_date="2026-08-01", to_date="2026-08-31")
    rows, _ = FinancialActivity(m.db, m.charlie).rows(**boundary)
    assert (
        len(rows) == 1
        and rows[0]["description"] == "Transfer"
        and rows[0]["merchant"] is None
    )
    charlie = FinancialActivity(m.db, m.charlie).summarize(**boundary)
    assert (
        charlie["boundary_transfers_in"] == D(50)
        and charlie["income"] == charlie["expenses"] == 0
    )
    jessica = FinancialActivity(m.db, m.jessica).summarize(**boundary)
    assert jessica["ownership_transfers_out"] == D(50)
