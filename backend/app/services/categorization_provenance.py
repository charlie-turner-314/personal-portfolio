"""Private replay metadata. Never copy credentials or write payloads to logs."""
import hashlib
import json
import os
from pathlib import Path

from app.services.categorization_context import account_metadata, transaction_record

VERSION = "suggestion-record-v1"


def serializable(value):
    return json.loads(json.dumps(value, default=str))


def digest(value):
    return hashlib.sha256(json.dumps(serializable(value), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def configuration(matcher, client, categories, context_mode):
    files = ("category_matcher.py", "categorization_context.py", "ollama_categorizer.py", "categorization_provenance.py", "categorization_suggestions.py")
    code = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in files}
    provider = getattr(matcher, "_ai_provider", os.getenv("CATEGORIZER_PROVIDER", "openai"))
    identity = client.identity(matcher.LLM_MODEL) if hasattr(client, "identity") else {"status": "provider_identity_unavailable"}
    taxonomy = [serializable({key: getattr(c, key, None) for key in
                ("id", "name", "category_type", "parent_id", "description", "categorization_instructions", "hide_from_selection")})
                for c in sorted(categories.values(), key=lambda c: str(c.id))]
    return {"record_version": VERSION, "code_hashes": code,
            "application_revision": os.getenv("APP_REVISION") or os.getenv("GIT_SHA") or None,
            "provider": provider, "model": matcher.LLM_MODEL, "model_identity": identity,
            "context_mode": context_mode, "taxonomy": taxonomy,
            "temperature": getattr(matcher, "LLM_TEMPERATURE", None),
            "retrieval": {"embedding_model": os.getenv("CATEGORIZER_EMBEDDING_MODEL", ""),
                          "snapshot_configured": bool(os.getenv("CATEGORIZER_VERIFIED_SNAPSHOT"))}}


def target_snapshot(transaction):
    return serializable({**transaction_record(transaction), "account": account_metadata(transaction.account),
                         "pending": transaction.pending, "internal_transfer_id": transaction.internal_transfer_id})
