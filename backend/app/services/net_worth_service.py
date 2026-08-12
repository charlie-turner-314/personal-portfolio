"""
Net-worth classification helpers.
"""
from __future__ import annotations

from dataclasses import dataclass


LIABILITY_ACCOUNT_TYPES: frozenset[str] = frozenset(
    {
        "credit",
        "credit_card",
        "loan",
        "mortgage",
        "line_of_credit",
    }
)


@dataclass
class AccountNetWorthClassification:
    asset_amount: float
    liability_amount: float


def is_liability_account_type(account_type: str | None) -> bool:
    if not account_type:
        return False
    return account_type.lower() in LIABILITY_ACCOUNT_TYPES


def classify_account_amount(
    attributed_amount: float,
    account_type: str | None,
) -> AccountNetWorthClassification:
    """
    Classify an already share-attributed account amount for net-worth reporting.

    Negative balances and known liability account types are reported as positive
    liability magnitudes. Positive balances in liability accounts still reduce
    net worth by their magnitude.
    """
    amount = float(attributed_amount or 0)
    if amount < 0 or is_liability_account_type(account_type):
        return AccountNetWorthClassification(
            asset_amount=0.0,
            liability_amount=abs(amount),
        )
    return AccountNetWorthClassification(
        asset_amount=amount,
        liability_amount=0.0,
    )


def calculate_net_worth(gross_assets: float, total_liabilities: float) -> float:
    return float(gross_assets or 0) - float(total_liabilities or 0)
