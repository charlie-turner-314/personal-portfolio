"""Database integration coverage for explicitly confirmed multi-account CSV rows."""
import uuid
from decimal import Decimal

import pytest

from app.database import Base, engine, SessionLocal
from app.models import Account, CsvImport, InternalTransfer, Transaction, User
from app.services.account_balance_service import AccountBalanceService
from app.services.multi_account_csv import import_routed_rows


@pytest.fixture
def scenario():
    Base.metadata.create_all(engine)
    db = SessionLocal()
    user_id = f"csv-routing-{uuid.uuid4()}"
    user = User(id=user_id, email=f"{user_id}@example.test", name="CSV test", functional_currency="AUD")
    db.add(user)
    db.flush()
    accounts = [Account(user_id=user_id, name=name, account_type="checking", currency="AUD", provider="manual", starting_balance=Decimal("1000")) for name in ("Savings", "Spending")]
    db.add_all(accounts)
    db.flush()
    imp = CsvImport(user_id=user_id, account_id=accounts[0].id, file_name="synthetic.csv", status="importing")
    db.add(imp)
    db.commit()
    row = dict(account_id=str(accounts[0].id), destination_account_id=str(accounts[1].id), amount=-100,
               currency="AUD", booked_at="2026-10-08T00:00:00Z", description="Synthetic transfer", merchant=None,
               external_id="csv-multi-synthetic-1", multi_account=True)
    try:
        yield db, user_id, accounts, str(imp.id), row
    finally:
        db.rollback()
        db.query(User).filter(User.id == user_id).delete()
        db.commit()
        db.close()


def test_pair_is_linked_excluded_and_updates_both_balances(scenario):
    db, user_id, accounts, import_id, row = scenario
    result = import_routed_rows(db, user_id, [row], import_id)
    assert result["inserted_count"] == 2
    txns = db.query(Transaction).filter(Transaction.user_id == user_id).all()
    assert {t.amount for t in txns} == {Decimal("-100"), Decimal("100")}
    assert all(not t.include_in_analytics and str(t.csv_import_id) == import_id for t in txns)
    assert txns[0].internal_transfer_id == txns[1].internal_transfer_id
    assert db.query(InternalTransfer).filter(InternalTransfer.user_id == user_id).count() == 1
    AccountBalanceService(db).calculate_account_balances(user_id, [str(a.id) for a in accounts])
    for account in accounts:
        db.refresh(account)
    assert [a.functional_balance for a in accounts] == [Decimal("900"), Decimal("1100")]


def test_repeat_and_duplicate_rows_do_not_create_more_transactions(scenario):
    db, user_id, _, import_id, row = scenario
    assert import_routed_rows(db, user_id, [row, row], import_id)["inserted_count"] == 2
    assert import_routed_rows(db, user_id, [row], import_id)["inserted_count"] == 0
    assert db.query(Transaction).filter(Transaction.user_id == user_id).count() == 2


def test_external_row_stays_in_analytics(scenario):
    db, user_id, _, import_id, row = scenario
    row["destination_account_id"] = None
    result = import_routed_rows(db, user_id, [row], import_id)
    assert result["inserted_count"] == 1
    assert result["inserted_transactions"][0].include_in_analytics
    assert result["inserted_transactions"][0].internal_transfer_id is None


def test_unknown_destination_rejected_before_any_write(scenario):
    db, user_id, _, import_id, row = scenario
    row["destination_account_id"] = str(uuid.uuid4())
    with pytest.raises(ValueError, match="unavailable"):
        import_routed_rows(db, user_id, [row], import_id)
    db.rollback()
    assert db.query(Transaction).filter(Transaction.user_id == user_id).count() == 0


def test_failed_pair_rolls_back_entire_batch(scenario):
    db, user_id, _, import_id, row = scenario
    invalid = {**row, "external_id": "bad", "amount": "NaN"}
    with pytest.raises(ValueError):
        import_routed_rows(db, user_id, [row, invalid], import_id)
    db.rollback()
    assert db.query(Transaction).filter(Transaction.user_id == user_id).count() == 0


def test_distinct_bank_ids_preserve_identical_real_payments(scenario):
    db, user_id, _, import_id, row = scenario
    assert import_routed_rows(db, user_id, [row, {**row, "external_id": "csv-multi-synthetic-2"}], import_id)["inserted_count"] == 4


def test_existing_single_account_leg_is_not_double_counted(scenario):
    db, user_id, _, import_id, row = scenario
    import_routed_rows(db, user_id, [{**row, "destination_account_id": None, "external_id": "csv-import-old"}], import_id)
    with pytest.raises(ValueError, match="overlaps"):
        import_routed_rows(db, user_id, [row], import_id)
    db.rollback()
    assert db.query(Transaction).filter(Transaction.user_id == user_id).count() == 1


def test_reusing_reference_with_different_routing_is_rejected(scenario):
    db, user_id, _, import_id, row = scenario
    import_routed_rows(db, user_id, [{**row, "destination_account_id": None}], import_id)
    with pytest.raises(ValueError, match="different account routing"):
        import_routed_rows(db, user_id, [row], import_id)
    db.rollback()
    assert db.query(Transaction).filter(Transaction.user_id == user_id).count() == 1


def test_enqueue_checks_destination_ownership_before_publishing(scenario, monkeypatch):
    from fastapi import HTTPException
    from app.routes import csv_import
    db, user_id, _, import_id, row = scenario
    monkeypatch.setattr(csv_import, "get_user_id", lambda _: user_id)
    request = csv_import.EnqueueImportRequest(csv_import_id=import_id, transactions=[{
        **row, "destination_account_id": str(uuid.uuid4()), "transaction_type": "debit",
    }])
    with pytest.raises(HTTPException) as failure:
        csv_import.enqueue_csv_import(request, db)
    assert failure.value.status_code == 404
