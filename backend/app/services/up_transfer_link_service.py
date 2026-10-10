"""Link the two sides of explicit Up account transfers.

Up supplies the related account ID for a transfer.  It does not supply the
counterpart transaction ID, so this service only links a pair where exactly
one opposite-side transaction is present.  Ambiguous cases are deliberately
left untouched for the user instead of guessing.
"""
from __future__ import annotations

from collections import defaultdict
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models import Account, Transaction, TransactionLink
from app.security.data_encryption import decrypt_with_fallback


class UpTransferLinkService:
    def __init__(self, db: Session, user_id: str):
        self.db = db
        self.user_id = user_id

    @staticmethod
    def _related_account_id(transaction: Transaction) -> str | None:
        provider = (transaction.enrichment_data or {}).get("provider") or {}
        value = provider.get("transfer_account_external_id")
        return value if isinstance(value, str) and value else None

    def link_explicit_transfers(self) -> int:
        """Create zero-sum link groups for unambiguous Up transfer pairs."""
        accounts = (
            self.db.query(Account)
            .filter(Account.user_id == self.user_id, Account.provider == "up")
            .all()
        )
        by_external_id = {
            external_id: account
            for account in accounts
            if (external_id := decrypt_with_fallback(account.external_id_ciphertext, account.external_id))
        }
        if not by_external_id:
            return 0

        linked_ids = {
            transaction_id
            for (transaction_id,) in self.db.query(TransactionLink.transaction_id)
            .filter(TransactionLink.user_id == self.user_id)
            .all()
        }
        transactions_by_account: dict[object, list[Transaction]] = defaultdict(list)
        candidates = (
            self.db.query(Transaction)
            .filter(
                Transaction.user_id == self.user_id,
                Transaction.account_id.in_([account.id for account in accounts]),
            )
            .all()
        )
        for transaction in candidates:
            if transaction.id not in linked_ids and self._related_account_id(transaction):
                transactions_by_account[transaction.account_id].append(transaction)

        created = 0
        for source in candidates:
            if source.id in linked_ids:
                continue
            target_external_id = self._related_account_id(source)
            target_account = by_external_id.get(target_external_id or "")
            if target_account is None or target_account.id == source.account_id:
                continue

            source_external_id = decrypt_with_fallback(
                source.account.external_id_ciphertext if source.account else None,
                source.account.external_id if source.account else None,
            )
            if not source_external_id:
                continue
            matching = [
                candidate
                for candidate in transactions_by_account[target_account.id]
                if candidate.id not in linked_ids
                and self._related_account_id(candidate) == source_external_id
                and candidate.amount == -source.amount
                and candidate.booked_at.date() == source.booked_at.date()
            ]
            if len(matching) != 1:
                continue

            counterpart = matching[0]
            # Linked-report SQL expects the debit row to be primary; the credit
            # becomes its reimbursement, producing a zero net amount.
            primary, reimbursement = (
                (source, counterpart) if source.amount < 0 else (counterpart, source)
            )
            group_id = uuid4()
            self.db.add_all([
                TransactionLink(
                    user_id=self.user_id,
                    group_id=group_id,
                    transaction_id=primary.id,
                    link_role="primary",
                ),
                TransactionLink(
                    user_id=self.user_id,
                    group_id=group_id,
                    transaction_id=reimbursement.id,
                    link_role="reimbursement",
                ),
            ])
            linked_ids.update((source.id, counterpart.id))
            created += 1

        if created:
            self.db.commit()
        return created
