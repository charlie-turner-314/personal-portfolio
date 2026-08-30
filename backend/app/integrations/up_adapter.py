"""Adapter for Up's personal access-token API.

The API token belongs only in the server-side encrypted bank connection.  This
adapter intentionally exposes no token serialization or logging surface.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

import httpx

from app.integrations.base import AccountData, BankAdapter, TransactionData


class UpApiError(RuntimeError):
    pass


class UpAdapter(BankAdapter):
    BASE_URL = "https://api.up.com.au/api/v1"

    def __init__(self, access_token: str, client: Optional[httpx.Client] = None):
        self._client = client or httpx.Client(
            base_url=self.BASE_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            timeout=30.0,
        )

    def _get(self, url: str, *, params: Optional[dict[str, str]] = None) -> dict[str, Any]:
        try:
            response = self._client.get(url, params=params)
        except httpx.HTTPError as exc:
            # Keep provider/network details out of API responses and worker logs.
            raise UpApiError("Unable to reach the Up API") from exc
        if response.is_error:
            # Do not include response bodies: provider errors can echo sensitive data.
            raise UpApiError(f"Up API returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise UpApiError("Up API returned an invalid response") from exc

    @staticmethod
    def _account(resource: dict[str, Any]) -> AccountData:
        attrs = resource["attributes"]
        balance = attrs.get("balance") or {}
        up_type = attrs.get("accountType")
        account_type = {
            "SAVER": "savings",
            # The canonical model represents liabilities as credit accounts.
            "HOME_LOAN": "credit",
            "CREDIT_CARD": "credit",
        }.get(up_type, "checking")
        return AccountData(
            external_id=resource["id"],
            name=attrs.get("displayName") or "Up account",
            account_type=account_type,
            institution="Up",
            currency=balance.get("currencyCode") or "AUD",
            balance_available=Decimal(str(balance["value"])) if balance.get("value") is not None else None,
            metadata={"account_type": attrs.get("accountType")},
        )

    def fetch_accounts(self) -> list[AccountData]:
        accounts: list[AccountData] = []
        next_url: Optional[str] = "/accounts"
        for _ in range(500):
            data = self._get(next_url)
            accounts.extend(self._account(item) for item in data.get("data", []))
            next_url = (data.get("links") or {}).get("next")
            if not next_url:
                return accounts
        raise UpApiError("Up account pagination limit reached")

    def fetch_transactions(
        self,
        account_external_id: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> list[TransactionData]:
        params: dict[str, str] = {}
        if start_date:
            params["filter[since]"] = start_date.isoformat()
        if end_date:
            params["filter[until]"] = end_date.isoformat()
        result: list[TransactionData] = []
        next_url: Optional[str] = f"/accounts/{account_external_id}/transactions"
        # Up paginates with absolute links.next URLs. A hard cap protects workers
        # from a malformed continuation loop without silently returning partial data.
        for _ in range(500):
            data = self._get(
                next_url,
                params=params if next_url == f"/accounts/{account_external_id}/transactions" else None,
            )
            result.extend(
                self.normalize_transaction(item)
                for item in data.get("data", [])
                if item.get("attributes", {}).get("status") == "SETTLED"
            )
            next_url = (data.get("links") or {}).get("next")
            if not next_url:
                return result
        raise UpApiError("Up transaction pagination limit reached")

    def normalize_transaction(self, raw: dict[str, Any]) -> TransactionData:
        attrs = raw["attributes"]
        amount = attrs["amount"]
        value = Decimal(str(amount["value"]))
        relationships = raw.get("relationships") or {}
        transfer = (relationships.get("transferAccount") or {}).get("data") or {}
        description = attrs.get("description") or attrs.get("rawText") or "Up transaction"
        return TransactionData(
            external_id=raw["id"],
            account_external_id=((relationships.get("account") or {}).get("data") or {}).get("id", ""),
            amount=value,
            currency=amount.get("currencyCode", "AUD"),
            description=description,
            merchant=attrs.get("description"),
            booked_at=datetime.fromisoformat(attrs["settledAt"].replace("Z", "+00:00")),
            transaction_type="debit" if value < 0 else "credit",
            pending=False,
            # This is intentionally only relationship metadata: the API identifies
            # the destination account, not a matching destination transaction.
            metadata={"transfer_account_external_id": transfer.get("id")} if transfer.get("id") else {},
        )
