"""Credential-issuance and management endpoints (DE 11 Block 1.C)."""

from __future__ import annotations

import base64
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta
from time import monotonic

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from dcc_auth.browser_sessions import validate_session
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import IssuedCredential, User, UserSession
from dcc_auth.schemas_credentials import (
    CredentialDevice,
    CredentialIssueRequest,
    CredentialIssueResponse,
    CredentialListResponse,
)
from dcc_auth.security import get_signer

log = logging.getLogger(__name__)

router = APIRouter(prefix="/credentials", tags=["credentials"])

_CERT_VALIDITY_DAYS = 365
_MAX_ACTIVE_CERTS = 20
_REVOKE_WINDOW_GRACE_SECONDS = 300
_ISSUE_RATE_LIMIT = "3/hour"


async def _check_rate_user(request: Request, user_id: int) -> None:
    """Rate-limit: 3/hour per user_id (process-local token-bucket)."""
    n, seconds = 3, 3600
    bucket = request.app.state.rate_buckets.setdefault("cred_issue", {})
    user_key = str(user_id)
    now = monotonic()
    expired = [k for k, w in bucket.items() if now - w["start"] >= seconds]
    for k in expired:
        del bucket[k]
    window = bucket.get(user_key)
    if window is None or now - window["start"] >= seconds:
        bucket[user_key] = {"start": now, "count": 1}
        return
    if window["count"] >= n:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"rate limit exceeded ({_ISSUE_RATE_LIMIT})",
        )
    window["count"] += 1


def _decode_pubkey(b64: str) -> bytes:
    # Frontend (keypair.svelte.ts) sendet Base64URL (RFC 4648 §5: ``-``/``_``
    # statt ``+``/``/``, kein Padding). ``urlsafe_b64decode`` deckt beide
    # Varianten ab — base64url ohne Padding muss aber rechts mit ``=`` auf
    # ein Vielfaches von 4 aufgefüllt werden, sonst wirft binascii.Error.
    try:
        padding = (4 - len(b64) % 4) % 4
        return base64.urlsafe_b64decode(b64 + "=" * padding)
    except Exception as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="device_pubkey: invalid base64"
        ) from exc


def _credential_to_device(cred: IssuedCredential) -> CredentialDevice:
    return CredentialDevice(
        cert_id=str(cred.cert_id),
        device_label=cred.device_label,
        issued_at=cred.issued_at,
        expires_at=cred.expires_at,
        has_backup=cred.backup is not None,
    )


