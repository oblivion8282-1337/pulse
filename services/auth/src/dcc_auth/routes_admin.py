"""Admin-only routes: user management, server settings, audit log.

Gated by ``_require_admin`` (re-exported from ``routes.py``) — non-admin
callers get 403, even with a valid bearer token. The JWT carries the
``admin`` claim, so this check is essentially "did your token-issue
time see ``users.is_admin = true``?" — re-checking the DB inside
``_require_admin`` catches the race where the column got flipped after
the token was minted.

Two write-actions side-effect:
* Demoting yourself from admin is blocked iff you'd be the last one
  (prevents accidental lockout). Demoting *someone else* down to last-
  admin = themselves is fine.
* Disabling a user revokes *all* of their refresh tokens immediately so
  they can't extend reach beyond the ≤15 min access-token TTL.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select, update

from dcc_auth.db import SessionDep
from dcc_auth.models import (
    AdminAuditLog,
    AuthSettings,
    RefreshToken,
    RegistrationInvite,
    User,
)
from dcc_auth.routes import _require_admin
from dcc_auth.schemas import (
    AdminAuditLogEntry,
    AdminStatsOut,
    AuthSettingsOut,
    AuthSettingsPatch,
    InviteCreateIn,
    InviteOut,
    UserAdminOut,
    UserAdminPatch,
)
from dcc_auth.snowflake import next_id

router = APIRouter(prefix="/admin")


def _audit(
    session,
    *,
    actor_id: int,
    action: str,
    target_id: int | None = None,
    payload: dict | None = None,
) -> None:
    session.add(
        AdminAuditLog(
            id=next_id(),
            actor_id=actor_id,
            action=action,
            target_id=target_id,
            payload=payload or {},
        )
    )


@router.get("/stats", response_model=AdminStatsOut)
async def get_stats(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """One COUNT-aggregate query — three numbers for the Übersicht-Tab."""
    row = (
        await session.execute(
            select(
                func.count().label("user_count"),
                func.count().filter(User.is_admin.is_(True)).label("admin_count"),
                func.count().filter(User.disabled.is_(True)).label("disabled_count"),
            ).select_from(User)
        )
    ).one()
    return AdminStatsOut(
        user_count=row.user_count,
        admin_count=row.admin_count,
        disabled_count=row.disabled_count,
    )


@router.get("/users", response_model=list[UserAdminOut])
async def list_users(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """Newest-first paginated list. Cursor: pass ``before=<last seen id>``.

    Snowflake IDs are time-ordered so this stays stable even with new
    registrations during paging.
    """
    stmt = select(User).order_by(User.id.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(User.id < before)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.patch("/users/{user_id}", response_model=UserAdminOut)
async def patch_user(
    user_id: int,
    payload: UserAdminPatch,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="user not found")

    changes: dict[str, Any] = {}

    if payload.is_admin is not None and payload.is_admin != user.is_admin:
        if not payload.is_admin and user.id == actor.id:
            other_admins = (
                await session.execute(
                    select(func.count())
                    .select_from(User)
                    .where(User.is_admin.is_(True), User.id != user.id)
                )
            ).scalar_one()
            if other_admins == 0:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    detail="cannot demote the last admin",
                )
        changes["is_admin"] = {"from": user.is_admin, "to": payload.is_admin}
        user.is_admin = payload.is_admin

    if payload.disabled is not None and payload.disabled != user.disabled:
        if payload.disabled and user.id == actor.id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, detail="cannot disable yourself"
            )
        changes["disabled"] = {"from": user.disabled, "to": payload.disabled}
        user.disabled = payload.disabled
        if payload.disabled:
            await session.execute(
                update(RefreshToken)
                .where(
                    RefreshToken.user_id == user_id,
                    RefreshToken.revoked_at.is_(None),
                )
                .values(revoked_at=datetime.now(UTC))
            )

    if changes:
        _audit(
            session,
            actor_id=actor.id,
            action="user.patch",
            target_id=user.id,
            payload=changes,
        )
        await session.commit()
        await session.refresh(user)

    return user


@router.get("/settings", response_model=AuthSettingsOut)
async def get_settings(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    row = await session.get(AuthSettings, 1)
    # Migration seeds the singleton at id=1, so this branch is only hit if
    # the DB was hand-tweaked. Fall back to the schema default.
    if row is None:
        return AuthSettingsOut(registration_mode="open")
    return row


@router.patch("/settings", response_model=AuthSettingsOut)
async def patch_settings(
    payload: AuthSettingsPatch,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    row = await session.get(AuthSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="auth_settings singleton missing — re-run migration 0004",
        )
    if row.registration_mode != payload.registration_mode:
        _audit(
            session,
            actor_id=actor.id,
            action="settings.patch",
            payload={
                "registration_mode": {
                    "from": row.registration_mode,
                    "to": payload.registration_mode,
                }
            },
        )
        row.registration_mode = payload.registration_mode
        await session.commit()
        await session.refresh(row)
    return row


# ---- Registration invites -----------------------------------------------


@router.get("/invites", response_model=list[InviteOut])
async def list_invites(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """All invite codes, newest first. Includes revoked/expired ones so the
    admin sees the full history (the UI greys out spent/dead codes)."""
    stmt = select(RegistrationInvite).order_by(RegistrationInvite.created_at.desc())
    return list((await session.execute(stmt)).scalars())


@router.post("/invites", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
async def create_invite(
    payload: InviteCreateIn,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    """Mint a fresh invite code. Only meaningful while ``registration_mode``
    is ``invite_only``, but creatable in any mode so the admin can prepare
    codes before flipping the switch."""
    expires_at = (
        datetime.now(UTC) + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days is not None
        else None
    )
    invite = RegistrationInvite(
        code=secrets.token_urlsafe(24),
        created_by=actor.id,
        expires_at=expires_at,
        max_uses=payload.max_uses,
        note=payload.note,
    )
    session.add(invite)
    _audit(
        session,
        actor_id=actor.id,
        action="invite.create",
        payload={"max_uses": payload.max_uses, "expires_in_days": payload.expires_in_days},
    )
    await session.commit()
    await session.refresh(invite)
    return invite


@router.delete("/invites/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(
    code: str,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    """Revoke a code (soft — row kept for the audit trail). Idempotent: a
    missing or already-revoked code still returns 204."""
    await session.execute(
        update(RegistrationInvite)
        .where(RegistrationInvite.code == code)
        .values(revoked=True)
    )
    _audit(session, actor_id=actor.id, action="invite.revoke", payload={"code": code})
    await session.commit()


@router.get("/audit-log", response_model=list[AdminAuditLogEntry])
async def get_audit_log(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """Newest-first, snowflake-id cursor (same pattern as ``/users``)."""
    stmt = select(AdminAuditLog).order_by(AdminAuditLog.id.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(AdminAuditLog.id < before)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)
