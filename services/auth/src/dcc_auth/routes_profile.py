"""Profile-statement and profile-update routes (Block 1.D)."""

from __future__ import annotations

import base64
import time
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from dcc_auth.db import SessionDep
from dcc_auth.models import User, UsernameReservation
from dcc_auth.routes import _get_current_user, _signer_dep
from dcc_auth.schemas_profile import (
    ProfileUpdateRequest,
    UsernameChangeRequest,
    UsernameChangeResponse,
)
from dcc_auth.security import JwtSigner
from dcc_auth.username_suggestions import suggest_usernames as _suggest_usernames

router = APIRouter()

_STATEMENT_CACHE: dict[int, tuple[float, str]] = {}
_STATEMENT_TTL_SECS = 86_400


def _invalidate_statement_cache(user_id: int) -> None:
    _STATEMENT_CACHE.pop(user_id, None)


def _issue_statement(user: User, signer: JwtSigner) -> str:
    now = int(time.time())
    statement_id = str(uuid.uuid4())
    payload: dict = {
        "iss": signer._settings.jwt_issuer,
        "aud": signer._settings.jwt_audience,
        "sub": str(user.id),
        "jti": statement_id,
        "statement_id": statement_id,
        "iat": now,
        "exp": now + _STATEMENT_TTL_SECS,
        "typ": "profile_statement",
        # The chat-gateway validator gates on this purpose claim — without it
        # every real statement is rejected (the typ claim above is not checked).
        "purpose": "profile-statement",
        "username": user.username,
        # Self-Host-Validator (user_profile_cache.upsert_profile_statement)
        # verlangt einen non-null display_name. Hat der User keinen gesetzt,
        # auf den username zurückfallen — sonst wird das Statement verworfen
        # und der Self-Host kann den Member nie anzeigen (F19).
        "display_name": user.display_name or user.username,
        "avatar_hash": user.avatar_hash,
        "profile_color": user.profile_color,
        # Per-user pairwise seed (mirrors the Identity-Cert). Self-host
        # instances key the cached profile by the pairwise-sub derived from
        # this, so the statement must carry it.
        "pairwise_seed": base64.urlsafe_b64encode(user.pairwise_salt).rstrip(b"=").decode(),
    }
    token = signer._sign(payload)
    _STATEMENT_CACHE[user.id] = (float(now), token)
    return token


@router.get("/credentials/profile-statement")
async def get_profile_statement(
    session: SessionDep,
    current: User = Depends(_get_current_user),
    signer: JwtSigner = Depends(_signer_dep),
) -> dict:
    now_f = time.time()
    cached = _STATEMENT_CACHE.get(current.id)
    if cached is not None:
        issued_at, token = cached
        age = now_f - issued_at
        if age < _STATEMENT_TTL_SECS - 60:
            return {"token": token}
    return {"token": _issue_statement(current, signer)}


@router.post("/me/profile", status_code=status.HTTP_200_OK)
async def update_profile(
    payload: ProfileUpdateRequest,
    session: SessionDep,
    current: User = Depends(_get_current_user),
) -> dict:
    updated: list[str] = []
    sent = payload.model_fields_set
    if "display_name" in sent:
        current.display_name = payload.display_name
        updated.append("display_name")
    if "profile_color" in sent:
        current.profile_color = payload.profile_color
        updated.append("profile_color")
    if updated:
        session.add(current)
        await session.commit()
        await session.refresh(current)
        _invalidate_statement_cache(current.id)
    return {
        "updated": updated,
        "display_name": current.display_name,
        "avatar_hash": current.avatar_hash,
        "profile_color": current.profile_color,
    }


@router.post("/me/username", response_model=UsernameChangeResponse)
async def change_username(
    payload: UsernameChangeRequest,
    session: SessionDep,
    current: User = Depends(_get_current_user),
) -> UsernameChangeResponse:
    new_name = payload.new_username
    if new_name == current.username:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="new username is the same as current username",
        )
    existing_user = await session.scalar(select(User).where(User.username == new_name))
    if existing_user is not None:
        suggestions = await _suggest_usernames(session, new_name)
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail={"error": "username_taken", "suggestions": suggestions},
        )
    now = datetime.now(tz=UTC)
    reservation = await session.scalar(
        select(UsernameReservation).where(
            UsernameReservation.old_username == new_name,
            UsernameReservation.released_at > now,
        )
    )
    if reservation is not None:
        if reservation.original_user_id != current.id:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "username_reserved"})
        await session.delete(reservation)
        await session.flush()
    old_username = current.username
    released_at = now + timedelta(days=30)
    existing_old_res = await session.scalar(
        select(UsernameReservation).where(UsernameReservation.old_username == old_username)
    )
    if existing_old_res is not None:
        await session.delete(existing_old_res)
        await session.flush()
    session.add(UsernameReservation(
        old_username=old_username, original_user_id=current.id, released_at=released_at,
    ))
    current.username = new_name
    session.add(current)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "username_taken"}) from exc
    _invalidate_statement_cache(current.id)
    return UsernameChangeResponse(success=True, reserved_until=released_at)