"""Credential isolation and real PostgreSQL cleanup behavior; provider is mocked."""
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from openai import AuthenticationError, RateLimitError
from app.database import Base, engine, SessionLocal, get_db
from app.db_helpers import get_user_id
from app.models import User, Account, Category, Transaction, UserAiSettings, AiCategorizationJob
from app.routes import ai_settings as routes
from app.services import ai_settings as service
from app.security.data_encryption import decrypt_value, reset_encryption_config_cache
from tasks.ai_categorization import categorize_uncategorized

KEY = 'sk-synthetic-only-never-a-real-key'

@pytest.fixture
def setup(monkeypatch):
    Base.metadata.create_all(engine)
    db = SessionLocal()
    users = [f'ai-test-{uuid.uuid4()}' for _ in range(2)]
    for uid in users:
        db.add(User(id=uid, email=uid+'@example.test', name='AI fixture'))
    db.flush()
    accounts = [Account(user_id=u, name='AI fixture', account_type='checking') for u in users]
    cats = [Category(user_id=u, name='Groceries', category_type='expense') for u in users]
    db.add_all(accounts+cats); db.commit()
    identity = {'id': users[0]}
    app = FastAPI(); app.include_router(routes.router, prefix='/api/ai-settings')
    app.dependency_overrides[get_user_id] = lambda: identity['id']
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    provider = Mock()
    provider.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content='0|Groceries|95'))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15))
    monkeypatch.setattr(service, 'openai_client', lambda key: provider)
    queue = Mock(); monkeypatch.setattr(categorize_uncategorized, 'delay', queue)
    try:
        yield SimpleNamespace(db=db, users=users, accounts=accounts, cats=cats, identity=identity, client=client, provider=provider, queue=queue)
    finally:
        db.rollback()
        db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
        db.commit(); db.close()


def save(s, automatic=True):
    response = s.client.put('/api/ai-settings', json={'api_key': KEY, 'automatic': automatic})
    assert response.status_code == 200, response.text


def transaction(s, owner=0, **kwargs):
    row=Transaction(user_id=s.users[owner], account_id=s.accounts[owner].id, amount=-10,
                    booked_at=datetime.utcnow(), description='Synthetic groceries', **kwargs)
    s.db.add(row);s.db.commit();return row


def run(s):
    response=s.client.post('/api/ai-settings/categorize');assert response.status_code==200,response.text
    job_id=response.json()['job']['id'];categorize_uncategorized.run(job_id);s.db.expire_all()
    return s.db.get(AiCategorizationJob,uuid.UUID(job_id))


def test_key_encrypted_never_returned_and_isolated(setup):
    s=setup;save(s)
    row=s.db.get(UserAiSettings,s.users[0]);assert row.api_key_encrypted.startswith('enc:v1:')
    assert KEY not in row.api_key_encrypted and decrypt_value(row.api_key_encrypted)==KEY
    assert KEY not in s.client.get('/api/ai-settings').text
    s.identity['id']=s.users[1]
    assert s.client.get('/api/ai-settings').json()['configured'] is False
    assert service.user_api_key(s.db,s.users[1],manual=True) is None
    assert s.client.post('/api/ai-settings/test',json={}).status_code==400
    s.client.delete('/api/ai-settings');s.db.expire_all()
    assert service.user_api_key(s.db,s.users[0],manual=True)==KEY


def test_invalid_key_does_not_replace_saved_key_or_leak_provider_error(setup,caplog):
    s=setup;save(s)
    s.provider.chat.completions.create.side_effect=AuthenticationError('secret '+KEY,response=httpx.Response(401,request=httpx.Request('POST','https://api.openai.com')),body=None)
    response=s.client.put('/api/ai-settings',json={'api_key':'sk-new-synthetic'})
    assert response.status_code==400 and 'rejected' in response.json()['detail']
    assert KEY not in response.text and KEY not in caplog.text
    assert service.user_api_key(s.db,s.users[0],manual=True)==KEY


def test_refuses_plaintext_storage_without_encryption(setup,monkeypatch):
    s=setup;monkeypatch.delenv('DATA_ENCRYPTION_KEY_CURRENT');reset_encryption_config_cache()
    try:
        response=s.client.put('/api/ai-settings',json={'api_key':KEY})
        assert response.status_code==503
        assert s.db.get(UserAiSettings,s.users[0]) is None
        s.provider.chat.completions.create.assert_not_called()
    finally:
        reset_encryption_config_cache()


