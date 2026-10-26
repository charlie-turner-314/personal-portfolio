"""Smoke tests for the OAuth 2.0 Protected Resource Metadata endpoint."""

import sys
import re
from urllib.parse import urlparse
from pathlib import Path

import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# mcp_server.app is the ASGI app exposed by mcp.http_app()
from mcp_server import app  # noqa: E402
from app.mcp.auth import AS_ISSUER  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)


def test_protected_resource_metadata_exposed(client):
    challenge = client.post(
        "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    )
    assert challenge.status_code == 401
    advertised = re.search(
        r'resource_metadata="([^"]+)"', challenge.headers.get("www-authenticate", "")
    )
    assert advertised, "The challenge must advertise discoverable resource metadata"
    # A resource at /mcp may use a path-specific metadata document. Follow the
    # challenge rather than assuming a root well-known route exists.
    metadata_url = urlparse(advertised.group(1))
    resp = client.get(
        metadata_url.path + ("?" + metadata_url.query if metadata_url.query else "")
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "authorization_servers" in body
    servers = body["authorization_servers"]
    assert any(str(s).rstrip("/") == AS_ISSUER.rstrip("/") for s in servers), body


def test_unauthenticated_request_returns_401_with_www_authenticate(client):
    resp = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert resp.status_code == 401
    www_auth = resp.headers.get("www-authenticate", "")
    assert "Bearer" in www_auth
    assert "resource_metadata" in www_auth
