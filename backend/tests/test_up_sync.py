"""Regression coverage for retry/error state without provider or DB writes."""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.routes.up import sync_connection
from tasks.up_tasks import sync_up_connection


def test_manual_retry_clears_old_error_before_task_is_published():
    connection = SimpleNamespace(id="connection", status="active", last_sync_error="Old error")
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = connection

    def publish(connection_id):
        assert connection_id == "connection"
        assert connection.last_sync_error is None
        db.commit.assert_called_once()
        return SimpleNamespace(id="job")

    with patch.object(sync_up_connection, "delay", side_effect=publish):
        assert sync_connection("connection", "owner", db)["task_id"] == "job"


def test_worker_clears_old_error_and_rolls_back_before_recording_new_failure():
    connection = SimpleNamespace(
        id="connection", user_id="owner", status="active", credentials_encrypted="ciphertext",
        sync_started_at=None, last_synced_at=None, last_sync_error="Old error",
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = connection
    db.query.return_value.filter.return_value.all.return_value = []

    def fail_request():
        assert connection.last_sync_error is None
        assert connection.sync_started_at is not None
        raise RuntimeError("Provider unavailable")

    def retry(*, exc):
        db.rollback.assert_called_once()
        assert connection.last_sync_error == "Provider unavailable"
        raise exc

    with patch("tasks.up_tasks.SessionLocal", return_value=db), \
         patch("tasks.up_tasks.decrypt_value", return_value="never-log-this"), \
         patch("tasks.up_tasks.SyncService"), \
         patch("tasks.up_tasks.UpAdapter") as adapter, \
         patch.object(sync_up_connection, "retry", side_effect=retry):
        adapter.return_value.fetch_accounts.side_effect = fail_request
        with pytest.raises(RuntimeError, match="Provider unavailable"):
            sync_up_connection.run("connection")
    assert connection.sync_started_at is None
    db.close.assert_called_once()


def test_archived_up_accounts_are_never_synced_even_if_an_old_mapping_remains():
    connection = SimpleNamespace(id="connection", user_id="owner", status="active", credentials_encrypted="ciphertext",
        sync_started_at=None, last_synced_at=None, last_sync_error=None, initial_sync_days=90)
    archived = SimpleNamespace(id="archived", user_id="owner", is_active=False, last_synced_at=None,
        balance_is_anchored=False, balance_available=None)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = connection
    query = db.query.return_value
    query.outerjoin.return_value = query
    query.filter.return_value = query
    query.distinct.return_value = query
    query.first.return_value = connection
    query.all.return_value = [archived]
    with patch("tasks.up_tasks.SessionLocal", return_value=db), \
         patch("tasks.up_tasks.decrypt_value", return_value="synthetic-token"), \
         patch("tasks.up_tasks.UpAdapter") as adapter, \
         patch("tasks.up_tasks.SyncService") as service, \
         patch("tasks.up_tasks.UpTransferLinkService") as transfers:
        adapter.return_value.fetch_accounts.return_value = []
        service.return_value.sync_transactions.return_value = (0, 0, [], [])
        transfers.return_value.link_explicit_transfers.return_value = 0
        sync_up_connection.run("connection")
        service.return_value.sync_transactions.assert_not_called()
