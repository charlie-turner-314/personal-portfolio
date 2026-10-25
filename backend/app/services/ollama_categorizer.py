"""Native Ollama transport with explicit context and disabled reasoning output."""
import os
import time
from types import SimpleNamespace

import httpx


class OllamaCategorizerClient:
    def __init__(self, base_url=None, api_key=None):
        self.base_url = (base_url or os.getenv("CATEGORIZER_OLLAMA_BASE_URL", "http://127.0.0.1:11434")).rstrip("/")
        self.headers = {"Authorization": "Bearer " + api_key} if api_key else {}
        self._initialize_transport()

    def identity(self, model):
        # A tag can move: record the digest and packaged defaults, not just its name.
        response = httpx.get(self.base_url + "/api/tags", headers=self.headers, timeout=10, trust_env=False)
        response.raise_for_status()
        tags = response.json()
        installed = next((m for m in tags.get("models", []) if m.get("name") == model or m.get("model") == model), None)
        if not installed or not installed.get("digest") or installed.get("remote_host") or installed.get("remote_model"):
            raise ValueError("Local model identity unavailable")
        shown = httpx.post(self.base_url + "/api/show", headers=self.headers, json={"model": model}, timeout=10, trust_env=False)
        shown.raise_for_status()
        version = httpx.get(self.base_url + "/api/version", headers=self.headers, timeout=10, trust_env=False)
        version.raise_for_status()
        return {"digest": installed["digest"], "details": installed.get("details"),
                "parameters": shown.json().get("parameters"), "template": shown.json().get("template"),
                "runtime_version": version.json().get("version"),
                "options": {"think": False, "seed": 42,
                            "num_ctx": int(os.getenv("CATEGORIZER_OLLAMA_CONTEXT", "32768"))}}

    def _initialize_transport(self):
        self.chat = SimpleNamespace(completions=self)
        self.request_metrics = []  # Aggregate runtime data only; never prompts or responses.

    def create(self, *, model, messages, temperature, max_tokens, **kwargs):
        started = time.perf_counter()
        response = httpx.post(
            self.base_url + "/api/chat",
            headers=self.headers, trust_env=False,
            json={"model": model, "messages": messages, "stream": False, "think": False,
                  "options": {"temperature": temperature, "seed": 42,
                              "num_ctx": int(os.getenv("CATEGORIZER_OLLAMA_CONTEXT", "32768")),
                              "num_predict": max_tokens}},
            timeout=float(os.getenv("CATEGORIZER_OLLAMA_TIMEOUT", "180")),
        )
        response.raise_for_status()
        data = response.json()

        incoming, outgoing = data.get("prompt_eval_count", 0), data.get("eval_count", 0)
        self.request_metrics.append({
            "wall_seconds": time.perf_counter() - started,
            "prompt_tokens": incoming, "output_tokens": outgoing,
            **{field + "_seconds": data.get(field, 0) / 1e9 for field in
               ("total_duration", "load_duration", "prompt_eval_duration", "eval_duration")},
        })
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=data["message"]["content"]),
                                     finish_reason="length" if not data.get("done") else data.get("done_reason"))],
            usage=SimpleNamespace(prompt_tokens=incoming, completion_tokens=outgoing,
                                  total_tokens=incoming + outgoing),
        )
