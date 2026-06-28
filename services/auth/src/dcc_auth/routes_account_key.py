"""Account-Key-Endpoints (Envelope-Encryption, ein Wiederherstellungs-Schlüssel pro Account).

GET /me/account-key  -- gewrappten Account-Key holen (404 = noch keiner)
PUT /me/account-key  -- anlegen oder (nur mit overwrite=true) ersetzen

Die Cloud speichert ausschließlich Chiffretext (Zero-Knowledge): ``wrapped_key``
ist der mit dem KDF-abgeleiteten Wrap-Schlüssel AES-GCM-verschlüsselte rohe
Account-Key. Der ``overwrite``-Guard verhindert, dass ein zweites Gerät den AK
versehentlich ersetzt (das würde alle AK-verschlüsselten Blobs des Accounts
unlesbar machen) — Ersetzen ist dem expliziten Passwort-Wechsel-Flow vorbehalten.
"""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from dcc_auth.browser_sessions import validate_session
from dcc_auth.db import SessionDep
from dcc_auth.models import AccountKey, User

router = APIRouter(tags=["account-key"])


async def _require_user(request: Request, db) -> User:
    """Validate session cookie → User. Raises HTTP 401 on failure."""
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


class AccountKeyUpsertRequest(BaseModel):
    # max_length-Grenzen gegen Storage-Abuse (analog routes_backups.py): ein
    # authentifizierter User könnte sonst beliebig große Blobs in die DB pushen.
    wrapped_key: str = Field(..., min_length=1, max_length=65_536, description="base64 AES-GCM ciphertext of raw AK")
    kdf_salt: str = Field(..., min_length=1, max_length=128, description="base64 16-byte KDF salt")
    kdf_params: str = Field(..., min_length=1, max_length=512, description="KDF params JSON string")
    gcm_nonce: str = Field(..., min_length=1, max_length=128, description="base64 12-byte AES-GCM nonce")
    # Ersetzen nur explizit (Passwort-Wechsel) — schützt vor versehentlichem
    # Überschreiben durch ein zweites Gerät im "Erstellen"-Pfad.
    overwrite: bool = False


class AccountKeyResponse(BaseModel):
    wrapped_key: str
    kdf_salt: str
    kdf_params: str
    gcm_nonce: str
    created_at: datetime
    updated_at: datetime


def _decode_b64(value: str, field_name: str) -> bytes:
    try:
        padding = 4 - len(value) % 4
        return base64.b64decode(value + ("=" * (padding % 4)))
    except Exception as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name}: invalid base64",
        ) from exc


@router.get("/me/account-key", response_model=AccountKeyResponse)
async def fetch_account_key(request: Request, db: SessionDep) -> AccountKeyResponse:
    """Gewrappten Account-Key des eingeloggten Users holen (404 = keiner)."""
    user = await _require_user(request, db)
    row = await db.get(AccountKey, user.id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no account key")
    return AccountKeyResponse(
        wrapped_key=base64.b64encode(row.wrapped_key).decode(),
        kdf_salt=base64.b64encode(row.kdf_salt).decode(),
        kdf_params=row.kdf_params,
        gcm_nonce=base64.b64encode(row.gcm_nonce).decode(),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.put("/me/account-key", response_model=AccountKeyResponse)
async def upsert_account_key(
    payload: AccountKeyUpsertRequest,
    request: Request,
    db: SessionDep,
) -> AccountKeyResponse:
    """Account-Key anlegen; ersetzen nur mit ``overwrite=true`` (sonst 409)."""
    user = await _require_user(request, db)

    wrapped = _decode_b64(payload.wrapped_key, "wrapped_key")
    salt = _decode_b64(payload.kdf_salt, "kdf_salt")
    nonce = _decode_b64(payload.gcm_nonce, "gcm_nonce")
    # Krypto-Hygiene: degenerierte Parameter ablehnen (User schadet sonst nur
    # sich selbst, aber explizit ist robuster).
    if len(salt) != 16:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="kdf_salt must be 16 bytes"
        )
    if len(nonce) != 12:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="gcm_nonce must be 12 bytes"
        )

    row = await db.get(AccountKey, user.id, with_for_update=True)
    now = datetime.now(UTC)

    if row is not None:
        if not payload.overwrite:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="account key already exists — pass overwrite=true to replace",
            )
        row.wrapped_key = wrapped
        row.kdf_salt = salt
        row.kdf_params = payload.kdf_params
        row.gcm_nonce = nonce
        row.updated_at = now
        await db.commit()
        return AccountKeyResponse(
            wrapped_key=payload.wrapped_key,
            kdf_salt=payload.kdf_salt,
            kdf_params=payload.kdf_params,
            gcm_nonce=payload.gcm_nonce,
            created_at=row.created_at,
            updated_at=now,
        )

    row = AccountKey(
        user_id=user.id,
        wrapped_key=wrapped,
        kdf_salt=salt,
        kdf_params=payload.kdf_params,
        gcm_nonce=nonce,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return AccountKeyResponse(
        wrapped_key=payload.wrapped_key,
        kdf_salt=payload.kdf_salt,
        kdf_params=payload.kdf_params,
        gcm_nonce=payload.gcm_nonce,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
