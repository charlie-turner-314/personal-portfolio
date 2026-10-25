"""Explicit, user-scoped snapshots of accepted decisions for retrieval/evaluation."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import inspect, text

from app.models import Account, Category, InternalTransfer, Transaction
from app.services.categorization_context import transaction_record


def read_snapshot(path, user_id=None):
    path = Path(path)
    if path.stat().st_size > 50_000_000:
        raise ValueError("Snapshot exceeds size limit")
    data = json.loads(path.read_text())
    if data.get("version") != 1 or (user_id is not None and data.get("user_id") != user_id):
        raise ValueError("Snapshot version/user mismatch")
    if not isinstance(data.get("examples"), list):
        raise ValueError("Missing verified examples")
    for row in data["examples"]:
        UUID(str(row["id"]))
        UUID(str(row["category_id"]))
        if row.get("provenance") not in {"manual_category", "trusted_snapshot"} or not row.get("verified_at"):
            raise ValueError("Example has no verification provenance")
    return data


def export_snapshot(db, user_id, path, *, trust_current_labels=False):
    """Read-only export; trust_current_labels is an explicit whole-history attestation.

    Use a fresh session: setting READ ONLY must precede all other DB operations.
    The output is sensitive local data, created exclusively with mode 0600.
    """
    db.execute(text("SET TRANSACTION READ ONLY"))
    now = datetime.now(timezone.utc).isoformat()
    categories = db.query(Category).filter(Category.user_id == user_id).all()
    accounts = db.query(Account).filter(Account.user_id == user_id, Account.is_active.is_(True)).all()
    # Export can run before rollout/migration: select only the fields present in
    # the source schema rather than requiring the new verification column.
    available = {column["name"] for column in inspect(db.connection()).get_columns("transactions")}
    fields = [name for name in (*transaction_record(SimpleNamespace()).keys(), "internal_transfer_id") if name in available]
    result = db.query(*(getattr(Transaction, name) for name in fields)).filter(
        Transaction.user_id == user_id, Transaction.pending.is_(False),
    ).order_by(Transaction.booked_at, Transaction.id).all()
    rows = [SimpleNamespace(**{"category_verified_at": None, "internal_transfer_id": None, **dict(zip(fields, row))}) for row in result]
    category_ids = {str(cat.id) for cat in categories}
    active_accounts = {str(acc.id) for acc in accounts}
    mirrors = {str(row[0]) for row in db.query(InternalTransfer.mirror_txn_id).filter(
        InternalTransfer.user_id == user_id, InternalTransfer.mirror_txn_id.isnot(None),
    ).all()}
    examples, transactions = [], []
    for tx in rows:
        row = transaction_record(tx)
        # Candidate metadata contains NO accepted/rejected labels or guidance.
        metadata = {key: value for key, value in row.items() if key not in {"category_id", "category_system_id", "category_verified_at", "categorization_instructions"}}
        if str(tx.account_id) in active_accounts and tx.internal_transfer_id is None and str(tx.id) not in mirrors:
            transactions.append(metadata)
        is_manual = tx.category_id and (tx.category_verified_at or tx.category_system_id is None or tx.category_id != tx.category_system_id)
        accepted = (tx.category_id or tx.category_system_id) if trust_current_labels else (tx.category_id if is_manual else None)
        if accepted and str(accepted) in category_ids:
            examples.append({**row, "category_id": accepted,
                             "verified_at": now if trust_current_labels else (tx.category_verified_at or tx.updated_at),
                             "provenance": "trusted_snapshot" if trust_current_labels else "manual_category"})
    data = {
        "version": 1, "user_id": user_id, "snapshot_at": now,
        "trust_current_labels": trust_current_labels,
        "categories": [{"id": str(c.id), "name": c.name, "category_type": c.category_type,
                        "description": c.description, "categorization_instructions": c.categorization_instructions} for c in categories],
        "accounts": [{"id": str(a.id), "name": a.name, "alias_patterns": a.alias_patterns,
                      "account_type": a.account_type, "currency": a.currency, "institution": a.institution} for a in accounts],
        "examples": examples, "transactions": transactions,
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Never overwrite an earlier verification snapshot or evaluation artifact.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(data, stream, default=str, ensure_ascii=False)
    return {"examples": len(examples), "transactions": len(transactions), "categories": len(categories)}
