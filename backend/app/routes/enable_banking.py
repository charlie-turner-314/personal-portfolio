"""
API routes for Enable Banking integration.

Handles ASPSP listing, auth initiation, session exchange, sync triggers,
connection status, and disconnection.
"""

import os
import logging
import uuid as uuid_mod
from typing import Optional, List
from datetime import datetime, timedelta, timezone

import redis
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import or_, text
from pydantic import BaseModel

from app.database import get_db
from app.db_helpers import get_user_id
from app.services.financial_access import account_access
from app.models import BankConnection, Account, UpAccountSource
from app.integrations.enable_banking_auth import EnableBankingClient
from app.integrations.enable_banking_adapter import EnableBankingAdapter, _ACCOUNT_TYPE_MAP
from app.services.sync_service import SyncService
from app.security.data_encryption import encrypt_value, blind_index, blind_index_candidates

logger = logging.getLogger(__name__)

router = APIRouter()


def _bank_identity_match(uid: str):
    identities = [Account.external_id == uid]
    hashed = blind_index(uid)
    if hashed:
        identities.append(Account.external_id_hash == hashed)
    candidates = blind_index_candidates(uid)
    if candidates:
        identities.append(Account.external_id_hash.in_(candidates))
    return or_(*identities)


REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
ASPSP_CACHE_TTL = 86400  # 24 hours


# --- Request/Response models ---

class AuthRequest(BaseModel):
    aspsp_name: str
    aspsp_country: str

class AuthResponse(BaseModel):
    url: str

class SessionRequest(BaseModel):
    code: str
    state: Optional[str] = None

class SessionResponse(BaseModel):
    connection_id: str
    accounts_count: int

class SyncProgress(BaseModel):
    stage: str  # "syncing" | "done"
    accounts_done: int
    accounts_total: int
    transactions_created: int
    transactions_updated: int
    started_at: Optional[str] = None

class ConnectionStatusResponse(BaseModel):
    id: str
    aspsp_name: str
    aspsp_country: str
    status: str
    last_synced_at: Optional[str] = None
    consent_expires_at: Optional[str] = None
    last_sync_error: Optional[str] = None
    accounts_count: int
    sync_progress: Optional[SyncProgress] = None

class SyncTriggerResponse(BaseModel):
    message: str
    task_id: Optional[str] = None

class AccountMapping(BaseModel):
    bank_uid: str
    action: str  # "create", "link" or "skip"
    name: Optional[str] = None
    existing_account_id: Optional[str] = None

class MapAccountsRequest(BaseModel):
    mappings: List[AccountMapping]
    initial_sync_days: int = 90

class MapAccountsResponse(BaseModel):
    connection_id: str
    accounts_created: int
    accounts_linked: int

class SuggestedMapping(BaseModel):
    bank_uid: str
    bank_name: str
    suggested_action: str       # "link", "create" or "skip"
    suggested_account_id: Optional[str] = None
    suggested_account_name: Optional[str] = None
    shared_connection_available: bool = False


def _connection_accounts(db, connection):
    if getattr(connection, "provider", None) == "up":
        return db.query(Account).outerjoin(UpAccountSource, UpAccountSource.account_id == Account.id).filter(
            or_(Account.bank_connection_id == connection.id, UpAccountSource.connection_id == connection.id),
            Account.is_active.is_(True), account_access(Account.id, connection.user_id),
        ).distinct()
    return db.query(Account).filter(Account.bank_connection_id == connection.id)


# --- Helper ---

def _get_eb_client() -> EnableBankingClient:
    return EnableBankingClient()

def _get_redis() -> redis.Redis:
    return redis.from_url(REDIS_URL, decode_responses=True)


# --- Routes ---

@router.get("/aspsps")
def list_aspsps(country: Optional[str] = None, user_id: str = Depends(get_user_id)):
    """
    List available banks (ASPSPs), optionally filtered by country.
    Results are cached in Redis for 24 hours.
    """
    cache_key = f"eb:aspsps:{country or 'all'}"

    try:
        r = _get_redis()
        cached = r.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception:
        logger.warning("Redis unavailable for ASPSP cache, fetching from API")

    client = _get_eb_client()
    params = {}
    if country:
        params["country"] = country.upper()

    try:
        resp = client.get("/aspsps", params=params)
        data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Enable Banking API error: {str(e)}")

    # Cache the response
    try:
        r = _get_redis()
        r.setex(cache_key, ASPSP_CACHE_TTL, json.dumps(data))
    except Exception:
        logger.warning("Failed to cache ASPSP list in Redis")

    return data


