from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

from app.integrations.up_adapter import UpAdapter, UpApiError
from tasks.enable_banking_tasks import _account_sync_start_date


@pytest.mark.parametrize("value,expected", [
    (date(2026, 4, 14), "2026-04-14T00:00:00+00:00"),
    (datetime(2026, 4, 14, 12, 30), "2026-04-14T12:30:00+00:00"),
    (datetime(2026, 4, 14, 12, 30, tzinfo=timezone.utc), "2026-04-14T12:30:00+00:00"),
    (datetime(2026, 4, 14, 0, 30, tzinfo=timezone(timedelta(hours=10))), "2026-04-13T14:30:00+00:00"),
])
def test_transaction_filters_are_timezone_qualified_timestamps(value, expected):
    def handler(request):
        assert request.url.params["filter[since]"] == expected
        assert request.url.params["filter[until]"] == expected
        return httpx.Response(200, json={"data": [], "links": {}})

    assert UpAdapter("token", client=_client(handler)).fetch_transactions("acc-1", value, value) == []


@pytest.mark.parametrize("last_synced_at", [None, datetime(2026, 4, 15, 12, tzinfo=timezone.utc)])
def test_real_sync_lookback_dates_are_accepted_by_up_contract(last_synced_at):
    start = _account_sync_start_date(
        SimpleNamespace(last_synced_at=last_synced_at), SimpleNamespace(initial_sync_days=180)
    )
    assert type(start) is date

    def handler(request):
        # The real API rejects YYYY-MM-DD even though mocks used to accept it.
        assert request.url.params["filter[since]"] == f"{start.isoformat()}T00:00:00+00:00"
        return httpx.Response(200, json={"data": [], "links": {}})

    assert UpAdapter("token", client=_client(handler)).fetch_transactions("acc-1", start) == []


def test_unbounded_transaction_request_omits_date_filters():
    def handler(request):
        assert not request.url.params
        return httpx.Response(200, json={"data": [], "links": {}})

    assert UpAdapter("token", client=_client(handler)).fetch_transactions("acc-1") == []


def _client(handler):
    return httpx.Client(
        base_url="https://api.up.com.au/api/v1",
        headers={"Authorization": "Bearer never-log-this"},
        transport=httpx.MockTransport(handler),
    )


def test_up_adapter_accounts_and_settled_paginated_transactions():
    def handler(request: httpx.Request):
        if request.url.path == "/api/v1/accounts":
            return httpx.Response(200, json={"data": [{"id": "acc-1", "attributes": {
                "displayName": "Spending", "accountType": "TRANSACTIONAL",
                "balance": {"currencyCode": "AUD", "value": "23.45"},
            }}]})
        if request.url.path == "/api/v1/accounts/acc-1/transactions" and request.url.params.get("page[after]") != "two":
            return httpx.Response(200, json={
                "data": [
                    {"id": "held", "attributes": {"status": "HELD"}},
                    {"id": "tx-1", "attributes": {
                        "status": "SETTLED", "description": "Coffee", "settledAt": "2026-01-02T03:04:05Z",
                        "amount": {"currencyCode": "AUD", "value": "-4.50"},
                    }, "relationships": {"account": {"data": {"id": "acc-1"}}, "transferAccount": {"data": {"id": "acc-2"}}}},
                ],
                "links": {"next": "https://api.up.com.au/api/v1/transactions?page[after]=two"},
            })
        # Pagination URLs are opaque provider links and must be followed exactly.
        if request.url.path == "/api/v1/transactions" and request.url.params.get("page[after]") == "two":
            return httpx.Response(200, json={"data": [{"id": "tx-2", "attributes": {
                "status": "SETTLED", "description": "Pay", "settledAt": "2026-01-03T03:04:05Z",
                "amount": {"currencyCode": "AUD", "value": "10.00"},
            }, "relationships": {"account": {"data": {"id": "acc-1"}}}}], "links": {}})
        raise AssertionError(str(request.url))

    adapter = UpAdapter("token", client=_client(handler))
    account = adapter.fetch_accounts()[0]
    transactions = adapter.fetch_transactions("acc-1", datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert account.name == "Spending"
    assert str(account.balance_available) == "23.45"
    assert [transaction.external_id for transaction in transactions] == ["tx-1", "tx-2"]
    assert transactions[0].amount == -4.50
    assert transactions[0].metadata == {"transfer_account_external_id": "acc-2"}


def test_up_adapter_redacts_provider_error_body():
    adapter = UpAdapter("token", client=_client(lambda _: httpx.Response(401, text="token=secret")))
    try:
        adapter.fetch_accounts()
    except UpApiError as exc:
        assert "401" in str(exc)
        assert "secret" not in str(exc)
    else:
        raise AssertionError("expected UpApiError")


def test_up_adapter_normalizes_network_errors():
    def unavailable(_: httpx.Request):
        raise httpx.ConnectError("token=secret")

    adapter = UpAdapter("token", client=_client(unavailable))
    try:
        adapter.fetch_accounts()
    except UpApiError as exc:
        assert str(exc) == "Unable to reach the Up API"
    else:
        raise AssertionError("expected UpApiError")
