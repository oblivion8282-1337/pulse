"""Encrypted-key-backup endpoints (DE 11 Block 2.A).

POST   /credentials/{cert_id}/backup  -- upsert backup (max 1 per cert)
GET    /credentials/{cert_id}/backup  -- fetch backup blob
DELETE /credentials/{cert_id}/backup  -- remove backup
"""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.browser_sessions import validate_session
from dcc_auth.db import SessionDep
from dcc_auth.models import EncryptedKeyBackup, IssuedCredential, User

router = APIRouter(prefix="/credentials", tags=["backups"])


# ---------------------------------------------------------------------------
# Auth helper (mirrors _cookie_user_and_session in routes_credentials)
# ---------------------------------------------------------------------------


async def _require_user(request: Request, db) -> User:
    """Validate session cookie → User.  Raises HTTP 401 on failure."""
    raw = request.cookies.get("pulse_session")
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing session cookie")
    try:
        sid = uuid.UUID(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid session cookie"
        ) from exc
    row = await validate_session(db, sid)
    if row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="session expired or not found"
        )
    user = await db.get(User, row.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    if user.disabled or user.is_suspended:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
    return user


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class BackupUpsertRequest(BaseModel):
    """Body for POST /credentials/{cert_id}/backup."""

    encrypted_blob: str = Field(..., min_length=1, description="base64-encoded AES-GCM ciphertext")
    kdf_salt: str = Field(..., min_length=1, description="base64-encoded 16-byte KDF salt")
    kdf_params: str = Field(
        ..., min_length=1, description="KDF params JSON string, e.g. '{\"name\":\"PBKDF2\",...}'"
    )
    gcm_nonce: str = Field(..., min_length=1, description="base64-encoded 12-byte AES-GCM nonce")
    device_label: str = Field(..., min_length=1, max_length=64)


class BackupMetaResponse(BaseModel):
    """Response for POST /credentials/{cert_id}/backup (no blob returned)."""

    cert_id: str
    created_at: datetime
    updated_at: datetime


class BackupFetchResponse(BaseModel):
    """Response for GET /credentials/{cert_id}/backup."""

    cert_id: str
    device_label: str
    encrypted_blob: str
    kdf_salt: str
    kdf_params: str
    gcm_nonce: str
    created_at: datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decode_b64_field(value: str, field_name: str) -> bytes:
    try:
        padding = 4 - len(value) % 4
        return base64.b64decode(value + ("=" * (padding % 4)))
    except Exception as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name}: invalid base64",
        ) from exc


async def _own_cred(cert_id_str: str, user_id: int, db) -> IssuedCredential:
    """Fetch IssuedCredential and assert ownership.  Raises 404 on failure."""
    try:
        cert_uuid = uuid.UUID(cert_id_str)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="credential not found") from exc
    cred = await db.get(IssuedCredential, str(cert_uuid))
    if cred is None or cred.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="credential not found")
    return cred


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/{cert_id}/backup",
    response_model=BackupMetaResponse,
    status_code=200,
)
async def upsert_backup(
    cert_id: str,
    payload: BackupUpsertRequest,
    request: Request,
    db: SessionDep,
) -> BackupMetaResponse:
    """Upsert an encrypted key backup (max 1 per credential)."""
    user = await _require_user(request, db)
    cred = await _own_cred(cert_id, user.id, db)

    blob_bytes = _decode_b64_field(payload.encrypted_blob, "encrypted_blob")
    salt_bytes = _decode_b64_field(payload.kdf_salt, "kdf_salt")
    nonce_bytes = _decode_b64_field(payload.gcm_nonce, "gcm_nonce")

    # Eagerly load the existing backup row (if any).
    stmt = select(EncryptedKeyBackup).where(
        EncryptedKeyBackup.cert_id == str(cred.cert_id)
    )
    existing = (await db.execute(stmt)).scalars().first()
    now = datetime.now(UTC)

    if existing is not None:
        # Upsert: keep previous_blob for MP-Change-Flow (30d window).
        existing.previous_blob = existing.encrypted_blob
        existing.previous_replaced_at = now
        existing.encrypted_blob = blob_bytes
        existing.kdf_salt = salt_bytes
        existing.kdf_params = payload.kdf_params
        existing.gcm_nonce = nonce_bytes
        existing.device_label = payload.device_label
        await db.flush()
        await db.commit()
        return BackupMetaResponse(
            cert_id=str(cred.cert_id),
            created_at=existing.created_at,
            updated_at=now,
        )

    backup = EncryptedKeyBackup(
        cert_id=str(cred.cert_id),
        user_id=user.id,
        device_label=payload.device_label,
        encrypted_blob=blob_bytes,
        kdf_salt=salt_bytes,
        kdf_params=payload.kdf_params,
        gcm_nonce=nonce_bytes,
    )
    db.add(backup)
    await db.flush()
    await db.commit()
    return BackupMetaResponse(
        cert_id=str(cred.cert_id),
        created_at=backup.created_at,
        updated_at=backup.created_at,
    )


@router.get(
    "/{cert_id}/backup",
    response_model=BackupFetchResponse,
    status_code=200,
)
async def fetch_backup(
    cert_id: str,
    request: Request,
    db: SessionDep,
) -> BackupFetchResponse:
    """Return the encrypted key backup for a credential."""
    user = await _require_user(request, db)
    cred = await _own_cred(cert_id, user.id, db)

    stmt = select(EncryptedKeyBackup).where(
        EncryptedKeyBackup.cert_id == str(cred.cert_id)
    )
    backup = (await db.execute(stmt)).scalars().first()
    if backup is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="backup not found")

    return BackupFetchResponse(
        cert_id=str(cred.cert_id),
        device_label=backup.device_label,
        encrypted_blob=base64.b64encode(backup.encrypted_blob).decode(),
        kdf_salt=base64.b64encode(backup.kdf_salt).decode(),
        kdf_params=backup.kdf_params,
        gcm_nonce=base64.b64encode(backup.gcm_nonce).decode(),
        created_at=backup.created_at,
    )


@router.delete("/{cert_id}/backup", status_code=204)
async def delete_backup(
    cert_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Delete the encrypted key backup for a credential."""
    user = await _require_user(request, db)
    cred = await _own_cred(cert_id, user.id, db)

    stmt = select(EncryptedKeyBackup).where(
        EncryptedKeyBackup.cert_id == str(cred.cert_id)
    )
    backup = (await db.execute(stmt)).scalars().first()
    if backup is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="backup not found")

    await db.delete(backup)
    await db.commit()
    return None