async def _active_creds_for_user(db: AsyncSession, user_id: int) -> list[IssuedCredential]:
    now = datetime.now(UTC)
    stmt = (
        select(IssuedCredential)
        .options(selectinload(IssuedCredential.backup))
        .where(
            IssuedCredential.user_id == user_id,
            IssuedCredential.revoked_at.is_(None),
            IssuedCredential.expires_at > now,
        )
        .order_by(IssuedCredential.issued_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def _push_to_redis_crl(cert_id: str, expires_at: datetime) -> None:
    """Best-effort: add cert_id to auth:revoked_certs ZSET and invalidate the ETag cache.

    Uses crl_add() from routes_crl which does zadd + ETag recompute atomically so
    that GET /.well-known/revoked-credentials never serves a stale 304 after a
    fresh revocation.
    """
    try:
        from redis.asyncio import Redis

        from dcc_auth.routes_crl import crl_add

        redis_url = get_settings().redis_url  # type: ignore[attr-defined]
        if not redis_url:
            return
        async with Redis.from_url(redis_url, decode_responses=True) as r:
            await crl_add(r, cert_id, int(expires_at.timestamp()))
    except Exception:
        log.warning("redis CRL push failed for cert_id=%s", cert_id, exc_info=True)


async def _cookie_user_and_session(
    request: Request, db: AsyncSession
) -> tuple[User, UserSession]:
    raw = request.cookies.get("pulse_session")
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing session cookie")
    try:
        sid = uuid.UUID(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid session cookie"
        ) from exc
    session_row = await validate_session(db, sid)
    if session_row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="session expired or not found"
        )
    user = await db.get(User, session_row.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    if user.disabled or user.is_suspended:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
    return user, session_row


@router.post("/issue", response_model=CredentialIssueResponse, status_code=200)
async def issue_credential(
    payload: CredentialIssueRequest,
    request: Request,
    db: SessionDep,
) -> CredentialIssueResponse:
    user, session_row = await _cookie_user_and_session(request, db)

    if payload.acr_values == "mfa" and session_row.acr != "1":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="mfa_step_up_required")

    now = datetime.now(UTC)
    if user.revoke_until is not None:
        watermark = (
            user.revoke_until.replace(tzinfo=UTC)
            if user.revoke_until.tzinfo is None
            else user.revoke_until
        )
        if now < watermark + timedelta(seconds=_REVOKE_WINDOW_GRACE_SECONDS):
            raise HTTPException(status.HTTP_409_CONFLICT, detail="account_in_revoke_window")

    pubkey_bytes = _decode_pubkey(payload.device_pubkey)

    # Idempotenz-Check vor Rate-Limit: ein Re-Issue mit demselben Pubkey
    # (Recovery-Flow, Tab-Reload, Re-Mount nach Logout/Login auf demselben
    # Gerät) bedeutet keine neue Cert-Ausstellung — das bestehende Cert wird
    # nur frisch signiert. Soll daher kein Rate-Limit-Budget verbrauchen.
    existing_stmt = select(IssuedCredential).where(
        IssuedCredential.user_id == user.id,
        IssuedCredential.device_pubkey == pubkey_bytes,
        IssuedCredential.revoked_at.is_(None),
        IssuedCredential.expires_at > now,
    )
    existing = (await db.execute(existing_stmt)).scalars().first()
    if existing is not None:
        return CredentialIssueResponse(cert=_sign_credential_jwt(user, existing, session_row))

    # Echte Ausstellung — Rate-Limit gilt.
    await _check_rate_user(request, user.id)

    active = await _active_creds_for_user(db, user.id)
    if len(active) >= _MAX_ACTIVE_CERTS:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="device_limit_reached")

    cert_id = uuid.uuid4()
    expires_at = now + timedelta(days=_CERT_VALIDITY_DAYS)
    cred = IssuedCredential(
        cert_id=str(cert_id),  # type: ignore[arg-type]
        user_id=user.id,
        device_pubkey=pubkey_bytes,
        device_label=payload.device_label,
        issued_at=now,
        expires_at=expires_at,
    )
    db.add(cred)
    try:
        await db.flush()
    except IntegrityError:
        # Concurrent request won the race — the partial unique index on
        # (user_id, device_pubkey) WHERE revoked_at IS NULL rejected our INSERT.
        # Roll back and re-SELECT the winning row so we return idempotent output.
        await db.rollback()
        # Re-build the lookup without reusing the pre-rollback stmt object to
        # avoid any session-level cache or stale-object effects.
        winner_stmt = select(IssuedCredential).where(
            IssuedCredential.user_id == user.id,
            IssuedCredential.device_pubkey == pubkey_bytes,
            IssuedCredential.revoked_at.is_(None),
        )
        winner = (await db.execute(winner_stmt)).scalars().first()
        if winner is None:
            # Should not happen: the constraint fired but no active row found.
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail="concurrent_issue_conflict"
            )
        # user object may be expired after rollback — refresh it for JWT signing.
        await db.refresh(user)
        return CredentialIssueResponse(cert=_sign_credential_jwt(user, winner, session_row))
    cert_jwt = _sign_credential_jwt(user, cred, session_row)
    await db.commit()
    return CredentialIssueResponse(cert=cert_jwt)


def _sign_credential_jwt(user: User, cred: IssuedCredential, session_row: UserSession) -> str:
    signer = get_signer()
    settings = get_settings()
    expires_at = cred.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    payload: dict = {
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "sub": str(user.id),
        "typ": "credential",
        "cert_id": str(cred.cert_id),
        "user_id": str(user.id),
        # Base64URL ohne Padding — symmetrisch zu _decode_pubkey() und zum
        # credential_validator im chat-gateway (siehe credential_validator.py
        # ``Base64url-encoded``-Kommentar). Standard-b64 würde ``+``/``/``-
        # Zeichen produzieren, die der ``urlsafe_b64decode``-Reader auf der
        # anderen Seite nicht versteht.
        "device_pubkey": base64.urlsafe_b64encode(cred.device_pubkey).rstrip(b"=").decode(),
        "device_label": cred.device_label,
        "pairwise_seed": base64.urlsafe_b64encode(user.pairwise_salt).rstrip(b"=").decode(),
        "amr": session_row.amr,
        "acr": session_row.acr,
        "iat": int(time.time()),
        "exp": int(expires_at.timestamp()),
    }
    return signer._sign(payload)  # noqa: SLF001


@router.get("/list", response_model=CredentialListResponse)
async def list_credentials(request: Request, db: SessionDep) -> CredentialListResponse:
    user, _ = await _cookie_user_and_session(request, db)
    active = await _active_creds_for_user(db, user.id)
    return CredentialListResponse(devices=[_credential_to_device(c) for c in active])


@router.post("/{cert_id}/revoke", status_code=204)
async def revoke_credential(cert_id: str, request: Request, db: SessionDep) -> None:
    user, _ = await _cookie_user_and_session(request, db)
    try:
        cert_uuid = uuid.UUID(cert_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="credential not found") from exc
    cred = await db.get(IssuedCredential, str(cert_uuid))
    if cred is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="credential not found")
    if cred.user_id != user.id and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="forbidden")
    now = datetime.now(UTC)
    cred.revoked_at = now
    await db.flush()
    expires_at = cred.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    await _push_to_redis_crl(str(cert_uuid), expires_at)
    await db.commit()
    return None
