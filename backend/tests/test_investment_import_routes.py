import hashlib
import hmac
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app.database import get_db
from app.main import app
from app.models import (
    Account,
    BrokerTrade,
    CsvImportProfile,
    Holding,
    InvestmentActivity,
    InvestmentIncomeEvent,
    InvestmentIngestionRun,
    InvestmentSourceRecord,
    User,
)


INTERNAL_AUTH_SECRET = "investment-import-route-secret"


def _headers(method: str, path: str, user_id: str) -> dict[str, str]:
    timestamp = str(int(time.time()))
    payload = "\n".join([method, path, user_id, timestamp])
    signature = hmac.new(
        INTERNAL_AUTH_SECRET.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    return {
        "x-personal-portfolio-user-id": user_id,
        "x-personal-portfolio-timestamp": timestamp,
        "x-personal-portfolio-signature": signature,
    }


@pytest.fixture
def route_context(db_session, monkeypatch):
    monkeypatch.setenv("INTERNAL_AUTH_SECRET", INTERNAL_AUTH_SECRET)
    user = User(
        id=f"investment-import-route-{uuid.uuid4()}",
        email=f"{uuid.uuid4()}@route.test",
        functional_currency="AUD",
    )
    account = Account(
        user_id=user.id,
        name="Route Investments",
        account_type="investment_brokerage",
        currency="AUD",
        is_active=True,
    )
    db_session.add_all([user, account])
    db_session.commit()
    app.dependency_overrides[get_db] = lambda: db_session
    client = TestClient(app)
    yield client, user, account
    app.dependency_overrides.clear()
    db_session.rollback()
    db_session.query(CsvImportProfile).filter(CsvImportProfile.account_id == account.id).delete()
    db_session.query(InvestmentActivity).filter(InvestmentActivity.account_id == account.id).delete()
    db_session.query(InvestmentSourceRecord).filter(InvestmentSourceRecord.account_id == account.id).delete()
    db_session.query(InvestmentIngestionRun).filter(InvestmentIngestionRun.account_id == account.id).delete()
    db_session.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id == account.id).delete()
    db_session.query(BrokerTrade).filter(BrokerTrade.account_id == account.id).delete()
    db_session.query(Holding).filter(Holding.account_id == account.id).delete()
    db_session.delete(account)
    db_session.delete(user)
    db_session.commit()


def _request(account_id: str, *, save_mapping: bool = False) -> dict:
    return {
        "account_id": account_id,
        "provider": "Generic Broker",
        "file_name": "route.csv",
        "file_content": (
            "Reference,Date,Type,Symbol,Quantity,Price,Currency,Fee\n"
            "trade-1,2025-05-01,Buy,VAS,4,99.50,AUD,2.50\n"
        ),
        "mapping": {
            "source_reference": "Reference",
            "occurred_at": "Date",
            "activity_type": "Type",
            "asset_symbol": "Symbol",
            "quantity": "Quantity",
            "price": "Price",
            "currency": "Currency",
            "fee_amount": "Fee",
        },
        "date_format": "AUTO",
        "amount_format": "DOT_DECIMAL",
        "default_asset_type": "equity",
        "save_mapping": save_mapping,
    }


def _request_json(client: TestClient, method: str, path: str, user_id: str, **kwargs):
    return client.request(method, path, headers=_headers(method, path, user_id), **kwargs)