def test_automatic_opt_out_and_key_removal_override_server_fallback(setup,monkeypatch):
    s=setup;monkeypatch.setenv('OPENAI_API_KEY','server-key');save(s,False)
    assert service.user_api_key(s.db,s.users[0]) is None
    assert service.user_api_key(s.db,s.users[0],manual=True)==KEY
    s.client.delete('/api/ai-settings');s.db.expire_all()
    assert service.user_api_key(s.db,s.users[0]) is None
    assert s.client.post('/api/ai-settings/categorize').status_code==400


def test_cleanup_only_empty_owned_eligible_rows_and_preserves_edits(setup):
    s=setup;save(s)
    empty=transaction(s)
    manual=transaction(s,category_id=s.cats[0].id)
    system=transaction(s,category_system_id=s.cats[0].id)
    hidden=transaction(s,include_in_analytics=False)
    other=transaction(s,owner=1)
    job=run(s)
    assert (job.status,job.total,job.processed,job.categorized)==('completed',1,1,1)
    assert s.db.get(Transaction,empty.id).category_system_id==s.cats[0].id
    assert s.db.get(Transaction,manual.id).category_id==s.cats[0].id
    assert s.db.get(Transaction,system.id).category_system_id==s.cats[0].id
    assert s.db.get(Transaction,hidden.id).category_system_id is None
    assert s.db.get(Transaction,other.id).category_system_id is None
    assert run(s).total==0


def test_manual_edit_during_provider_request_wins(setup):
    s=setup;save(s);row=transaction(s)
    response=s.provider.chat.completions.create.return_value
    def edit(**kwargs):
        with SessionLocal() as other:
            other.query(Transaction).filter(Transaction.id==row.id).update({'category_id':s.cats[0].id})
            other.commit()
        return response
    s.provider.chat.completions.create.side_effect=edit
    job=run(s)
    assert job.categorized==0
    assert s.db.get(Transaction,row.id).category_id==s.cats[0].id
    assert s.db.get(Transaction,row.id).category_system_id is None


def test_duplicate_jobs_rejected_and_status_is_user_scoped(setup):
    s=setup;save(s);transaction(s)
    assert s.client.post('/api/ai-settings/categorize').status_code==200
    assert s.client.post('/api/ai-settings/categorize').status_code==409
    s.identity['id']=s.users[1]
    assert s.client.get('/api/ai-settings').json()['job'] is None


def test_provider_quota_failure_is_visible_and_safe(setup,caplog):
    s=setup;save(s);row=transaction(s)
    s.provider.chat.completions.create.side_effect=RateLimitError('secret '+KEY,response=httpx.Response(429,request=httpx.Request('POST','https://api.openai.com')),body=None)
    job=run(s)
    assert job.status=='failed' and 'quota' in job.error
    assert KEY not in job.error and KEY not in caplog.text
    assert s.db.get(Transaction,row.id).category_system_id is None


def test_queue_failure_and_stalled_worker_are_retryable(setup):
    s=setup;save(s);transaction(s);s.queue.side_effect=RuntimeError('queue unavailable')
    assert s.client.post('/api/ai-settings/categorize').status_code==503
    assert s.client.get('/api/ai-settings').json()['job']['status']=='failed'
    s.queue.side_effect=None
    assert s.client.post('/api/ai-settings/categorize').status_code==200
    s.db.query(AiCategorizationJob).filter(AiCategorizationJob.user_id==s.users[0]).update({'updated_at':datetime.utcnow()-timedelta(minutes=16)})
    s.db.commit()
    assert s.client.get('/api/ai-settings').json()['job']['status']=='failed'
    assert s.client.post('/api/ai-settings/categorize').status_code==200


def test_real_application_rejects_unsigned_settings_requests():
    from app.main import app
    client=TestClient(app)
    for method,path in [('GET',''),('PUT',''),('DELETE',''),('POST','/test'),('POST','/categorize')]:
        response=client.request(method,'/api/ai-settings'+path,json={})
        assert response.status_code in (401,403)


def test_import_pipeline_uses_saved_key_and_respects_automatic_preference(setup):
    from tasks.post_import_pipeline import _batch_categorize_transactions
    s=setup;save(s);row=transaction(s)
    _batch_categorize_transactions(s.db,s.users[0],[str(row.id)])
    s.db.expire_all();assert s.db.get(Transaction,row.id).category_system_id==s.cats[0].id
    save(s,False);s.provider.chat.completions.create.reset_mock()
    second=transaction(s)
    _batch_categorize_transactions(s.db,s.users[0],[str(second.id)])
    s.provider.chat.completions.create.assert_not_called()


