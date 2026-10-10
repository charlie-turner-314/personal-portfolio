from datetime import datetime, timezone

import httpx

from app.integrations.up_adapter import UpAdapter, UpApiError


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
