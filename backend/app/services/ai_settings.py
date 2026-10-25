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


OLLAMA_TIMEOUT = 120
OLLAMA_BATCH_SIZE = 10


def ollama_url():
    """Deployment-owned address, never a URL supplied by a browser request."""
    from urllib.parse import urlsplit
    url = os.getenv('OLLAMA_BASE_URL', '').rstrip('/')
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/v1'):
        raise AiConfigurationError('The server administrator must configure the private Ollama connection first.')
    return url.removesuffix('/v1')


def ollama_models():
    import httpx
    try:
        response = httpx.get(ollama_url() + '/api/tags', headers={'Authorization': 'Bearer ' + os.getenv('OLLAMA_API_KEY', 'ollama')}, timeout=10, follow_redirects=False, trust_env=False)
        response.raise_for_status()
        return sorted({m['name'] for m in response.json()['models']
                       if not m.get('remote_host') and not m.get('remote_model') and not m['name'].endswith(':cloud')})
    except AiConfigurationError:
        raise
    except Exception:
        raise AiConfigurationError('Mac/Ollama unavailable. Check that the Mac is awake and connected to the network, then retry. No cloud fallback was used.') from None


def ollama_client():
    import httpx
    return OpenAI(api_key=os.getenv('OLLAMA_API_KEY', 'ollama'), base_url=ollama_url() + '/v1',
                  timeout=OLLAMA_TIMEOUT, max_retries=0,
                  http_client=httpx.Client(trust_env=False, follow_redirects=False))


def ai_config(db, user_id, *, manual=False):
    settings = db.get(UserAiSettings, user_id)
    if settings is not None and settings.provider == 'ollama':
        if not settings.model or (not manual and not settings.automatic):
            return None
        return {'provider': 'ollama', 'model': settings.model, 'key': None}
    key = user_api_key(db, user_id, manual=manual)
    if not key:
        return None
    return {'provider': 'openai', 'model': MODEL if settings else os.getenv('CATEGORIZATION_LLM_MODEL', MODEL), 'key': key}


def test_ollama(model):
    if model not in ollama_models():
        raise AiConfigurationError('Select an installed local Ollama model. Refresh the model list and try again.')
    try:
        result = ollama_client().chat.completions.create(model=model, messages=[{'role': 'user', 'content': 'Reply OK.'}],
                    max_tokens=32, temperature=0, reasoning_effort='none')
        if not result.choices[0].message.content:
            raise ValueError('No answer')
    except Exception:
        raise AiConfigurationError('Ollama could not complete the test. Check the Mac and selected model, then retry. No cloud fallback was used.') from None
