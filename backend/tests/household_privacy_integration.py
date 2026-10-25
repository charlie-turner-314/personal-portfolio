"""Real-Postgres API access checks. Run only in a disposable release-lab database."""
import os
import uuid
import io
import zipfile
from decimal import Decimal
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import text
from fastapi import HTTPException, BackgroundTasks
from app.database import SessionLocal
from app.db_helpers import set_request_user_id, clear_request_user_id
from app.models import Account, Transaction, CsvImport, Category, Holding, HoldingValuation, Property, Report
from app.routes import up, enable_banking, investments
from app.mcp.tools.analytics import get_financial_summary
from app.mcp.tools.investments import list_holdings_impl, get_portfolio_summary_impl
from app.routes.transaction_import import import_transactions, TransactionImportRequest, TransactionImportItem
from tasks.csv_import_tasks import _process_transaction_batch
from app.routes.accounts import get_account, update_account
from app.routes.transactions import get_transaction, create_transaction, update_transaction, delete_transactions_by_account
from app.schemas import TransactionCreate, TransactionUpdate, AccountUpdate
from app.services.financial_access import account_access, property_access
from app.mcp.tools.people import get_household_summary
from app.services.report_data_service import build_report_payload
from app.services.report_service import _validate_account_ids
from app.services.tax_report_service import build_australian_tax_report, tax_report_zip


