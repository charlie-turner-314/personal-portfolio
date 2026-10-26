"""Exact-provider-ID consolidation, with private original-history archives.

No names/balances are identity keys. Every source belongs to the actor and every
canonical target is currently shared with them. All mutations are one transaction;
incompatible relationship graphs fail closed and retain the original records.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import json
from uuid import UUID
from sqlalchemy import func, or_, text
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException
from app.models import (Account, AccountBalance, AccountOwner, AccountOwnershipAllocation,
    BankConnection, Transaction, TransactionLink, InternalTransfer, UpAccountSource, UpAccountReconciliation, User)
from app.security.data_encryption import decrypt_with_fallback
from app.services.financial_access import account_access
from app.services.up_account_lock import lock_up_accounts

ACCOUNT_FIELDS = {"id", "user_id", "name", "account_type", "currency", "provider", "balance_available",
    "starting_balance", "functional_balance", "balance_is_anchored", "is_active", "last_synced_at", "created_at", "updated_at"}
EDIT_FIELDS = ("amount", "currency", "description", "merchant", "creditor", "debtor", "booked_at",
    "transaction_type", "category_id", "property_id", "recurring_transaction_id", "categorization_instructions")


def _json(value):
    return json.loads(json.dumps(value, default=lambda v: v.isoformat() if isinstance(v, datetime) else str(v)))


def _row(value, fields=None):
    return _json({column.name: getattr(value, column.name) for column in value.__table__.columns
        if fields is None or column.name in fields})


def _identity(account):
    return decrypt_with_fallback(account.external_id_ciphertext, account.external_id)


def own_connection(db, actor_id, connection_id):
    connection = db.query(BankConnection).filter(BankConnection.id == connection_id,
        BankConnection.user_id == actor_id, BankConnection.provider == "up").first()
    if not connection:
        raise HTTPException(status_code=404, detail="Up connection not found")
    if connection.status not in ("active", "pending_setup"):
        raise HTTPException(status_code=400, detail="Reconnect this Up connection first")
    return connection


def joint_account_candidates(db, actor_id, connection_id):
    connection = own_connection(db, actor_id, connection_id)
    targets = db.query(Account).filter(account_access(Account.id, actor_id), Account.user_id != actor_id,
        Account.provider == "up", Account.is_active.is_(True)).order_by(Account.created_at, Account.id).all()
    originals = db.query(Account).filter(Account.user_id == actor_id, Account.provider == "up").all()
    result = []
    seen = set()
    for target in targets:
        identity = _identity(target)
        if not identity or identity in seen:
            continue
        seen.add(identity)
        sources = [account for account in originals if not account.consolidated_into_account_id
            and _identity(account) == identity and account.id != target.id]
        binding = db.query(UpAccountSource).filter(UpAccountSource.account_id == target.id,
            UpAccountSource.connection_id == connection.id).first()
        result.append({"account_id": str(target.id), "name": target.name, "currency": target.currency,
            "connected": binding is not None,
            "originals": [{"id": str(source.id), "name": source.name,
                "transactions": db.query(Transaction).filter(Transaction.account_id == source.id).count()} for source in sources]})
    return result


def _accounts(db, actor_id, pairs):
    if not pairs or len(pairs) > 100:
        raise HTTPException(status_code=400, detail="Choose between one and 100 joint imports")
    if len({str(pair["source_account_id"]) for pair in pairs}) != len(pairs):
        raise HTTPException(status_code=400, detail="Choose each original account only once")
    resolved = []
    for pair in pairs:
        source = db.query(Account).filter(Account.id == pair["source_account_id"], Account.user_id == actor_id).first()
        target = db.query(Account).filter(Account.id == pair["canonical_account_id"], account_access(Account.id, actor_id), Account.is_active.is_(True)).first()
        if not source or not target or source.provider != "up" or target.provider != "up" or source.id == target.id:
            raise HTTPException(status_code=404, detail="A permitted joint account was not found")
        if source.consolidated_into_account_id:
            if source.consolidated_into_account_id == target.id:
                continue
            raise HTTPException(status_code=409, detail="An original account has already been consolidated elsewhere; refresh the review")
        if not _identity(source) or _identity(source) != _identity(target) or source.currency != target.currency:
            raise HTTPException(status_code=400, detail="Only matching Up provider account identities and currencies can be consolidated")
        # Investment positions require a different accounting reconciliation.
        for table in ("holdings", "broker_trades", "super_accounts"):
            if db.execute(text(f'SELECT 1 FROM "{table}" WHERE account_id=:id LIMIT 1'), {"id": source.id}).first():
                raise HTTPException(status_code=409, detail="This import contains investment or super records and needs separate review; originals were retained")
        resolved.append((source, target))
    return resolved


def _plan(db, actor_id, pairs):
    accounts = _accounts(db, actor_id, pairs)
    target_transactions = {}
    for _, target in accounts:
        if target.id not in target_transactions:
            target_transactions[target.id] = {t.external_id: t for t in db.query(Transaction).filter(Transaction.account_id == target.id).all() if t.external_id}
    moves, duplicates, transaction_map, conflicts = [], [], {}, []
    by_source = {}
    for source, target in accounts:
        rows = db.query(Transaction).filter(Transaction.account_id == source.id).order_by(Transaction.created_at, Transaction.id).all()
        by_source[source.id] = rows
        for row in rows:
            existing = target_transactions[target.id].get(row.external_id) if row.external_id else None
            if existing:
                duplicates.append((row, existing))
                transaction_map[row.id] = existing.id
                different = [field for field in EDIT_FIELDS if getattr(row, field) is not None and getattr(existing, field) is not None and getattr(row, field) != getattr(existing, field)]
                if different:
                    conflicts.append({"transaction_id": str(row.id), "date": row.booked_at.isoformat(), "fields": different})
            else:
                moves.append((row, target))
                transaction_map[row.id] = row.id
                if row.external_id:
                    target_transactions[target.id][row.external_id] = row
    link_removals, transfer_removals, transfer_map, blocked = [], [], {}, []
    links = {link.transaction_id: link for link in db.query(TransactionLink).filter(TransactionLink.transaction_id.in_([*transaction_map, *transaction_map.values()])).all()} if transaction_map else {}
    for old, existing in duplicates:
        left, right = links.get(old.id), links.get(existing.id)
        if left and right:
            if left.group_id != right.group_id or left.link_role != right.link_role:
                blocked.append("Two copies have different transaction link groups")
            else:
                link_removals.append(left)
        if old.internal_transfer_id and existing.internal_transfer_id and old.internal_transfer_id != existing.internal_transfer_id:
            original = db.get(InternalTransfer, old.internal_transfer_id)
            canonical = db.get(InternalTransfer, existing.internal_transfer_id)
            def endpoints(transfer):
                return (transaction_map.get(transfer.source_txn_id, transfer.source_txn_id), transaction_map.get(transfer.mirror_txn_id, transfer.mirror_txn_id)) if transfer else None
            if original and canonical and endpoints(original) == endpoints(canonical):
                transfer_map[original.id] = canonical.id
                if original not in transfer_removals:
                    transfer_removals.append(original)
            else:
                blocked.append("Two copies have different internal-transfer relationships")
    return {"accounts": accounts, "by_source": by_source, "moves": moves, "duplicates": duplicates,
        "transaction_map": transaction_map, "conflicts": conflicts, "blocked": sorted(set(blocked)),
        "link_removals": link_removals, "transfer_removals": transfer_removals, "transfer_map": transfer_map}


def reconciliation_preview(db, actor_id, connection_id, pairs):
    own_connection(db, actor_id, connection_id)
    plan = _plan(db, actor_id, pairs)
    return {"accounts": [{"source_account_id": str(source.id), "source_name": source.name,
        "canonical_account_id": str(target.id), "canonical_name": target.name,
        "original_transactions": len(plan["by_source"][source.id]), "currency": target.currency} for source, target in plan["accounts"]],
        "transactions_to_move": len(plan["moves"]), "provider_duplicates": len(plan["duplicates"]),
        "conflicts": plan["conflicts"], "blocked": plan["blocked"]}


def _references(db, target):
    return db.execute(text("""SELECT kcu.table_name,kcu.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
        WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND ccu.table_schema='public'
          AND ccu.table_name=:target AND ccu.column_name='id'"""), {"target": target}).all()


def _remap(db, references, old_id, new_id, skip=()):
    quote = db.bind.dialect.identifier_preparer.quote
    for table, column in references:
        if table in skip:
            continue
        db.execute(text(f'UPDATE {quote(table)} SET {quote(column)}=:new WHERE {quote(column)}=:old'), {"old": old_id, "new": new_id})


def _snapshot(db, account, canonical=False):
    rows = db.query(Transaction).filter(Transaction.account_id == account.id).all()
    ids = [row.id for row in rows]
    return {"account": _row(account, ACCOUNT_FIELDS if canonical else None), "transactions": [_row(row) for row in rows],
        "owners": [_row(row) for row in db.query(AccountOwner).filter(AccountOwner.account_id == account.id).all()],
        "ownership_history": [_row(row) for row in db.query(AccountOwnershipAllocation).filter(AccountOwnershipAllocation.account_id == account.id).all()],
        "balances": [_row(row) for row in db.query(AccountBalance).filter(AccountBalance.account_id == account.id).all()],
        "property_links": _json([dict(row) for row in db.execute(text("SELECT * FROM property_liability_links WHERE account_id=:id"), {"id": account.id}).mappings().all()]),
        "transaction_links": [_row(row) for row in db.query(TransactionLink).filter(TransactionLink.transaction_id.in_(ids)).all()] if ids else [],
        "internal_transfers": [_row(row) for row in db.query(InternalTransfer).filter(or_(InternalTransfer.source_account_id == account.id, InternalTransfer.pocket_account_id == account.id)).all()]}


def consolidate_accounts(db, actor_id, connection_id, pairs, conflict_strategy=None):
    connection = own_connection(db, actor_id, connection_id)
    if conflict_strategy not in (None, "keep_shared", "keep_mine"):
        raise HTTPException(status_code=400, detail="Choose which conflicting edits to keep")
    try:
        # Same lock order as sync workers: account locks, then consent lock.
        account_ids = [pair[key] for pair in pairs for key in ("source_account_id", "canonical_account_id")]
        lock_up_accounts(db, account_ids)
        db.execute(text("SELECT pg_advisory_xact_lock(73194, 1)"))
        db.query(Account).filter(Account.id.in_(account_ids)).order_by(Account.id).with_for_update().all()
        transaction_ids = [row.id for row in db.query(Transaction.id).filter(Transaction.account_id.in_(account_ids)).order_by(Transaction.id).with_for_update().all()]
        if transaction_ids:
            db.query(TransactionLink).filter(TransactionLink.transaction_id.in_(transaction_ids)).order_by(TransactionLink.id).with_for_update().all()
            db.query(InternalTransfer).filter(or_(InternalTransfer.source_txn_id.in_(transaction_ids), InternalTransfer.mirror_txn_id.in_(transaction_ids))).order_by(InternalTransfer.id).with_for_update().all()
        plan = _plan(db, actor_id, pairs)
        if plan["blocked"]:
            raise HTTPException(status_code=409, detail="Resolve conflicting transaction links before consolidation; original records were retained")
        if plan["conflicts"] and conflict_strategy is None:
            raise HTTPException(status_code=409, detail="Review the conflicting edits and choose which copy to keep; original records were retained")
        receipts = []
        for source, target in plan["accounts"]:
            receipt = UpAccountReconciliation(actor_user_id=actor_id, source_account_id=source.id, canonical_account_id=target.id,
                source_snapshot=_snapshot(db, source), canonical_snapshot=_snapshot(db, target, canonical=True),
                result={"conflict_strategy": conflict_strategy, "original_connection_id": str(source.bank_connection_id) if source.bank_connection_id else None})
            db.add(receipt); db.flush(); receipts.append(receipt)
        transaction_references = _references(db, "transactions")
        account_references = _references(db, "accounts")
        transfer_references = _references(db, "internal_transfers")
        for link in plan["link_removals"]:
            db.delete(link)
        db.flush()
        for old, new in plan["transfer_map"].items():
            _remap(db, transfer_references, old, new)
        for transfer in plan["transfer_removals"]:
            db.delete(transfer)
        db.flush()
        for original, existing in plan["duplicates"]:
            for field in EDIT_FIELDS:
                incoming, current = getattr(original, field), getattr(existing, field)
                if incoming is not None and (current is None or conflict_strategy == "keep_mine"):
                    setattr(existing, field, incoming)
            if existing.category_id == original.category_id and original.category_id:
                existing.category_verified_at = original.category_verified_at or existing.category_verified_at
            if not existing.category_system_id:
                existing.category_system_id = original.category_system_id
                existing.category_confidence = original.category_confidence
            existing.include_in_analytics = bool(existing.include_in_analytics and original.include_in_analytics)
            if not existing.internal_transfer_id:
                existing.internal_transfer_id = original.internal_transfer_id
            existing.enrichment_data = {**(original.enrichment_data or {}), **(existing.enrichment_data or {})} or None
            db.flush()
            _remap(db, transaction_references, original.id, existing.id)
            db.delete(original)
            db.flush()
        for row, target in plan["moves"]:
            row.account_id = target.id
            row.user_id = target.user_id
        db.flush()
        for source, target in plan["accounts"]:
            # Keep historical ownership and balance rows on the archived original;
            # copy missing daily balances without overwriting an existing anchor.
            source_owner, target_owner = db.get(User, source.user_id), db.get(User, target.user_id)
            same_functional = (source_owner.functional_currency or "EUR") == (target_owner.functional_currency or "EUR")
            if same_functional:
                for balance in db.query(AccountBalance).filter(AccountBalance.account_id == source.id).all():
                    if not db.query(AccountBalance.id).filter(AccountBalance.account_id == target.id, AccountBalance.date == balance.date).first():
                        db.add(AccountBalance(account_id=target.id, date=balance.date, balance_source=balance.balance_source, account_currency=balance.account_currency, functional_currency=balance.functional_currency, balance_in_account_currency=balance.balance_in_account_currency, balance_in_functional_currency=balance.balance_in_functional_currency))
            db.execute(text("DELETE FROM property_liability_links old WHERE old.account_id=:source AND EXISTS (SELECT 1 FROM property_liability_links kept WHERE kept.account_id=:target AND kept.property_id=old.property_id)"), {"source":source.id,"target":target.id})
            _remap(db, account_references, source.id, target.id, skip=("transactions", "account_balances", "account_balance_revisions", "account_owners", "account_ownership_allocations", "up_account_sources", "up_account_reconciliations", "household_account_shares"))
            # A duplicate property/account association represents the same link, not
            # a second mortgage. Other uniqueness conflicts roll back the batch.
            bindings = db.query(UpAccountSource).filter(UpAccountSource.account_id == source.id).all()
            for binding in bindings:
                private_connection = db.get(BankConnection, binding.connection_id)
                permitted = private_connection and db.query(Account.id).filter(Account.id == target.id, account_access(Account.id, private_connection.user_id)).first()
                if permitted and not db.query(UpAccountSource).filter(UpAccountSource.connection_id == binding.connection_id, UpAccountSource.account_id == target.id).first():
                    db.add(UpAccountSource(connection_id=binding.connection_id, account_id=target.id, last_synced_at=binding.last_synced_at))
                db.delete(binding)
            db.flush()
            if not db.query(UpAccountSource).filter(UpAccountSource.connection_id == connection.id, UpAccountSource.account_id == target.id).first():
                db.add(UpAccountSource(connection_id=connection.id, account_id=target.id, last_synced_at=source.last_synced_at))
            def newest(account):
                value = account.last_synced_at or account.updated_at or account.created_at or datetime.min
                return value.replace(tzinfo=None) if value.tzinfo else value
            anchor = source if source.balance_is_anchored and source.balance_available is not None and (not target.balance_is_anchored or newest(source) > newest(target)) else target
            if anchor.balance_is_anchored and anchor.balance_available is not None:
                if anchor is source and source.last_synced_at:
                    target.last_synced_at = source.last_synced_at
                target.balance_available = anchor.balance_available
                target.balance_is_anchored = True
                total = db.query(func.sum(Transaction.amount)).filter(Transaction.account_id == target.id).scalar() or Decimal("0")
                target.starting_balance = Decimal(anchor.balance_available) - Decimal(total)
                if anchor is target or same_functional:
                    target.functional_balance = anchor.functional_balance if anchor.functional_balance is not None else anchor.balance_available
                else:
                    from app.services.exchange_rate_service import ExchangeRateService
                    converted = ExchangeRateService(db=db).convert_amount(Decimal(anchor.balance_available), target.currency, target_owner.functional_currency or "EUR", datetime.now(timezone.utc).date())
                    if converted is None:
                        raise HTTPException(status_code=409, detail="Currency conversion is unavailable; original records were retained")
                    target.functional_balance = converted
            source.is_active = False
            source.consolidated_into_account_id = target.id
            source.bank_connection_id = None
            db.flush()
        for receipt in receipts:
            receipt.result = {**receipt.result, "moved": len(plan["moves"]), "deduplicated": len(plan["duplicates"])}
        db.commit()
        return {"accounts_consolidated": len(plan["accounts"]), "transactions_moved": len(plan["moves"]),
            "provider_duplicates_removed": len(plan["duplicates"]), "archives": [str(receipt.id) for receipt in receipts]}
    except HTTPException:
        db.rollback(); raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Linked records need review before consolidation; all original records were retained") from None


def set_joint_source(db, actor_id, connection_id, account_id, enabled):
    db.execute(text("SELECT pg_advisory_xact_lock(73194, 1)"))
    connection = own_connection(db, actor_id, connection_id)
    account = db.query(Account).filter(Account.id == account_id, account_access(Account.id, actor_id), Account.provider == "up", Account.is_active.is_(True)).first()
    if not account or not _identity(account):
        raise HTTPException(status_code=404, detail="A permitted Up account was not found")
    existing = db.query(UpAccountSource).filter(UpAccountSource.connection_id == connection.id, UpAccountSource.account_id == account.id).first()
    if enabled:
        originals = db.query(Account).filter(Account.user_id == actor_id, Account.provider == "up", Account.id != account.id, Account.consolidated_into_account_id.is_(None)).all()
        if any(_identity(original) == _identity(account) and (original.is_active or db.query(Transaction.id).filter(Transaction.account_id == original.id).first()) for original in originals):
            raise HTTPException(status_code=409, detail="Preview and consolidate your original joint import before adding this shared source")
        if existing is None:
            db.add(UpAccountSource(connection_id=connection.id, account_id=account.id))
    else:
        if existing:
            db.delete(existing)
        if account.bank_connection_id == connection.id and account.user_id == actor_id:
            account.bank_connection_id = None
    db.flush()
    return {"connected": enabled, "account_id": str(account.id)}


def private_archives(db, actor_id):
    rows = db.query(UpAccountReconciliation).filter(or_(
        UpAccountReconciliation.actor_user_id == actor_id,
        UpAccountReconciliation.canonical_snapshot["account"]["user_id"].astext == actor_id,
    )).order_by(UpAccountReconciliation.created_at.desc()).limit(100).all()
    return [{"id": str(row.id), "name": (row.source_snapshot if row.actor_user_id == actor_id else row.canonical_snapshot)["account"]["name"],
        "created_at": row.created_at.isoformat()} for row in rows]


def private_archive(db, actor_id, receipt_id):
    row = db.get(UpAccountReconciliation, receipt_id)
    if not row:
        raise HTTPException(status_code=404, detail="Consolidation archive not found")
    sections = {}
    if row.actor_user_id == actor_id:
        sections["original_import"] = row.source_snapshot
    if row.canonical_snapshot["account"]["user_id"] == actor_id:
        sections["shared_account_before_consolidation"] = row.canonical_snapshot
    if not sections:
        raise HTTPException(status_code=404, detail="Consolidation archive not found")
    # Archives retain exact server-side originals. Downloads expose only the
    # caller's own record sections, never another person's connection credentials.
    return {"id": str(row.id), "created_at": row.created_at.isoformat(), **sections}
