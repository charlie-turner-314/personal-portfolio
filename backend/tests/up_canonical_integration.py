"""Disposable PostgreSQL checks for reviewed consolidation and independent Up imports."""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch
from sqlalchemy import text
from fastapi import HTTPException
from app.database import SessionLocal
from app.models import Account, BankConnection, Transaction, UpAccountSource, UpAccountReconciliation, AccountBalance, AccountOwner, AccountOwnershipAllocation, TransactionLink, Property, PropertyLiabilityLink
from app.integrations.base import AccountData, TransactionData
from app.services.up_account_reconciliation import reconciliation_preview, consolidate_accounts, private_archive, set_joint_source
from tasks.up_tasks import sync_up_connection


def run():
    db = SessionLocal()
    owner, member, outsider = ['up-canonical-' + uuid.uuid4().hex for _ in range(3)]
    target, source = uuid.uuid4(), uuid.uuid4()
    owner_connection, member_connection = uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    provider_id = 'joint-' + uuid.uuid4().hex
    try:
        for user in (owner, member, outsider):
            db.execute(text("INSERT INTO users(id,email,functional_currency) VALUES (:id,:email,'AUD')"), {'id':user,'email':user+'@example.test'})
        person = uuid.uuid4()
        db.execute(text("INSERT INTO people(id,user_id,name,kind) VALUES (:id,:owner,'Partner','member')"), {'id':person,'owner':owner})
        db.execute(text("INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (:member,:owner,:person)"), {'member':member,'owner':owner,'person':person})
        for cid, uid in ((owner_connection,owner),(member_connection,member)):
            db.add(BankConnection(id=cid,user_id=uid,provider='up',session_id='up-'+str(cid),aspsp_name='Up',aspsp_country='AU',status='active',credentials_encrypted='private-'+uid))
        db.flush()
        for aid,uid,cid in ((target,owner,owner_connection),(source,member,member_connection)):
            db.add(Account(id=aid,user_id=uid,name='Joint',account_type='checking',currency='AUD',provider='up',external_id=provider_id,bank_connection_id=cid,balance_available=Decimal('100'),functional_balance=Decimal('100'),balance_is_anchored=True,last_synced_at=now))
        db.flush()
        for cid,aid in ((owner_connection,target),(member_connection,source)):
            db.add(UpAccountSource(connection_id=cid,account_id=aid))
        db.execute(text("INSERT INTO household_account_shares(account_id,member_user_id,granted_by_user_id) VALUES (:id,:member,:owner)"), {'id':target,'member':member,'owner':owner})
        for aid,uid,external,description,amount in ((target,owner,'same','Shared edit','-10'),(source,member,'same','My edit','-10'),(source,member,'unique','Unique','-20')):
            db.add(Transaction(account_id=aid,user_id=uid,external_id=external,description=description,amount=Decimal(amount),currency='AUD',booked_at=now,transaction_type='debit'))
        db.flush()
        unique = db.query(Transaction).filter(Transaction.external_id=='unique').one()
        group = uuid.uuid4()
        db.add(TransactionLink(user_id=member,group_id=group,transaction_id=unique.id,link_role='primary'))
        for aid in (source,target):
            db.add(AccountOwner(account_id=aid,person_id=person,share=Decimal('0.5')))
            db.add(AccountOwnershipAllocation(account_id=aid,person_id=person,effective_from=now.date(),share=Decimal('0.5')))
        db.add(AccountBalance(account_id=source,date=now,balance_in_account_currency=100,balance_in_functional_currency=100))
        home = Property(user_id=member,name='Joint home',property_type='residential',currency='AUD',current_value=1000)
        db.add(home);db.flush()
        db.add(PropertyLiabilityLink(property_id=home.id,account_id=source))
        db.commit()
        pair = [{'source_account_id':source,'canonical_account_id':target}]
        preview = reconciliation_preview(db,member,member_connection,pair)
        assert preview['transactions_to_move']==1 and preview['provider_duplicates']==1 and preview['conflicts']
        try:
            consolidate_accounts(db,member,member_connection,pair,None)
            raise AssertionError('Unreviewed conflicting manual edits were merged')
        except HTTPException as exc:
            assert exc.status_code==409
        assert db.query(Transaction).count()==3
        result = consolidate_accounts(db,member,member_connection,pair,'keep_mine')
        assert result['accounts_consolidated']==1
        db.expire_all()
        canonical, archived = db.get(Account,target),db.get(Account,source)
        assert archived.consolidated_into_account_id==target and not archived.is_active
        assert db.query(AccountOwner).count()==2 and db.query(AccountOwnershipAllocation).count()==2
        assert db.query(AccountBalance).filter(AccountBalance.account_id==source).count()==1
        assert db.query(AccountBalance).filter(AccountBalance.account_id==target).count()==1
        assert db.query(PropertyLiabilityLink).one().account_id==target
        assert db.query(TransactionLink).one().transaction_id==unique.id
        assert canonical.balance_available==100 and canonical.starting_balance==130
        assert db.query(Transaction).filter(Transaction.account_id==target).count()==2
        assert db.query(Transaction).filter(Transaction.external_id=='same').one().description=='My edit'
        assert {row.user_id for row in db.query(Transaction)}=={owner}
        assert db.query(UpAccountSource).filter(UpAccountSource.account_id==target).count()==2
        archive_id = uuid.UUID(result['archives'][0])
        assert len(private_archive(db,member,archive_id)['original_import']['transactions'])==2
        assert 'original_import' not in private_archive(db,owner,archive_id)
        try:
            private_archive(db,outsider,archive_id)
            raise AssertionError('Private archive exposed')
        except HTTPException as exc:
            assert exc.status_code==404
        assert db.get(BankConnection,member_connection).credentials_encrypted=='private-'+member
        assert db.get(BankConnection,owner_connection).credentials_encrypted=='private-'+owner
        again = consolidate_accounts(db,member,member_connection,pair,None)
        assert again['accounts_consolidated']==0
        try:
            db.add(Transaction(account_id=source,user_id=member,amount=1,currency='AUD',booked_at=now,transaction_type='credit'))
            db.commit()
            raise AssertionError('Retired source accepted new history')
        except Exception as exc:
            db.rollback()
            assert 'consolidated' in str(exc)
        provider_account = AccountData(external_id=provider_id,name='Joint',account_type='checking',institution='Up',currency='AUD',balance_available=Decimal('100'))
        provider_rows = [TransactionData(external_id=external,account_external_id=provider_id,amount=Decimal(amount),currency='AUD',description=description,booked_at=now,transaction_type='debit') for external,amount,description in [('same','-10','Provider original'),('unique','-20','Unique'),('new','-5','New')]]
        db.rollback()
        with patch('tasks.up_tasks.decrypt_value',return_value='private-test'), patch('tasks.up_tasks.UpAdapter') as adapter, patch('tasks.up_tasks.post_import_pipeline.delay'), patch('tasks.up_tasks.UpTransferLinkService.link_explicit_transfers',return_value=0):
            adapter.return_value.fetch_accounts.return_value=[provider_account]
            adapter.return_value.fetch_transactions.return_value=provider_rows
            for cid in (owner_connection,member_connection,owner_connection):
                sync_up_connection.run(str(cid),force=True)
        db.expire_all()
        assert db.query(Transaction).filter(Transaction.account_id==target).count()==3
        assert db.query(Transaction).filter(Transaction.external_id=='same').one().description=='My edit'
        assert db.get(Account,target).starting_balance==135
        assert db.query(Transaction).filter(Transaction.account_id==source).count()==0
        # Revocation after the provider call must prevent this batch from writing.
        def revoke(*args,**kwargs):
            other=SessionLocal()
            other.execute(text('DELETE FROM household_account_shares WHERE account_id=:id'),{'id':target})
            other.commit();other.close()
            return provider_rows+[provider_rows[-1].model_copy(update={'external_id':'must-not-write'})]
        db.rollback()
        with patch('tasks.up_tasks.decrypt_value',return_value='private-test'), patch('tasks.up_tasks.UpAdapter') as adapter, patch('tasks.up_tasks.post_import_pipeline.delay'), patch('tasks.up_tasks.UpTransferLinkService.link_explicit_transfers',return_value=0):
            adapter.return_value.fetch_accounts.return_value=[provider_account]
            adapter.return_value.fetch_transactions.side_effect=revoke
            sync_up_connection.run(str(member_connection),force=True)
        db.expire_all()
        assert not db.query(Transaction).filter(Transaction.external_id=='must-not-write').first()
        print('Up canonical integration: reviewed conflicts, union/deduplication, anchor, archives, credentials, idempotency, independent repeated imports, manual edits and mid-fetch revocation passed.')
    finally:
        db.rollback()
        db.execute(text('DELETE FROM household_memberships WHERE member_user_id=:id'),{'id':member})
        db.execute(text('DELETE FROM users WHERE id IN (:owner,:member,:outsider)'),{'owner':owner,'member':member,'outsider':outsider})
        db.commit();db.close()
