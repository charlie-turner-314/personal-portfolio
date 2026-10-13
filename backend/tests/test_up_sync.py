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
