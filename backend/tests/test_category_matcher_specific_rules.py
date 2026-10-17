"""Exercise the actual deterministic matcher, without an API key or LLM calls."""
from decimal import Decimal
from unittest.mock import Mock

import pytest

from app.models import Category
from app.services.category_matcher import CategoryMatcher


@pytest.fixture
def matcher(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    matcher = CategoryMatcher(Mock(), user_id="test-user", auto_load_from_db=False)
    # The class default is computed when its module loads; explicitly exercise
    # the normal no-key configuration even if another test imported it earlier.
    monkeypatch.setattr(matcher, "MIN_CONFIDENCE_THRESHOLD", 70.0)
    matcher._category_cache = {
        name: Category(name=name, category_type=kind)
        for name, kind in [("groceries", "expense"), ("salary", "income"),
                           ("shopping", "expense"), ("transfer", "transfer")]
    }
    matcher.match_category_llm = Mock(side_effect=AssertionError("No LLM expected"))
    matcher._match_category_llm_with_details = Mock(side_effect=AssertionError("No LLM expected"))
    return matcher


def assert_match(matcher, description, amount, expected, merchant=None, transaction_type=None):
    kwargs = dict(description=description, merchant=merchant, amount=Decimal(amount),
                  transaction_type=transaction_type, use_llm=False)
    category = matcher.match_category(**kwargs)
    result = matcher.match_category_with_details(**kwargs)
    assert (category.name if category else None) == expected
    assert (result.category.name if result.category else None) == expected
    if expected:
        assert result.method in {"deterministic", "override"}
        assert result.confidence_score >= 70
        assert result.matched_keywords
    return result


@pytest.mark.parametrize("description", [
    "ALDI STORES BRISBANE AU", "WOOLWORTHS 1234 BRISBANE", "COLES 0421",
    "Card purchase: Aldi - store 123", "Payment to Coles Online",
])
def test_recognizes_one_precise_merchant_alternative(matcher, description):
    assert_match(matcher, description, "-42.50", "groceries")


def test_matches_merchant_field_and_explicit_transaction_direction(matcher):
    assert_match(matcher, "Card purchase", "42.50", "groceries", merchant="ALDI", transaction_type="debit")


@pytest.mark.parametrize("description", ["ACME SALARY", "PAYROLL OCTOBER", "Weekly Wages"])
def test_recognizes_explicit_salary_income(matcher, description):
    assert_match(matcher, description, "2500", "salary")


@pytest.mark.parametrize("description,amount", [
    ("Aldington plumbing", "-40"), ("Coleson consultancy", "-40"),
    ("WOOLWORTHS MOBILE", "-40"), ("COLES EXPRESS", "-40"),
    ("ALDI MOBILE", "-40"), ("Woolworths insurance", "-40"),
    ("Coles gift voucher", "-40"), ("ALDI WOOLWORTHS", "-40"),
    ("ALDI payroll", "-40"), ("ALDI refund", "40"),
    ("Salary advance", "100"), ("Wages reimbursement", "100"),
    ("Payroll repayment", "100"), ("salary refund", "100"),
    ("Wages", "-100"), ("miscellaneous income", "100"),
    ("Food market", "-100"), ("unknown payment", "-100"),
])
def test_ambiguous_or_wrong_direction_stays_unmatched(matcher, description, amount):
    assert_match(matcher, description, amount, None)


def test_user_override_has_priority_over_merchant_rule(matcher):
    matcher.user_overrides = [{"description": "ALDI STORES", "category_name": "shopping"}]
    result = assert_match(matcher, "ALDI STORES", "-40", "shopping")
    assert result.method == "override"


def test_preserves_explicit_deterministic_disable_threshold(matcher):
    matcher.MIN_CONFIDENCE_THRESHOLD = 999.0
    assert_match(matcher, "ALDI STORES", "-40", None)


def test_does_not_assign_missing_or_wrong_type_category(matcher):
    matcher._category_cache["groceries"].category_type = "income"
    assert_match(matcher, "ALDI STORES", "-40", None)