@router.post("/auth", response_model=AuthResponse)
def initiate_auth(
    body: AuthRequest,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """Generate bank authorization URL for PSU redirect."""
    client = _get_eb_client()

    # Generate a random state nonce (don't leak user_id in the redirect URL)
    state_nonce = str(uuid_mod.uuid4())
    try:
        r = _get_redis()
        r.setex(f"eb:state:{state_nonce}", 600, user_id)  # 10 min TTL
    except Exception:
        logger.warning("Failed to store OAuth state in Redis")

    auth_payload = {
        "access": {
            "valid_until": (datetime.now(timezone.utc) + timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        },
        "aspsp": {
            "name": body.aspsp_name,
            "country": body.aspsp_country.upper(),
        },
        "state": state_nonce,
        "redirect_url": client.redirect_uri,
        "psu_type": "personal",
    }

    try:
        resp = client.post("/auth", json_data=auth_payload)
        data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to initiate auth: {str(e)}")

    return AuthResponse(url=data["url"])


@router.post("/session", response_model=SessionResponse)
def create_session(
    body: SessionRequest,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """
    Exchange authorization code for an Enable Banking session.
    Creates a bank_connections row and upserts accounts.
    """
    # Validate OAuth state nonce if provided
    if body.state:
        try:
            r = _get_redis()
            stored_user_id = r.get(f"eb:state:{body.state}")
            if stored_user_id and stored_user_id != user_id:
                raise HTTPException(status_code=403, detail="OAuth state mismatch")
            # Clean up used nonce
            r.delete(f"eb:state:{body.state}")
        except HTTPException:
            raise
        except Exception:
            logger.warning("Failed to validate OAuth state from Redis")

    client = _get_eb_client()

    # Exchange code for session
    try:
        resp = client.post("/sessions", json_data={"code": body.code})
        session_data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Session exchange failed: {str(e)}")

    session_id = session_data.get("session_id")
    if not session_id:
        raise HTTPException(status_code=502, detail="No session_id in response")

    aspsp_info = session_data.get("aspsp", {})
    aspsp_name = aspsp_info.get("name", "Unknown Bank")
    aspsp_country = aspsp_info.get("country", "XX")

    # Calculate consent expiry (EB returns valid_until or we default to 90 days)
    consent_valid_until = session_data.get("access", {}).get("valid_until")
    consent_expires_at = None
    if consent_valid_until:
        try:
            consent_expires_at = datetime.fromisoformat(consent_valid_until.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            consent_expires_at = datetime.now(timezone.utc) + timedelta(days=90)
    else:
        consent_expires_at = datetime.now(timezone.utc) + timedelta(days=90)

    # Create bank_connections row (status=pending_setup; accounts mapped in a separate step)
    connection = BankConnection(
        user_id=user_id,
        provider="enable_banking",
        session_id=session_id,
        aspsp_name=aspsp_name,
        aspsp_country=aspsp_country,
        consent_expires_at=consent_expires_at,
        status="pending_setup",
        raw_session_data=session_data,
    )
    db.add(connection)
    db.commit()
    db.refresh(connection)

    accounts_count = len(session_data.get("accounts", []))

    return SessionResponse(
        connection_id=str(connection.id),
        accounts_count=accounts_count,
    )


@router.post("/connections/{connection_id}/map-accounts", response_model=MapAccountsResponse)
def map_accounts(
    connection_id: str,
    request: MapAccountsRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_user_id),
):
    """
    Map bank accounts to new or existing accounts and activate the connection.
    Called after POST /session as the second step of the account mapping wizard.
    """
    VALID_SYNC_DAYS = {30, 60, 90, 180, 365, 730}
    if request.initial_sync_days not in VALID_SYNC_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"initial_sync_days must be one of {sorted(VALID_SYNC_DAYS)}",
        )

    # Validate connection exists, belongs to user, and is pending setup
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")
    if connection.status != "pending_setup":
        raise HTTPException(
            status_code=400,
            detail=f"Connection is not in pending_setup state (current: {connection.status})",
        )

    # Index raw bank accounts by UID for quick lookup
    raw_accounts = connection.raw_session_data.get("accounts", []) if connection.raw_session_data else []
    raw_by_uid = {acc["uid"]: acc for acc in raw_accounts}

    accounts_created = 0
    accounts_linked = 0
    if len({mapping.bank_uid for mapping in request.mappings}) != len(request.mappings):
        raise HTTPException(status_code=400, detail="Map each bank account only once")
    if connection.provider == "up":
        db.execute(text("SELECT pg_advisory_xact_lock(73194, 1)"))

    for mapping in request.mappings:
        acc_data = raw_by_uid.get(mapping.bank_uid)
        if not acc_data:
            raise HTTPException(
                status_code=400,
                detail=f"No bank account found with uid '{mapping.bank_uid}' in session data",
            )

        if mapping.action == "skip":
            if connection.provider == "up":
                skipped_ids = [a.id for a in db.query(Account).filter(account_access(Account.id, user_id), Account.provider == "up", _bank_identity_match(mapping.bank_uid)).all()]
                if skipped_ids:
                    db.query(UpAccountSource).filter(UpAccountSource.connection_id == connection.id, UpAccountSource.account_id.in_(skipped_ids)).delete(synchronize_session=False)
                    db.query(Account).filter(Account.id.in_(skipped_ids), Account.user_id == user_id, Account.bank_connection_id == connection.id).update({Account.bank_connection_id: None}, synchronize_session=False)
            continue
        if not mapping.bank_uid:
            raise HTTPException(status_code=400, detail="A provider account identity is required")
        if mapping.action == "shared":
            if connection.provider != "up" or not mapping.existing_account_id:
                raise HTTPException(status_code=400, detail="Choose a shared Up account")
            target = db.query(Account).filter(Account.id == mapping.existing_account_id, Account.provider == "up", _bank_identity_match(mapping.bank_uid), account_access(Account.id, user_id)).first()
            if not target:
                raise HTTPException(status_code=404, detail="Matching shared Up account not found")
            from app.services.up_account_reconciliation import set_joint_source
            set_joint_source(db, user_id, connection.id, target.id, True)
            accounts_linked += 1
            continue
        shared = db.query(Account).filter(
            account_access(Account.id, user_id), Account.user_id != user_id,
            Account.provider == connection.provider,
            _bank_identity_match(mapping.bank_uid),
        ).first()
        if shared:
            raise HTTPException(status_code=409, detail="This bank account is already shared with you. Choose the shared account option or skip it to avoid duplicate balances.")
        if mapping.action == "create":
            name = (
                mapping.name
                or acc_data.get("account_name")
                or acc_data.get("iban")
                or "Unknown Account"
            )
            new_account = Account(
                user_id=user_id,
                name=name,
                account_type=_ACCOUNT_TYPE_MAP.get((acc_data.get("cash_account_type") or "").upper(), "checking"),
                currency=acc_data.get("currency", "EUR"),
                provider=connection.provider,
                institution=connection.aspsp_name,
                bank_connection_id=connection.id,
                external_id=mapping.bank_uid,
            )
            encrypted = encrypt_value(mapping.bank_uid)
            hashed = blind_index(mapping.bank_uid)
            new_account.external_id_hash = hashed
            if encrypted:
                new_account.external_id_ciphertext = encrypted
            db.add(new_account)
            db.flush()
            if connection.provider == "up":
                db.add(UpAccountSource(connection_id=connection.id, account_id=new_account.id))
            accounts_created += 1

        elif mapping.action == "link":
            if not mapping.existing_account_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"existing_account_id is required for action 'link' (uid: {mapping.bank_uid})",
                )
            existing = db.query(Account).filter(
                Account.id == mapping.existing_account_id,
                Account.user_id == user_id,
                Account.consolidated_into_account_id.is_(None),
            ).first()
            if not existing:
                raise HTTPException(
                    status_code=404,
                    detail=f"Account '{mapping.existing_account_id}' not found",
                )
            if existing.bank_connection_id is not None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Account '{mapping.existing_account_id}' is already linked to a bank connection",
                )
            existing.bank_connection_id = connection.id
            existing.provider = connection.provider
            existing.external_id = mapping.bank_uid
            encrypted = encrypt_value(mapping.bank_uid)
            hashed = blind_index(mapping.bank_uid)
            existing.external_id_hash = hashed
            if encrypted:
                existing.external_id_ciphertext = encrypted
            if connection.provider == "up" and not db.query(UpAccountSource).filter(UpAccountSource.connection_id == connection.id, UpAccountSource.account_id == existing.id).first():
                db.add(UpAccountSource(connection_id=connection.id, account_id=existing.id))
            accounts_linked += 1

        else:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid action '{mapping.action}'. Must be 'create', 'link' or 'skip'",
            )

    connection.initial_sync_days = request.initial_sync_days
    connection.status = "active"
    connection.raw_session_data = None  # Clear sensitive data now that mapping is complete
    db.commit()

    # Trigger initial sync
    try:
        if connection.provider == "up":
            from tasks.up_tasks import sync_up_connection
            sync_up_connection.delay(str(connection.id))
        else:
            from tasks.enable_banking_tasks import sync_bank_connection
            sync_bank_connection.delay(str(connection.id))
    except Exception:
        logger.warning("Failed to dispatch sync task after map-accounts", exc_info=True)

    return MapAccountsResponse(
        connection_id=str(connection.id),
        accounts_created=accounts_created,
        accounts_linked=accounts_linked,
    )