def test_import_routes_preview_apply_profile_provenance_history_and_revert(route_context):
    client, user, account = route_context
    preview = _request_json(
        client, "POST", "/api/investments/imports/preview", user.id,
        json=_request(str(account.id)),
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["summary"]["ready_rows"] == 1
    assert preview.json()["unmatched_assets"] == ["VAS"]

    applied = _request_json(
        client, "POST", "/api/investments/imports", user.id,
        json=_request(str(account.id), save_mapping=True),
    )
    assert applied.status_code == 200, applied.text
    run_id = applied.json()["run_id"]
    assert applied.json()["inserted_activities"] == 1
    assert applied.json()["profile_id"]

    profiles_path = f"/api/investments/import-profiles?account_id={account.id}"
    profiles = _request_json(client, "GET", profiles_path, user.id)
    assert profiles.status_code == 200, profiles.text
    assert profiles.json()[0]["provider"] == "generic_broker"
    assert profiles.json()[0]["header_signature"][:3] == ["Reference", "Date", "Type"]

    history_path = f"/api/investments/imports?account_id={account.id}"
    history = _request_json(client, "GET", history_path, user.id)
    assert history.status_code == 200, history.text
    assert history.json()[0]["id"] == run_id
    assert history.json()[0]["status"] == "completed"

    provenance_path = f"/api/investments/imports/{run_id}/source-records"
    provenance = _request_json(client, "GET", provenance_path, user.id)
    assert provenance.status_code == 200, provenance.text
    assert provenance.json()[0]["provider_record_id"] == "trade-1"

    revert_path = f"/api/investments/imports/{run_id}/revert"
    reverted = _request_json(client, "POST", revert_path, user.id)
    assert reverted.status_code == 200, reverted.text
    assert reverted.json()["removed_trades"] == 1


def test_import_routes_do_not_expose_another_users_runs(route_context):
    client, user, account = route_context
    applied = _request_json(
        client, "POST", "/api/investments/imports", user.id,
        json=_request(str(account.id)),
    )
    run_id = applied.json()["run_id"]
    other_user = f"other-{uuid.uuid4()}"
    path = f"/api/investments/imports/{run_id}/source-records"
    response = _request_json(client, "GET", path, other_user)
    assert response.status_code == 404


def test_reconciliation_routes_surface_and_resolve_owned_income_review(route_context):
    client, user, account = route_context
    payload = _request(str(account.id))
    payload["file_content"] = (
        "Reference,Date,Type,Symbol,Quantity,Price,Gross,Net,Currency,Fee,Franked\n"
        "trade-1,2025-05-01,Buy,VAS,4,99.50,,,AUD,2.50,\n"
        "income-1,2025-06-30,Distribution,VAS,,,50,50,AUD,,5\n"
    )
    payload["mapping"].update({
        "gross_amount": "Gross",
        "net_amount": "Net",
        "franked_amount": "Franked",
    })
    applied = _request_json(
        client, "POST", "/api/investments/imports", user.id, json=payload,
    )
    assert applied.status_code == 200, applied.text

    path = f"/api/investments/reconciliation-items?account_id={account.id}&status=pending"
    listed = _request_json(client, "GET", path, user.id)
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == 1
    item = listed.json()[0]
    assert item["kind"] == "cash_match"
    assert item["income_event_id"]

    resolve_path = f"/api/investments/reconciliation-items/{item['id']}/resolve"
    resolved = _request_json(
        client, "POST", resolve_path, user.id, json={"action": "ignore"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "ignored"

    events_path = f"/api/investments/income-events?account_id={account.id}"
    events = _request_json(client, "GET", events_path, user.id)
    assert events.status_code == 200, events.text
    income = events.json()[0]
    update_payload = {
        key: income[key]
        for key in (
            "account_id", "holding_id", "event_type", "pay_date", "ex_date",
            "currency", "cash_received", "franked_amount", "unfranked_amount",
            "franking_credit", "foreign_income", "foreign_tax_paid", "tfn_withholding",
            "amit_amma_components", "is_drp", "drp_quantity", "drp_price", "source_id", "notes",
        )
    }
    update_payload["franked_amount"] = "10"
    update_path = f"/api/investments/income-events/{income['id']}"
    updated = _request_json(client, "PUT", update_path, user.id, json=update_payload)
    assert updated.status_code == 200, updated.text
    sources = updated.json()["component_sources"]["franked_amount"]
    assert sources[0]["kind"] == "cash_activity"
    assert sources[-1]["kind"] == "manual"

    other_user = f"other-{uuid.uuid4()}"
    hidden = _request_json(client, "GET", path, other_user)
    assert hidden.status_code == 200
    assert hidden.json() == []


def test_crypto_transfer_review_route_is_account_scoped(route_context):
    client, user, account = route_context
    payload = _request(str(account.id))
    payload["default_asset_type"] = "crypto"
    payload["file_content"] = (
        "Reference,Date,Type,Symbol,Quantity,Transaction hash\n"
        "crypto-out-1,2025-08-01,Withdrawal,BTC,0.25,chain-hash-1\n"
    )
    payload["mapping"] = {
        "source_reference": "Reference",
        "occurred_at": "Date",
        "activity_type": "Type",
        "asset_symbol": "Symbol",
        "quantity": "Quantity",
        "transaction_hash": "Transaction hash",
    }
    applied = _request_json(
        client, "POST", "/api/investments/imports", user.id, json=payload,
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["pending_transfers"] == 1

    path = f"/api/investments/crypto-transfers?account_id={account.id}&status=pending"
    listed = _request_json(client, "GET", path, user.id)
    assert listed.status_code == 200, listed.text
    transfer = listed.json()[0]
    assert transfer["direction"] == "out"
    assert transfer["asset_symbol"] == "BTC"
    assert transfer["quantity"] == "0.250000000000000000"
    assert transfer["transaction_hash"] == "chain-hash-1"
    assert transfer["status"] == "pending"
    assert transfer["match_method"] is None

    hidden = _request_json(client, "GET", path, f"other-{uuid.uuid4()}")
    assert hidden.status_code == 404
