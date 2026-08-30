"""Authenticated endpoints for connecting an Up personal access token."""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.db_helpers import get_user_id
from app.integrations.up_adapter import UpAdapter, UpApiError
from app.models import Account, BankConnection
from app.security.data_encryption import encrypt_value

router = APIRouter()


class DiscoverConnectionRequest(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


class DiscoveredAccount(BaseModel):
    uid: str
    account_name: str
    cash_account_type: str
    currency: str
    balance: Optional[str] = None


class DiscoverConnectionResponse(BaseModel):
    connection_id: str
    accounts: list[DiscoveredAccount]


@router.post("/connections", response_model=DiscoverConnectionResponse, status_code=201)
def discover_connection(
    body: DiscoverConnectionRequest,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """Validate a token and stage account discovery for the existing mapping wizard."""
    existing = db.query(BankConnection).filter(
        BankConnection.user_id == user_id,
        BankConnection.provider == "up",
        BankConnection.status.in_(("pending_setup", "active")),
    ).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail="An Up connection already exists. Disconnect it before connecting a new token.",
        )
    encrypted_token = encrypt_value(body.token.strip())
    if not encrypted_token:
        raise HTTPException(status_code=503, detail="Server-side encryption is not configured")
    try:
        accounts = UpAdapter(body.token.strip()).fetch_accounts()
    except UpApiError as exc:
        raise HTTPException(status_code=502, detail="Unable to retrieve Up accounts") from exc

    # raw_session_data is deliberately sanitized because the mapping endpoint can
    # return it to the browser. The token is retained exclusively in this column.
    raw_accounts = [
        {
            "uid": account.external_id,
            "account_name": account.name,
            "cash_account_type": {
                "credit": "LOAN",
                "savings": "SVGS",
            }.get(account.account_type, "CACC"),
            "currency": account.currency,
            "balance": str(account.balance_available) if account.balance_available is not None else None,
        }
        for account in accounts
    ]
    connection = BankConnection(
        user_id=user_id,
        provider="up",
        session_id=f"up:{uuid.uuid4()}",
        aspsp_name="Up",
        aspsp_country="AU",
        status="pending_setup",
        raw_session_data={"accounts": raw_accounts},
        credentials_encrypted=encrypted_token,
    )
    db.add(connection)
    db.commit()
    db.refresh(connection)
    return DiscoverConnectionResponse(connection_id=str(connection.id), accounts=raw_accounts)


@router.post("/connections/{connection_id}/sync")
def sync_connection(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
        BankConnection.provider == "up",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Up connection not found")
    if connection.status != "active":
        raise HTTPException(status_code=400, detail="Up connection is not active")
    from tasks.up_tasks import sync_up_connection
    task = sync_up_connection.delay(str(connection.id))
    return {"message": "Up sync queued", "task_id": task.id}


@router.delete("/connections/{connection_id}")
def disconnect_connection(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """Disconnect Up and erase the retained encrypted personal access token."""
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
        BankConnection.provider == "up",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Up connection not found")
    connection.status = "disconnected"
    connection.credentials_encrypted = None
    db.query(Account).filter(Account.bank_connection_id == connection.id).update(
        {Account.bank_connection_id: None, Account.provider: None},
        synchronize_session=False,
    )
    db.commit()
    return {"message": "Up connection disconnected"}