@router.post("/connections/{connection_id}/recategorize", response_model=SyncTriggerResponse)
def recategorize_connection(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """
    Re-run batch AI categorization for ALL transactions on a connection.

    Useful after a categorization bug — overwrites wrong system-assigned categories
    while preserving any user-assigned category_id overrides.
    """
    from app.models import Transaction

    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    visible_accounts = _connection_accounts(db, connection).all()
    if not visible_accounts:
        raise HTTPException(status_code=404, detail="No accounts found for this connection")
    groups = {}
    for account in visible_accounts:
        groups.setdefault(account.user_id, []).append(account.id)
    total = 0
    last_task = None
    from tasks.post_import_pipeline import post_import_pipeline
    for resource_owner, account_ids in groups.items():
        transaction_ids = [str(t.id) for t in db.query(Transaction.id).filter(Transaction.account_id.in_(account_ids)).all()]
        if transaction_ids:
            last_task = post_import_pipeline.delay(user_id=resource_owner, account_ids=[str(a) for a in account_ids], transaction_ids=transaction_ids, is_initial_sync=False)
            total += len(transaction_ids)
    return SyncTriggerResponse(message=f"Re-categorization started for {total} transactions" if total else "No transactions to re-categorize", task_id=last_task.id if last_task else None)


@router.post("/sync/{connection_id}", response_model=SyncTriggerResponse)
def trigger_sync(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """Trigger on-demand sync for a bank connection."""
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    if connection.status not in ("active",):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot sync connection with status '{connection.status}'. Reconnect the bank first.",
        )

    try:
        if connection.provider == "up":
            from tasks.up_tasks import sync_up_connection
            task = sync_up_connection.delay(str(connection.id))
        else:
            from tasks.enable_banking_tasks import sync_bank_connection
            task = sync_bank_connection.delay(str(connection.id))
        return SyncTriggerResponse(message="Sync started", task_id=task.id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start sync: {str(e)}")


@router.get("/status/{connection_id}", response_model=ConnectionStatusResponse)
def connection_status(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """Get connection status, last sync time, consent expiry."""
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    accounts_count = _connection_accounts(db, connection).count()

    # Read live sync progress from Redis (set by Celery worker)
    sync_progress = None
    try:
        r = redis.from_url(REDIS_URL, decode_responses=True)
        raw = r.get(f"sync_progress:{connection_id}")
        if raw:
            data = json.loads(raw)
            sync_progress = SyncProgress(**data)
    except Exception:
        pass

    return ConnectionStatusResponse(
        id=str(connection.id),
        aspsp_name=connection.aspsp_name,
        aspsp_country=connection.aspsp_country,
        status=connection.status,
        last_synced_at=connection.last_synced_at.isoformat() if connection.last_synced_at else None,
        consent_expires_at=connection.consent_expires_at.isoformat() if connection.consent_expires_at else None,
        last_sync_error=connection.last_sync_error,
        accounts_count=accounts_count,
        sync_progress=sync_progress,
    )


@router.get("/connections")
def list_connections(
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """List all bank connections for the current user."""
    connections = db.query(BankConnection).filter(
        BankConnection.user_id == user_id,
    ).order_by(BankConnection.created_at.desc()).all()

    results = []
    for conn in connections:
        accounts_count = _connection_accounts(db, conn).count()
        results.append({
            "id": str(conn.id),
            "aspsp_name": conn.aspsp_name,
            "aspsp_country": conn.aspsp_country,
            "status": conn.status,
            "last_synced_at": conn.last_synced_at.isoformat() if conn.last_synced_at else None,
            "consent_expires_at": conn.consent_expires_at.isoformat() if conn.consent_expires_at else None,
            "last_sync_error": conn.last_sync_error,
            "accounts_count": accounts_count,
            "created_at": conn.created_at.isoformat() if conn.created_at else None,
        })

    return results


def _build_suggested_mappings(
    db: Session,
    user_id: str,
    raw_accounts: list,
    provider: Optional[str] = None,
) -> list:
    """For each bank account UID, check if the user has an existing account with that external_id_hash."""
    results = []
    for raw_acc in raw_accounts:
        uid = raw_acc.get("uid") or raw_acc.get("id") or ""
        bank_name = raw_acc.get("account_name") or raw_acc.get("name") or "Bank Account"

        if not uid:
            results.append({
                "bank_uid": uid,
                "bank_name": bank_name,
                "suggested_action": "create",
                "suggested_account_id": None,
                "suggested_account_name": None,
            })
            continue

        shared = db.query(Account).filter(
            account_access(Account.id, user_id), Account.user_id != user_id,
            _bank_identity_match(uid), Account.provider == provider if provider else True,
        ).first()
        if shared:
            results.append({"bank_uid": uid, "bank_name": bank_name, "suggested_action": "skip",
                "suggested_account_id": str(shared.id), "suggested_account_name": shared.name,
                "shared_connection_available": provider == "up"})
            continue
        existing = (
            db.query(Account)
            .filter(
                Account.user_id == user_id,
                Account.consolidated_into_account_id.is_(None),
                _bank_identity_match(uid), Account.provider == provider if provider else True,
            )
            .first()
        )

        if existing:
            results.append({
                "bank_uid": uid,
                "bank_name": bank_name,
                "suggested_action": "link",
                "suggested_account_id": str(existing.id),
                "suggested_account_name": existing.name,
            })
        else:
            results.append({
                "bank_uid": uid,
                "bank_name": bank_name,
                "suggested_action": "create",
                "suggested_account_id": None,
                "suggested_account_name": None,
            })

    return results


@router.get("/connections/{connection_id}/suggested-mappings", response_model=List[SuggestedMapping])
def get_suggested_mappings(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """
    Return suggested account mappings for the map-accounts wizard.

    For each bank account UID in the connection's raw session data, checks
    whether the user already has an account with that external_id_hash and
    suggests 'link' or 'create' accordingly. Requires connection in pending_setup status.
    """
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")
    if connection.status != "pending_setup":
        raise HTTPException(
            status_code=400,
            detail="Suggested mappings are only available for connections in pending_setup status",
        )

    raw_accounts = (connection.raw_session_data or {}).get("accounts", [])
    suggestions = _build_suggested_mappings(
        db=db,
        user_id=user_id,
        raw_accounts=raw_accounts,
        provider=connection.provider,
    )
    return suggestions


@router.delete("/{connection_id}")
def disconnect(
    connection_id: str,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    """Disconnect bank: revoke EB session, mark connection as disconnected."""
    connection = db.query(BankConnection).filter(
        BankConnection.id == connection_id,
        BankConnection.user_id == user_id,
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    if connection.provider == "up":
        from app.routes.up import disconnect_connection
        return disconnect_connection(connection_id, user_id=user_id, db=db)

    # Revoke session at Enable Banking (best-effort)
    try:
        client = _get_eb_client()
        client.delete(f"/sessions/{connection.session_id}")
    except Exception:
        logger.warning(f"Failed to revoke EB session {connection.session_id}", exc_info=True)

    connection.status = "disconnected"

    # Unlink accounts so they can be re-linked to a new connection later.
    # external_id, external_id_ciphertext, and external_id_hash are preserved
    # so that re-auth can auto-match accounts by their stable bank UIDs.
    db.query(Account).filter(
        Account.bank_connection_id == connection.id,
    ).update(
        {
            Account.bank_connection_id: None,
            Account.provider: None,
        },
        synchronize_session=False,
    )

    db.commit()

    return {"message": "Bank connection disconnected"}