def main():
    assert os.environ.get("HOUSEHOLD_TEST_ISOLATED") == "yes"
    assert "/household_privacy_test_" in os.environ["DATABASE_URL"]
    from up_canonical_integration import run as check_up_canonical
    check_up_canonical()
    owner, member, third = ["privacy-api-" + uuid.uuid4().hex for _ in range(3)]
    joint, private, personal = [uuid.uuid4() for _ in range(3)]
    person, third_person = uuid.uuid4(), uuid.uuid4()
    db = SessionLocal()
    try:
        for uid in (owner, member, third):
            db.execute(text("INSERT INTO users(id,email,functional_currency) VALUES (:id,:email,'AUD')"), {"id": uid, "email": uid+"@example.test"})
        for pid, uid in ((person, member), (third_person, third)):
            db.execute(text("INSERT INTO people(id,user_id,name,kind) VALUES (:id,:owner,'Partner','member')"), {"id": pid, "owner": owner})
            db.execute(text("INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (:member,:owner,:person)"), {"member": uid, "owner": owner, "person": pid})
        for aid, uid, name in ((joint, owner, "Joint"), (private, owner, "Private"), (personal, member, "Personal")):
            db.add(Account(id=aid, user_id=uid, name=name, account_type="checking", currency="AUD"))
        db.flush()
        db.execute(text("INSERT INTO household_account_shares(account_id,member_user_id,granted_by_user_id) VALUES (:id,:member,:owner)"), {"id": joint, "member": member, "owner": owner})
        secret = Transaction(account_id=private, user_id=owner, amount=Decimal("99"), currency="AUD", booked_at=datetime.now(timezone.utc), description="Private secret", transaction_type="debit")
        db.add(secret); db.commit()
        secret_id = secret.id
        fake_account = SimpleNamespace(external_id="synthetic-up-account", name="Up", account_type="checking", currency="AUD", balance_available=Decimal("100"))
        with patch.object(up, "UpAdapter") as adapter, patch.object(up, "encrypt_value", side_effect=lambda value: "test-encrypted:" + value):
            adapter.return_value.fetch_accounts.return_value = [fake_account]
            owner_connection = up.discover_connection(up.DiscoverConnectionRequest(token="synthetic-owner-token"), user_id=owner, db=db)
            member_connection = up.discover_connection(up.DiscoverConnectionRequest(token="synthetic-member-token"), user_id=member, db=db)
            assert owner_connection.connection_id != member_connection.connection_id
            for call in (lambda: up.sync_connection(owner_connection.connection_id, user_id=member, db=db), lambda: up.disconnect_connection(owner_connection.connection_id, user_id=member, db=db)):
                try:
                    call()
                    raise AssertionError("Another person's Up connection was accessible")
                except HTTPException as exc:
                    assert exc.status_code == 404
        joint_account = db.get(Account, joint)
        joint_account.provider = "up"
        joint_account.external_id = fake_account.external_id
        joint_account.bank_connection_id = uuid.UUID(owner_connection.connection_id)
        db.commit()
        suggestions = enable_banking._build_suggested_mappings(db, member, [{"uid": fake_account.external_id, "account_name": "Joint"}])
        assert suggestions[0]["suggested_action"] == "skip"
        try:
            enable_banking.map_accounts(member_connection.connection_id, enable_banking.MapAccountsRequest(mappings=[enable_banking.AccountMapping(bank_uid=fake_account.external_id, action="create")]), db=db, user_id=member)
            raise AssertionError("Duplicate shared bank account creation was allowed")
        except HTTPException as exc:
            assert exc.status_code == 409
        with patch("tasks.up_tasks.sync_up_connection.delay"):
            skipped = enable_banking.map_accounts(member_connection.connection_id, enable_banking.MapAccountsRequest(mappings=[enable_banking.AccountMapping(bank_uid=fake_account.external_id, action="skip")]), db=db, user_id=member)
            assert skipped.accounts_created == 0
        identity = set_request_user_id(member)
        try:
            shared_property, private_property = uuid.uuid4(), uuid.uuid4()
            db.add_all([Property(id=shared_property, user_id=owner, name="Joint property", property_type="residential", currency="AUD", current_value=Decimal("800")), Property(id=private_property, user_id=owner, name="Private property", property_type="residential", currency="AUD", current_value=Decimal("9000"))])
            db.flush()
            db.execute(text("INSERT INTO property_owners(property_id,person_id,share) VALUES (:id,:person,0.5),(:private,:person,1)"), {"id":shared_property,"private":private_property,"person":person})
            db.commit()
            assert db.query(Property).filter(property_access(Property.id, member)).count() == 0
            db.execute(text("INSERT INTO household_property_shares(property_id,member_user_id,granted_by_user_id) VALUES (:id,:member,:owner)"), {"id":shared_property,"member":member,"owner":owner}); db.commit()
            assert {p.id for p in db.query(Property).filter(property_access(Property.id, member))} == {shared_property}
            assert db.query(Property).filter(property_access(Property.id, third)).count() == 0
            summary = get_household_summary(member)
            assert next(p for p in summary["people"] if p["person_id"] == str(person))["properties"] == 400
            db.execute(text("DELETE FROM household_property_shares WHERE property_id=:id"), {"id":shared_property}); db.commit()
            assert db.query(Property).filter(property_access(Property.id, member)).count() == 0
            assert {a.id for a in db.query(Account).filter(account_access(Account.id, member))} == {joint, personal}
            assert {a.id for a in db.query(Account).filter(account_access(Account.id, third))} == set()
            assert {a["id"] for a in get_financial_summary(member)["accounts"]} == {str(joint), str(personal)}, "MCP raw-SQL summaries must include only permitted accounts"
            assert get_account(joint, user_id=member, db=db).id == joint
            assert get_account(joint, user_id=member, db=db).external_id is None
            for active in (False, None):
                try:
                    update_account(joint, AccountUpdate(is_active=active), user_id=member, db=db)
                    raise AssertionError("A collaborator could bypass owner-only deletion via PATCH")
                except HTTPException as exc:
                    assert exc.status_code == 403
            for call in (lambda: get_account(private, user_id=member, db=db), lambda: get_transaction(secret_id, user_id=member, db=db), lambda: delete_transactions_by_account(private, user_id=member, db=db)):
                try:
                    call()
                    raise AssertionError("Private API resource unexpectedly accessible")
                except HTTPException as exc:
                    assert exc.status_code == 404
            created = create_transaction(TransactionCreate(account_id=joint, amount=Decimal("12"), currency="AUD", description="Shared write", transaction_type="debit", booked_at=datetime.now(timezone.utc)), user_id=member, db=db)
            assert created.user_id == owner, "Canonical resource ownership must be retained"
            assert update_transaction(created.id, TransactionUpdate(description="Updated by member"), user_id=member, db=db).description == "Updated by member"
            category = Category(user_id=owner, name="Synthetic shared category", category_type="expense")
            db.add(category); db.flush()
            csv_import = CsvImport(user_id=member, account_id=joint, file_name="private-source.csv", status="importing")
            db.add(csv_import); db.commit()
            row = {"account_id": str(joint), "amount": "-23", "currency": "AUD", "description": "CSV shared edit", "merchant": "Synthetic", "booked_at": "2026-10-01T00:00:00Z", "transaction_type": "debit", "category_id": str(category.id), "external_id": "csv-shared-canonical"}
            first = _process_transaction_batch(db, member, [row], [], [], str(csv_import.id))
            assert first["inserted_count"] == 1
            assert first["inserted_transactions"][0].user_id == owner
            assert _process_transaction_batch(db, owner, [row], [], [], str(csv_import.id))["inserted_count"] == 0, "cross-login CSV duplicates must be skipped"
            imported = import_transactions(TransactionImportRequest(transactions=[TransactionImportItem(account_id=joint, amount=Decimal("-24"), description="API shared import", booked_at=datetime.now(timezone.utc), transaction_type="debit", category_id=category.id)], sync_exchange_rates=False, update_functional_amounts=False, calculate_balances=False, detect_subscriptions=False), db=db)
            assert imported.success and imported.transactions_inserted == 1
            assert db.get(Transaction, uuid.UUID(imported.transaction_ids[0])).user_id == owner
            from app.routes.categories import categorize_transactions_batch as real_categorize
            def actor_categorize(request, db, user_id):
                assert user_id == member, "Shared import categorization must retain the authenticated actor"
                return real_categorize(request.model_copy(update={"use_llm": False}), db, user_id=user_id)
            with patch("app.routes.categories.categorize_transactions_batch", side_effect=actor_categorize):
                result = _process_transaction_batch(db, member, [{**row, "category_id": None, "description": "Uncategorized shared upload", "external_id": "shared-uncategorized", "amount": "-27"}], [], [], str(csv_import.id))
                assert result["inserted_count"] == 1 and result["inserted_transactions"][0].user_id == owner
            with patch("app.routes.categories.categorize_transactions_batch", side_effect=actor_categorize):
                result = import_transactions(TransactionImportRequest(transactions=[TransactionImportItem(account_id=joint, amount=Decimal("-28"), description="Uncategorized API import", booked_at=datetime.now(timezone.utc), transaction_type="debit")], sync_exchange_rates=False, update_functional_amounts=False, calculate_balances=False, detect_subscriptions=False), db=db)
                assert result.success and result.transactions_inserted == 1
            private_property = Property(user_id=owner, name="Private rental asset", property_type="residential", currency="AUD", current_value=300, is_rental=True)
            db.add(private_property); db.flush()
            created.property_id = private_property.id; db.commit()
            report = build_australian_tax_report(db, member, 2026)
            assert str(private_property.id) not in str(report)
            assert all(not row["is_rental_property"] for row in report["transactions"]["rows"]), "private rental metadata cannot leak through a shared transaction"
            _validate_account_ids([str(joint)], member, db)
            digest = Report(user_id=member, name="Personal report over shared activity", account_ids=[str(joint)], frequency="WEEKLY", transaction_direction="ALL", transaction_mode="RECENT", transaction_count=50)
            db.add(digest); db.commit()
            payload = build_report_payload(db, digest)
            assert payload["accounts"] and payload["accounts"][0]["name"] == "Joint"
            assert "Private secret" not in str(payload)

            assert "Private secret" not in str(report)
            assert str(secret_id) not in str(report)
            assert first["inserted_transactions"][0].id.hex in str(report).replace("-", ""), "shared account activity is included in reports"
            with zipfile.ZipFile(io.BytesIO(tax_report_zip(report))) as archive:
                exported = b"".join(archive.read(name) for name in archive.namelist())
                assert b"Private secret" not in exported and str(secret_id).encode() not in exported
            investment, private_investment = uuid.uuid4(), uuid.uuid4()
            for aid in (investment, private_investment):
                db.add(Account(id=aid, user_id=owner, name="Synthetic investment", account_type="investment_manual", currency="AUD"))
            db.flush()
            db.execute(text("INSERT INTO household_account_shares(account_id,member_user_id,granted_by_user_id) VALUES (:id,:member,:owner)"), {"id":investment,"member":member,"owner":owner})
            shared_holding = Holding(user_id=owner, account_id=investment, symbol="TEST", currency="AUD", instrument_type="stock", quantity=Decimal("2"), source="manual")
            hidden_holding = Holding(user_id=owner, account_id=private_investment, symbol="PRIVATE", currency="AUD", instrument_type="stock", quantity=Decimal("2"), source="manual")
            db.add_all([shared_holding, hidden_holding]); db.flush()
            for holding in (shared_holding, hidden_holding):
                db.add(HoldingValuation(holding_id=holding.id, date=datetime.now(timezone.utc).date(), quantity=2, price=50, value_user_currency=100))
            db.commit()
            assert {h.id for h in investments.list_holdings(user_id=member, db=db)} == {shared_holding.id}
            assert investments.portfolio_summary(user_id=member, db=db).total_value == Decimal("100")
            assert {h["id"] for h in list_holdings_impl(db, member)} == {str(shared_holding.id)}
            assert Decimal(get_portfolio_summary_impl(db, member)["total_value"]) == Decimal("100")
            investments.update_holding(shared_holding.id, investments.HoldingUpdate(quantity=Decimal("3")), BackgroundTasks(), user_id=member, db=db)
            assert db.get(Holding, shared_holding.id).quantity == Decimal("3")
            db.execute(text("DELETE FROM household_account_shares WHERE account_id=:id"), {"id": joint}); db.commit()
            try:
                _process_transaction_batch(db, member, [{**row,"external_id":"queued-after-revocation"}], [], [], str(csv_import.id))
                raise AssertionError("Queued import retained revoked access")
            except ValueError as exc:
                assert "unavailable" in str(exc)

            try:
                get_transaction(created.id, user_id=member, db=db)
                raise AssertionError("Revoked access unexpectedly retained")
            except HTTPException as exc:
                assert exc.status_code == 404
            assert db.get(Transaction, secret_id).description == "Private secret"
        finally:
            clear_request_user_id(identity)
        print("Backend privacy integration: private API denial, independent Up connections, duplicate joint-account guard, shared CSV/API imports and deduplication, investment API/MCP access and live revocation passed.")
    finally:
        db.rollback()
        db.execute(text("DELETE FROM household_memberships WHERE member_user_id IN (:member,:third)"), {"member": member,"third":third})
        db.execute(text("DELETE FROM users WHERE id IN (:owner,:member,:third)"), {"owner":owner,"member":member,"third":third})
        db.commit(); db.close()

if __name__ == "__main__":
    main()
