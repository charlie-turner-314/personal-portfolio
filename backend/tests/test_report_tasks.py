"""Tests for report Celery tasks.

Run with:
    cd backend && .venv/bin/pytest tests/test_report_tasks.py -v
"""
from __future__ import annotations

import base64
import json
import os
import sys
import uuid
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _set_test_env() -> None:
    key = base64.urlsafe_b64encode(b"p" * 32).decode("utf-8").rstrip("=")
    os.environ["DATA_ENCRYPTION_KEY_CURRENT"] = key
    os.environ["DATA_ENCRYPTION_KEY_ID"] = "k-test-report-tasks"
    os.environ.pop("DATA_ENCRYPTION_KEY_PREVIOUS", None)


_set_test_env()

from app.database import SessionLocal  # noqa: E402
from app.models import Report, ReportRun, User  # noqa: E402
from tasks import report_tasks  # noqa: E402


def _seed_due_report(db) -> Report:
    user = User(id=f"test-user-{uuid.uuid4()}", email=f"{uuid.uuid4()}@example.com", name="Test")
    db.add(user)
    db.flush()
    report = Report(
        user_id=user.id,
        name="Daily",
        frequency="DAILY",
        recipient_emails=["me@example.com"],
        is_active=True,
        next_run_at=datetime.utcnow() - timedelta(minutes=1),
    )
    db.add(report)
    db.flush()
    return report


def _cleanup_user(db, user_id: str) -> None:
    """Delete the seeded user (cascades to reports/report_runs via FK).

    Without this, tests that db.commit() their seed data leave rows behind
    in the shared dev Postgres across every test run, which makes
    test_check_due_reports_enqueues_and_reschedules flaky (it counts
    .delay() calls across ALL due reports, including stale ones from
    earlier runs).
    """
    db.rollback()
    db.query(User).filter(User.id == user_id).delete()
    db.commit()


def test_check_due_reports_enqueues_and_reschedules():
    db = SessionLocal()
    user_id = None
    try:
        report = _seed_due_report(db)
        user_id = report.user_id
        db.commit()

        with patch.object(report_tasks.send_report_run, "delay") as mock_delay:
            report_tasks.check_due_reports()

        db.refresh(report)
        assert report.next_run_at > datetime.utcnow()
        mock_delay.assert_called_once()

        runs = db.query(ReportRun).filter(ReportRun.report_id == report.id).all()
        assert len(runs) >= 1
    finally:
        if user_id:
            _cleanup_user(db, user_id)
        db.rollback()
        db.close()


def test_send_report_run_success_marks_succeeded():
    db = SessionLocal()
    user_id = None
    try:
        report = _seed_due_report(db)
        user_id = report.user_id
        run = ReportRun(report_id=report.id, status="SCHEDULED", recipient_emails=report.recipient_emails)
        db.add(run)
        db.commit()
        run_id = str(run.id)

        fake_render = MagicMock(returncode=0, stdout='{"html": "<p>hi</p>", "text": "hi"}', stderr="")
        mock_adapter = MagicMock()
        with patch.object(report_tasks.subprocess, "run", return_value=fake_render), \
             patch.object(report_tasks, "get_mail_adapter", return_value=mock_adapter):
            report_tasks.send_report_run(run_id)

        db.refresh(run)
        assert run.status == "SUCCEEDED"
        assert run.finished_at is not None
        mock_adapter.send.assert_called_once()
    finally:
        if user_id:
            _cleanup_user(db, user_id)
        db.rollback()
        db.close()


def test_send_report_run_sets_real_manage_url():
    db = SessionLocal()
    user_id = None
    try:
        report = _seed_due_report(db)
        user_id = report.user_id
        run = ReportRun(report_id=report.id, status="SCHEDULED", recipient_emails=report.recipient_emails)
        db.add(run)
        db.commit()
        run_id = str(run.id)

        fake_render = MagicMock(returncode=0, stdout='{"html": "<p>hi</p>", "text": "hi"}', stderr="")
        mock_adapter = MagicMock()
        with patch.dict(os.environ, {"FRONTEND_URL": "https://app.example.com"}), \
             patch.object(report_tasks.subprocess, "run", return_value=fake_render) as mock_run, \
             patch.object(report_tasks, "get_mail_adapter", return_value=mock_adapter):
            report_tasks.send_report_run(run_id)

        mock_run.assert_called_once()
        sent_input = mock_run.call_args.kwargs["input"]
        payload = json.loads(sent_input)
        assert payload["manage_url"] == f"https://app.example.com/reports/{report.id}"
    finally:
        if user_id:
            _cleanup_user(db, user_id)
        db.rollback()
        db.close()


