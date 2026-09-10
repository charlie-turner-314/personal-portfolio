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
