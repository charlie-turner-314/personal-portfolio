from unittest.mock import Mock

import pytest

from app.services.ollama_categorizer import OllamaCategorizerClient
from app.services.category_matcher import CategoryMatcher


def test_local_provider_needs_no_openai_key_or_openai_pricing(monkeypatch):
    monkeypatch.setenv("CATEGORIZER_PROVIDER", "ollama")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    matcher = CategoryMatcher.__new__(CategoryMatcher)
    matcher._openai_client = None
    assert isinstance(matcher._get_openai_client(), OllamaCategorizerClient)
    assert matcher._calculate_llm_cost(1000, 1000, "gpt-4o-mini") == 0


def test_native_request_and_usage(monkeypatch):
    response = Mock()
    response.json.return_value = {"done": True, "done_reason": "stop", "message": {"content": "0|Food|90"}, "prompt_eval_count": 12, "eval_count": 5}
    post = Mock(return_value=response)
    monkeypatch.setattr("app.services.ollama_categorizer.httpx.post", post)
    client = OllamaCategorizerClient()
    result = client.chat.completions.create(model="qwen3:8b", messages=[], temperature=.1, max_tokens=100, timeout=30)
    assert result.usage.total_tokens == 17
    assert result.choices[0].message.content == "0|Food|90"
    assert client.request_metrics[0]["prompt_tokens"] == 12
    assert client.request_metrics[0]["wall_seconds"] >= 0
    assert "messages" not in client.request_metrics[0]
    request = post.call_args.kwargs["json"]
    assert request["think"] is False
    assert request["options"]["num_ctx"] == 32768
    response.json.return_value["done_reason"] = "length"
    partial = OllamaCategorizerClient().create(model="qwen3:8b", messages=[], temperature=.1, max_tokens=100)
    assert partial.choices[0].finish_reason == "length"