def test_send_report_run_failure_marks_failed_without_raising():
    db = SessionLocal()
    user_id = None
    try:
        report = _seed_due_report(db)
        user_id = report.user_id
        run = ReportRun(report_id=report.id, status="SCHEDULED", recipient_emails=report.recipient_emails)
        db.add(run)
        db.commit()
        run_id = str(run.id)

        fake_render = MagicMock(returncode=0, stdout='{"html": "<p>hi</p>", "text": "hi"}', stderr="")
        with patch.object(report_tasks.subprocess, "run", return_value=fake_render), \
             patch.object(report_tasks, "get_mail_adapter", side_effect=RuntimeError("no provider")):
            report_tasks.send_report_run(run_id)  # must not raise

        db.refresh(run)
        assert run.status == "FAILED"
        assert "no provider" in run.error_message
    finally:
        if user_id:
            _cleanup_user(db, user_id)
        db.rollback()
        db.close()


def test_send_report_run_db_failure_during_transition_does_not_raise():
    db = SessionLocal()
    user_id = None
    try:
        report = _seed_due_report(db)
        user_id = report.user_id
        run = ReportRun(report_id=report.id, status="SCHEDULED", recipient_emails=report.recipient_emails)
        db.add(run)
        db.commit()
        run_id = str(run.id)

        from sqlalchemy.orm import Session as SASession

        real_commit = SASession.commit
        call_count = {"n": 0}

        def flaky_commit(self):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("db unavailable")
            return real_commit(self)

        with patch.object(SASession, "commit", flaky_commit):
            report_tasks.send_report_run(run_id)  # must not raise

        db.rollback()
        db.refresh(run)
        assert run.status == "FAILED"
        assert "db unavailable" in (run.error_message or "")
    finally:
        if user_id:
            _cleanup_user(db, user_id)
        db.rollback()
        db.close()


def _seed_shared_report(db):
    from decimal import Decimal
    from app.models import (
        Account,
        AccountOwnershipAllocation,
        HouseholdAccountShare,
        HouseholdMembership,
        Person,
    )

    owner = User(id=f"queue-owner-{uuid.uuid4()}", email=f"{uuid.uuid4()}@example.test")
    reader = User(
        id=f"queue-reader-{uuid.uuid4()}", email=f"{uuid.uuid4()}@example.test"
    )
    db.add_all([owner, reader])
    db.flush()
    op = Person(user_id=owner.id, name="Owner", kind="self")
    rp = Person(
        user_id=owner.id, name="Reader", kind="member", linked_user_id=reader.id
    )
    db.add_all([op, rp])
    db.flush()
    db.add(
        HouseholdMembership(
            member_user_id=reader.id, owner_user_id=owner.id, person_id=rp.id
        )
    )
    account = Account(
        user_id=owner.id,
        name="Joint",
        account_type="checking",
        currency="EUR",
        functional_balance=Decimal(100),
    )
    db.add(account)
    db.flush()
    db.add(
        HouseholdAccountShare(
            account_id=account.id, member_user_id=reader.id, granted_by_user_id=owner.id
        )
    )
    db.add_all(
        [
            AccountOwnershipAllocation(
                account_id=account.id,
                person_id=op.id,
                effective_from=datetime(2000, 1, 1).date(),
                share=Decimal("0.5"),
            ),
            AccountOwnershipAllocation(
                account_id=account.id,
                person_id=rp.id,
                effective_from=datetime(2000, 1, 1).date(),
                share=Decimal("0.5"),
            ),
        ]
    )
    report = Report(
        user_id=reader.id,
        name="Queue",
        account_ids=[str(account.id)],
        frequency="WEEKLY",
        recipient_emails=["old@example.test"],
        is_active=True,
    )
    db.add(report)
    db.flush()
    run = ReportRun(
        report_id=report.id,
        status="SCHEDULED",
        recipient_emails=report.recipient_emails,
    )
    db.add(run)
    db.commit()
    return [owner.id, reader.id], account.id, report.id, run.id