def test_multiple_batches_checkpoint_and_redelivery_is_noop(setup):
    s=setup;save(s)
    for _ in range(51):transaction(s)
    job=run(s)
    assert (job.processed,job.total,job.categorized)==(51,51,2)
    s.provider.chat.completions.create.reset_mock()
    categorize_uncategorized.run(str(job.id))
    s.provider.chat.completions.create.assert_not_called()


def test_removed_key_stops_queued_job_without_sending_transactions(setup):
    s=setup;save(s);transaction(s)
    response=s.client.post('/api/ai-settings/categorize')
    s.client.delete('/api/ai-settings');s.provider.chat.completions.create.reset_mock()
    job_id=response.json()['job']['id'];categorize_uncategorized.run(job_id);s.db.expire_all()
    assert s.db.get(AiCategorizationJob,uuid.UUID(job_id)).status=='failed'
    s.provider.chat.completions.create.assert_not_called()


def test_internal_transfer_is_excluded_even_when_analytics_is_true(setup):
    from app.models import InternalTransfer
    s=setup;save(s)
    row=transaction(s)
    transfer=InternalTransfer(user_id=s.users[0],source_txn_id=row.id,source_account_id=s.accounts[0].id,pocket_account_id=s.accounts[0].id,amount=10,currency='AUD')
    s.db.add(transfer);s.db.commit()
    row.internal_transfer_id=transfer.id;s.db.commit()
    assert run(s).total==0


def test_ollama_save_test_cleanup_and_disconnect(setup, monkeypatch):
    s = setup
    monkeypatch.setattr(service, 'ollama_models', lambda: ['qwen3:8b'])
    monkeypatch.setattr(service, 'ollama_client', lambda: s.provider)
    response = s.client.put('/api/ai-settings', json={'provider': 'ollama', 'model': 'qwen3:8b'})
    assert response.status_code == 200, response.text
    info = s.client.get('/api/ai-settings').json()
    assert info['provider'] == 'ollama' and info['model'] == 'qwen3:8b' and info['configured']
    assert s.db.get(UserAiSettings, s.users[0]).api_key_encrypted is None
    transaction(s)
    job = run(s)
    assert job.status == 'completed' and job.categorized == 1
    kwargs = s.provider.chat.completions.create.call_args.kwargs
    assert kwargs['reasoning_effort'] == 'none' and kwargs['timeout'] == 120
    assert kwargs['model'] == 'qwen3:8b'
    s.client.delete('/api/ai-settings')
    assert not s.client.get('/api/ai-settings').json()['configured']
    assert service.ai_config(s.db, s.users[0], manual=True) is None


def test_ollama_offline_does_not_fallback_and_retry_preserves_progress(setup, monkeypatch):
    s = setup
    monkeypatch.setenv('OPENAI_API_KEY', 'must-not-be-used')
    monkeypatch.setattr(service, 'ollama_models', lambda: ['qwen3:8b'])
    monkeypatch.setattr(service, 'ollama_client', lambda: s.provider)
    assert s.client.put('/api/ai-settings', json={'provider': 'ollama', 'model': 'qwen3:8b'}).status_code == 200
    transaction(s)
    s.provider.chat.completions.create.side_effect = ConnectionError('private failure')
    job = run(s)
    assert job.status == 'failed' and job.processed == 0
    assert 'Mac/Ollama' in job.error and 'No cloud fallback' in job.error
    s.provider.chat.completions.create.side_effect = None
    retry = run(s)
    assert retry.status == 'completed' and retry.categorized == 1


def test_ollama_rejects_uninstalled_model_and_does_not_replace_openai(setup, monkeypatch):
    s = setup; save(s)
    monkeypatch.setattr(service, 'ollama_models', lambda: ['qwen3:8b'])
    response = s.client.put('/api/ai-settings', json={'provider': 'ollama', 'model': 'cloud:cloud', 'base_url': 'http://untrusted'})
    assert response.status_code == 400
    assert s.client.get('/api/ai-settings').json()['provider'] == 'openai'
    assert service.user_api_key(s.db, s.users[0], manual=True) == KEY


def test_ollama_automatic_optout_and_user_isolation(setup, monkeypatch):
    s = setup
    monkeypatch.setattr(service, 'ollama_models', lambda: ['qwen3:8b'])
    monkeypatch.setattr(service, 'ollama_client', lambda: s.provider)
    assert s.client.put('/api/ai-settings', json={'provider': 'ollama', 'model': 'qwen3:8b', 'automatic': False}).status_code == 200
    assert service.ai_config(s.db, s.users[0]) is None
    assert service.ai_config(s.db, s.users[0], manual=True)['provider'] == 'ollama'
    assert service.ai_config(s.db, s.users[1], manual=True) is None
