"""User-scoped credentials; plaintext never leaves the backend."""
import os
from openai import OpenAI
from app.models import UserAiSettings
from app.security.data_encryption import decrypt_value

MODEL = "gpt-4o-mini"

class AiConfigurationError(Exception):
    pass


def safe_ai_error(exc):
    status = getattr(exc, "status_code", None)
    if isinstance(exc, AiConfigurationError):
        return str(exc)
    if status == 401:
        return "OpenAI rejected this API key. Replace it with a valid key."
    if status == 403:
        return "This API key does not have permission to use the categorisation model."
    if status == 429:
        return "OpenAI quota or rate limit reached. Check API billing and limits, then try again."
    if status == 404:
        return "The categorisation model is unavailable for this API key."
    return "Could not reach OpenAI or complete the request. Please try again."


def user_api_key(db, user_id, *, manual=False):
    settings = db.get(UserAiSettings, user_id)
    if settings is not None:
        if not settings.api_key_encrypted or (not manual and not settings.automatic):
            return None
        try:
            return decrypt_value(settings.api_key_encrypted)
        except Exception:
            raise AiConfigurationError("The saved API key could not be decrypted. Save the key again.") from None
    return None if manual else os.getenv("OPENAI_API_KEY") or None


def openai_client(key):
    # Explicit endpoint: environment overrides must not redirect a user's secret.
    return OpenAI(api_key=key, base_url="https://api.openai.com/v1", timeout=30, max_retries=0)


def test_key(key):
    if not key:
        raise AiConfigurationError("Save an OpenAI API key first.")
    openai_client(key).chat.completions.create(
        model=MODEL, messages=[{"role": "user", "content": "Reply OK."}],
        max_tokens=5, temperature=0,
    )
