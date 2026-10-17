"""Persist explicitly routed CSV rows, with atomic, idempotent transfer pairs."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import text, or_

from app.models import Account, Category, InternalTransfer, Transaction
from app.services.category_matcher import CategoryMatcher


def import_routed_rows(db, user_id, rows, csv_import_id):
    inserted = []
    matcher = CategoryMatcher(db, user_id=str(user_id))
    deterministic = 0
    skipped = 0
    # Serialize imports for this user, including overlapping files and worker retries.
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"csv:{user_id}"})
    account_ids = {row["account_id"] for row in rows}
    account_ids.update(row["destination_account_id"] for row in rows if row.get("destination_account_id"))
    owned = db.query(Account).filter(Account.user_id == user_id, Account.id.in_(account_ids)).all()
    accounts = {str(account.id): account for account in owned}
    if account_ids - accounts.keys():
        raise ValueError("Mapped account is unavailable")

    for row in rows:
        amount = Decimal(str(row["amount"]))
        if not amount.is_finite() or amount == 0 or not row.get("external_id"):
            raise ValueError("Invalid routed CSV amount or identity")
        source_id = row["account_id"]
        destination_id = row.get("destination_account_id")
        currency = accounts[source_id].currency
        if destination_id and (destination_id == source_id or accounts[destination_id].currency != currency):
            raise ValueError("Transfer requires distinct accounts with matching currencies")
        booked_at = datetime.fromisoformat(row["booked_at"].replace("Z", "+00:00"))
        external_id = row["external_id"]
        source = db.query(Transaction).filter(Transaction.user_id == user_id, Transaction.account_id == source_id, Transaction.external_id == external_id).first()
        if source:
            if source.amount != (-abs(amount) if destination_id else amount) or source.currency != currency:
                raise ValueError("Bank reference conflicts with an existing transaction; review the CSV")
            if destination_id:
                link = db.query(InternalTransfer).filter(InternalTransfer.source_txn_id == source.id, InternalTransfer.user_id == user_id).first()
                if not link or str(link.pocket_account_id) != destination_id:
                    raise ValueError("This bank reference was imported with different account routing; revert the earlier import before changing it")
            elif source.internal_transfer_id:
                raise ValueError("This bank reference is already an internal transfer; revert the earlier import before changing it")
            skipped += 1
            continue

        category_id = row.get("category_id")
        if category_id and not destination_id:
            category = db.query(Category).filter(Category.id == category_id, Category.user_id == user_id).first()
            if not category:
                raise ValueError("Mapped category is unavailable")

        def make_transaction(account_id, value, identity):
            nonlocal deterministic
            transaction = Transaction(
                user_id=user_id, account_id=account_id, external_id=identity,
                amount=value, currency=currency, booked_at=booked_at,
                description=row.get("description"), merchant=row.get("merchant"),
                transaction_type="credit" if value > 0 else "debit",
                include_in_analytics=not bool(destination_id), pending=False,
                csv_import_id=UUID(csv_import_id),
            )
            if not destination_id:
                if category_id:
                    transaction.category_id = category_id
                else:
                    category = matcher.match_category(
                        description=transaction.description, merchant=transaction.merchant,
                        amount=value, transaction_type=transaction.transaction_type, use_llm=False,
                    )
                    if category:
                        transaction.category_system_id = category.id
                        deterministic += 1
            db.add(transaction)
            db.flush()
            inserted.append(transaction)
            return transaction

        # Older single-account/API imports use different identities. Never add a
        # second accounting entry over a matching existing leg; require review.
        legs = [(source_id, -abs(amount) if destination_id else amount)]
        if destination_id:
            legs.append((destination_id, abs(amount)))
        for account_id, value in legs:
            overlap = db.query(Transaction).filter(
                Transaction.user_id == user_id, Transaction.account_id == account_id,
                Transaction.amount == value, Transaction.booked_at == booked_at,
                Transaction.description == row.get("description"),
                or_(Transaction.external_id.is_(None), ~Transaction.external_id.like("csv-multi-%")),
            ).first()
            if overlap:
                raise ValueError("CSV overlaps existing transactions; review or revert the earlier import before importing multiple accounts")

        source = make_transaction(source_id, -abs(amount) if destination_id else amount, external_id)
        if destination_id:
            destination = make_transaction(destination_id, abs(amount), f"{external_id}:credit")
            link = InternalTransfer(
                user_id=user_id, source_txn_id=source.id, mirror_txn_id=destination.id,
                source_account_id=source.account_id, pocket_account_id=destination.account_id,
                amount=abs(amount), currency=currency,
            )
            db.add(link)
            db.flush()
            source.internal_transfer_id = link.id
            destination.internal_transfer_id = link.id
    db.commit()
    eligible = [txn for txn in inserted if txn.include_in_analytics]
    categorized = sum(bool(txn.category_id or txn.category_system_id) for txn in eligible)
    summary = {"total": len(eligible), "categorized": categorized,
               "deterministic": deterministic, "llm": 0,
               "uncategorized": len(eligible) - categorized, "tokens_used": 0, "cost_usd": 0.0}
    return {"inserted_count": len(inserted), "skipped_count": skipped,
            "inserted_transactions": inserted, "categorization_summary": summary}
