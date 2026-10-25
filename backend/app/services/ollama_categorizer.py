"""Native Ollama transport with explicit context and disabled reasoning output."""
import os
import time
from types import SimpleNamespace

import httpx


class OllamaCategorizerClient:
    def __init__(self):
        self.base_url = os.getenv("CATEGORIZER_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
        self.chat = SimpleNamespace(completions=self)
        self.request_metrics = []  # Aggregate runtime data only; never prompts or responses.

    def create(self, *, model, messages, temperature, max_tokens, **kwargs):
        started = time.perf_counter()
        response = httpx.post(
            self.base_url + "/api/chat",
            json={"model": model, "messages": messages, "stream": False, "think": False,
                  "options": {"temperature": temperature, "seed": 42,
                              "num_ctx": int(os.getenv("CATEGORIZER_OLLAMA_CONTEXT", "32768")),
                              "num_predict": max_tokens}},
            timeout=float(os.getenv("CATEGORIZER_OLLAMA_TIMEOUT", "180")),
        )
        response.raise_for_status()
        data = response.json()
        if not data.get("done") or data.get("done_reason") == "length":
            raise ValueError("Incomplete Ollama generation")
        incoming, outgoing = data.get("prompt_eval_count", 0), data.get("eval_count", 0)
        self.request_metrics.append({
            "wall_seconds": time.perf_counter() - started,
            "prompt_tokens": incoming, "output_tokens": outgoing,
            **{field + "_seconds": data.get(field, 0) / 1e9 for field in
               ("total_duration", "load_duration", "prompt_eval_duration", "eval_duration")},
        })
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=data["message"]["content"]))],
            usage=SimpleNamespace(prompt_tokens=incoming, completion_tokens=outgoing,
                                  total_tokens=incoming + outgoing),
        )
