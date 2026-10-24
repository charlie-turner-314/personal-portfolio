"""Household financial scope must never replace the authenticated login identity."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app import database, db_helpers


@pytest.fixture
def membership_lookup(monkeypatch):
    query = MagicMock()
    db = MagicMock()
    db.query.return_value.filter.return_value = query
    context = MagicMock()
    context.__enter__.return_value = db
    factory = MagicMock(return_value=context)
    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr(db_helpers, "get_access_token", lambda: None)
    return query, factory


def test_signed_member_requests_resolve_financial_owner_and_recheck_revocation(membership_lookup):
    query, factory = membership_lookup
    query.first.side_effect = [SimpleNamespace(owner_user_id="owner"), None]
    token = db_helpers.set_request_user_id("member")
    try:
        assert db_helpers.get_user_id() == "owner"
        assert db_helpers.get_user_id() == "member"
        assert factory.call_count == 2
    finally:
        db_helpers.clear_request_user_id(token)


def test_mcp_uses_membership_but_rejects_spoofed_actor(monkeypatch, membership_lookup):
    query, factory = membership_lookup
    query.first.return_value = SimpleNamespace(owner_user_id="owner")
    monkeypatch.setattr(db_helpers, "_get_authenticated_user_id", lambda _: "member")
    assert db_helpers.get_mcp_user_id() == "owner"
    assert db_helpers.get_mcp_user_id(user_id="member") == "owner"
    with pytest.raises(ValueError, match="does not match"):
        db_helpers.get_mcp_user_id(user_id="owner")
    assert factory.call_count == 2


def test_signed_request_cannot_supply_another_identity(membership_lookup):
    _, factory = membership_lookup
    token = db_helpers.set_request_user_id("member")
    try:
        with pytest.raises(HTTPException) as error:
            db_helpers.get_user_id(user_id="other")
        assert error.value.status_code == 403
        factory.assert_not_called()
    finally:
        db_helpers.clear_request_user_id(token)


def test_membership_lookup_failure_fails_closed(membership_lookup):
    query, _ = membership_lookup
    query.first.side_effect = RuntimeError("database unavailable")
    with pytest.raises(RuntimeError, match="database unavailable"):
        db_helpers.resolve_household_user_id("member")


def test_unauthenticated_request_never_resolves_membership(membership_lookup):
    _, factory = membership_lookup
    with pytest.raises(HTTPException) as error:
        db_helpers.get_user_id()
    assert error.value.status_code == 401
    factory.assert_not_called()
