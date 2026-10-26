"""Safe bank-record projections. Never mutate the stored audit/source record."""

from sqlalchemy import case
from app.models import Transaction


def generated_mirror(transaction):
    return (getattr(transaction, "external_id", None) or "").startswith("mirror-")


def transaction_description_sql():
    return case(
        (Transaction.external_id.like("mirror-%"), "Transfer"),
        else_=Transaction.description,
    )


def transaction_merchant_sql():
    return case(
        (Transaction.external_id.like("mirror-%"), None), else_=Transaction.merchant
    )


def safe_description(transaction):
    return "Transfer" if generated_mirror(transaction) else transaction.description


def safe_merchant(transaction):
    return None if generated_mirror(transaction) else transaction.merchant


def private_transaction_fields(transaction, actor):
    own = transaction.user_id == actor
    return {
        "external_id": (
            transaction.external_id
            if own and not generated_mirror(transaction)
            else None
        ),
        "categorization_instructions": (
            transaction.categorization_instructions if own else None
        ),
        "enrichment_data": transaction.enrichment_data if own else None,
        "recurring_transaction_id": (
            str(transaction.recurring_transaction_id)
            if own and transaction.recurring_transaction_id
            else None
        ),
    }


def api_transaction(transaction, actor):
    from app.schemas import TransactionResponse

    result = {
        key: getattr(transaction, key, None) for key in TransactionResponse.model_fields
    }
    result.update(
        {
            key: value
            for key, value in private_transaction_fields(transaction, actor).items()
            if key in result
        }
    )
    result.update(
        description=safe_description(transaction) or "Transaction",
        merchant=safe_merchant(transaction),
        pending=bool(transaction.pending),
        transaction_type=transaction.transaction_type
        or ("debit" if transaction.amount < 0 else "credit"),
    )
    return TransactionResponse(**result)
