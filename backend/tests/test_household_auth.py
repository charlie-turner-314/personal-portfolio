"""API/MCP caller identity must never be replaced by the household owner."""
from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from app import database, db_helpers

@pytest.fixture
def identities(monkeypatch):
    factory = MagicMock(side_effect=AssertionError("Identity resolution must not read membership"))
    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr(db_helpers, "get_access_token", lambda: None)
    return factory

def test_signed_member_keeps_own_financial_identity(identities):
    token = db_helpers.set_request_user_id("member")
    try:
        assert db_helpers.get_user_id() == "member"
        identities.assert_not_called()
    finally:
        db_helpers.clear_request_user_id(token)

def test_mcp_keeps_actor_and_rejects_owner_impersonation(monkeypatch, identities):
    monkeypatch.setattr(db_helpers, "_get_authenticated_user_id", lambda _: "member")
    assert db_helpers.get_mcp_user_id() == "member"
    assert db_helpers.get_mcp_user_id(user_id="member") == "member"
    with pytest.raises(ValueError, match="does not match"):
        db_helpers.get_mcp_user_id(user_id="owner")
    identities.assert_not_called()

def test_signed_request_cannot_supply_another_identity(identities):
    token = db_helpers.set_request_user_id("member")
    try:
        with pytest.raises(HTTPException) as error:
            db_helpers.get_user_id(user_id="owner")
        assert error.value.status_code == 403
    finally:
        db_helpers.clear_request_user_id(token)

def test_unauthenticated_request_is_rejected(identities):
    with pytest.raises(HTTPException) as error:
        db_helpers.get_user_id()
    assert error.value.status_code == 401
