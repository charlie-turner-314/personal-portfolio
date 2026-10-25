"""Confidence persistence and missing-score handling; no live DB or AI calls."""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.category_matcher import CategoryMatcher
from tasks.post_import_pipeline import _batch_categorize_transactions


@pytest.mark.parametrize("score,expected", [(0, 0), (42.6, 43), (100, 100), (None, None)])
def test_pipeline_saves_score_with_category(score, expected):
    db = MagicMock()
    transaction = SimpleNamespace(
        description="Test shop", merchant="Test shop", amount=-12,
        transaction_type="debit", category_system_id="old", category_confidence=90,
    )
    db.query.return_value.filter.return_value.all.return_value = [transaction]
    with patch("tasks.post_import_pipeline.CategoryMatcher") as matcher:
        matcher.return_value.match_categories_batch_llm.return_value = (
            {0: (SimpleNamespace(id="new"), score)}, 20, 0.01,
        )
        _batch_categorize_transactions(db, "user", ["transaction"])
    assert transaction.category_system_id == "new"
    assert transaction.category_confidence == expected
    db.commit.assert_called_once()
    # Manual choices and excluded transfers never enter the scoring batch.
    filters = " ".join(str(condition) for condition in db.query.return_value.filter.call_args.args)
    assert "transactions.category_id IS NULL" in filters
    assert "transactions.include_in_analytics IS true" in filters


def test_unavailable_ai_preserves_existing_score():
    db = MagicMock()
    transaction = SimpleNamespace(
        description="Test shop", merchant="Test shop", amount=-12,
        transaction_type="debit", category_system_id="old", category_confidence=90,
    )
    db.query.return_value.filter.return_value.all.return_value = [transaction]
    with patch("tasks.post_import_pipeline.CategoryMatcher") as matcher:
        matcher.return_value.match_categories_batch_llm.return_value = ({}, 0, 0)
        _batch_categorize_transactions(db, "user", ["transaction"])
    assert transaction.category_system_id == "old"
    assert transaction.category_confidence == 90
    db.commit.assert_not_called()


@pytest.mark.parametrize("suffix,expected", [
    ("|0", 0), ("|87.5", 87.5), ("|100", 100),
    ("", None), ("|invalid", None), ("|nan", None), ("|inf", None),
    ("|-1", None), ("|101", None),
])
def test_batch_parser_does_not_invent_scores(suffix, expected):
    matcher = CategoryMatcher(MagicMock(), user_id="user", auto_load_from_db=False)
    category = SimpleNamespace(id="groceries", name="Groceries", category_type="expense")
    client = MagicMock()
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=f"0|Groceries{suffix}"))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=10, total_tokens=20),
    )
    with patch.object(matcher, "_get_openai_client", return_value=client), patch.object(
        matcher, "_load_categories", return_value={"groceries": category}
    ):
        results, _, _ = matcher.match_categories_batch_llm([
            {"index": 0, "description": "Test shop", "merchant": "Test shop", "amount": -12}
        ])
    assert results[0] == (category, expected)
