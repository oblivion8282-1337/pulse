"""Encrypted server-vault endpoints — Zero-Knowledge E2E-Sync der Server-Liste.

PUT    /server-vault  -- upsert the user's encrypted server-list vault
GET    /server-vault  -- fetch the vault blob (404 if none)
DELETE /server-vault  -- remove the vault

One vault per user.  The Cloud stores ONLY ciphertext; the plaintext (the list
of self-host instances the user has joined) and the Master-Passwort never leave
the browser.  Auth mirrors ``routes_backups`` (``pulse_session`` cookie).
"""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from dcc_auth.browser_sessions import validate_session
from dcc_auth.db import SessionDep
from dcc_auth.models import EncryptedServerVault, User

router = APIRouter(prefix="/server-vault", tags=["server-vault"])


# ---------------------------------------------------------------------------
# Auth helper (mirrors _require_user in routes_backups)
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


class VaultUpsertRequest(BaseModel):
    """Body for PUT /server-vault."""

    # max_length bounds gegen Storage-Abuse (analog routes_backups.py): ein
    # authentifizierter User könnte sonst beliebig große Blobs in die DB pushen.
    # 64 KiB base64 (~48 KiB Klartext) reicht für eine große Self-Host-Server-Liste.
    encrypted_blob: str = Field(..., min_length=1, max_length=65_536, description="base64 AES-GCM ciphertext")
    kdf_salt: str = Field(..., min_length=1, max_length=128, description="base64 16-byte KDF salt")
    kdf_params: str = Field(..., min_length=1, max_length=512, description="KDF params JSON string")
    gcm_nonce: str = Field(..., min_length=1, max_length=128, description="base64 12-byte AES-GCM nonce")


class VaultMetaResponse(BaseModel):
    """Response for PUT /server-vault (no blob returned)."""

    created_at: datetime
    updated_at: datetime


class VaultFetchResponse(BaseModel):
    """Response for GET /server-vault."""

    encrypted_blob: str
    kdf_salt: str
    kdf_params: str
    gcm_nonce: str
    created_at: datetime
    updated_at: datetime


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.put("", response_model=VaultMetaResponse, status_code=200)
async def upsert_vault(
    payload: VaultUpsertRequest,
    request: Request,
    db: SessionDep,
) -> VaultMetaResponse:
    """Upsert the user's encrypted server-vault (one slot per user)."""
    user = await _require_user(request, db)

    blob_bytes = _decode_b64_field(payload.encrypted_blob, "encrypted_blob")
    salt_bytes = _decode_b64_field(payload.kdf_salt, "kdf_salt")
    nonce_bytes = _decode_b64_field(payload.gcm_nonce, "gcm_nonce")
    # Defense-in-depth: AES-GCM/Argon2id-Längen erzwingen, damit ein kaputter
    # Client keinen unentschlüsselbaren Blob für seine anderen Geräte ablegt.
    if len(salt_bytes) != 16:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="kdf_salt: must be 16 bytes"
        )
    if len(nonce_bytes) != 12:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="gcm_nonce: must be 12 bytes"
        )

    existing = await db.get(EncryptedServerVault, user.id)
    now = datetime.now(UTC)

    if existing is not None:
        existing.encrypted_blob = blob_bytes
        existing.kdf_salt = salt_bytes
        existing.kdf_params = payload.kdf_params
        existing.gcm_nonce = nonce_bytes
        existing.updated_at = now
        await db.flush()
        await db.commit()
        return VaultMetaResponse(created_at=existing.created_at, updated_at=now)

    vault = EncryptedServerVault(
        user_id=user.id,
        encrypted_blob=blob_bytes,
        kdf_salt=salt_bytes,
        kdf_params=payload.kdf_params,
        gcm_nonce=nonce_bytes,
    )
    db.add(vault)
    await db.flush()
    await db.commit()
    return VaultMetaResponse(created_at=vault.created_at, updated_at=vault.updated_at)


@router.get("", response_model=VaultFetchResponse, status_code=200)
async def fetch_vault(request: Request, db: SessionDep) -> VaultFetchResponse:
    """Return the user's encrypted server-vault, or 404 if none exists."""
    user = await _require_user(request, db)

    vault = await db.get(EncryptedServerVault, user.id)
    if vault is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="vault not found")

    return VaultFetchResponse(
        encrypted_blob=base64.b64encode(vault.encrypted_blob).decode(),
        kdf_salt=base64.b64encode(vault.kdf_salt).decode(),
        kdf_params=vault.kdf_params,
        gcm_nonce=base64.b64encode(vault.gcm_nonce).decode(),
        created_at=vault.created_at,
        updated_at=vault.updated_at,
    )


@router.delete("", status_code=204)
async def delete_vault(request: Request, db: SessionDep) -> None:
    """Delete the user's encrypted server-vault."""
    user = await _require_user(request, db)

    vault = await db.get(EncryptedServerVault, user.id)
    if vault is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="vault not found")

    await db.delete(vault)
    await db.commit()
    return None