def _cleanup_shared_report(db, users):
    db.rollback()
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
    db.commit()


def test_revocation_during_render_prevents_delivery():
    from app.models import HouseholdAccountShare

    db = SessionLocal()
    users = []
    try:
        users, account_id, _, run_id = _seed_shared_report(db)

        def revoke(*args, **kwargs):
            with SessionLocal() as change:
                change.query(HouseholdAccountShare).filter_by(
                    account_id=account_id
                ).delete()
                change.commit()
            return MagicMock(
                returncode=0,
                stdout='{"html":"old financial copy","text":"old financial copy"}',
                stderr="",
            )

        adapter = MagicMock()
        with patch.object(
            report_tasks.subprocess, "run", side_effect=revoke
        ), patch.object(report_tasks, "get_mail_adapter", return_value=adapter):
            report_tasks.send_report_run(str(run_id))
        db.expire_all()
        run = db.get(ReportRun, run_id)
        assert run.status == "FAILED" and "no longer available" in run.error_message
        adapter.send.assert_not_called()
    finally:
        if users:
            _cleanup_shared_report(db, users)
        db.close()


def test_queued_household_departure_denies_before_render():
    from app.models import HouseholdMembership

    db = SessionLocal()
    users = []
    try:
        users, _, _, run_id = _seed_shared_report(db)
        db.query(HouseholdMembership).filter_by(member_user_id=users[1]).delete()
        db.commit()
        adapter = MagicMock()
        with patch.object(report_tasks.subprocess, "run") as render, patch.object(
            report_tasks, "get_mail_adapter", return_value=adapter
        ):
            report_tasks.send_report_run(str(run_id))
        db.expire_all()
        assert db.get(ReportRun, run_id).status == "FAILED"
        render.assert_not_called()
        adapter.send.assert_not_called()
    finally:
        if users:
            _cleanup_shared_report(db, users)
        db.close()


def test_recipients_are_refreshed_after_render_and_stale_financial_values_are_rejected():
    from app.models import Account
    from decimal import Decimal

    db = SessionLocal()
    users = []
    try:
        users, account_id, report_id, run_id = _seed_shared_report(db)

        def replace_recipient(*args, **kwargs):
            with SessionLocal() as change:
                change.query(Report).filter_by(id=report_id).update(
                    {"recipient_emails": ["current@example.test"]}
                )
                change.commit()
            return MagicMock(
                returncode=0, stdout='{"html":"safe","text":"safe"}', stderr=""
            )

        adapter = MagicMock()
        with patch.object(
            report_tasks.subprocess, "run", side_effect=replace_recipient
        ), patch.object(report_tasks, "get_mail_adapter", return_value=adapter):
            report_tasks.send_report_run(str(run_id))
        adapter.send.assert_called_once()
        assert adapter.send.call_args.kwargs["to"] == ["current@example.test"]
        other = ReportRun(
            report_id=report_id,
            status="SCHEDULED",
            recipient_emails=["current@example.test"],
        )
        db.add(other)
        db.commit()
        other_id = other.id

        def change_balance(*args, **kwargs):
            with SessionLocal() as change:
                change.query(Account).filter_by(id=account_id).update(
                    {"functional_balance": Decimal(200)}
                )
                change.commit()
            return MagicMock(
                returncode=0, stdout='{"html":"stale","text":"stale"}', stderr=""
            )

        adapter.reset_mock()
        with patch.object(
            report_tasks.subprocess, "run", side_effect=change_balance
        ), patch.object(report_tasks, "get_mail_adapter", return_value=adapter):
            report_tasks.send_report_run(str(other_id))
        db.expire_all()
        assert db.get(ReportRun, other_id).status == "FAILED"
        adapter.send.assert_not_called()
    finally:
        if users:
            _cleanup_shared_report(db, users)
        db.close()
