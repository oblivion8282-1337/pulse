"""Admin routes for Self-Host join-invite codes (``join_mode == invite_only``).

Mounted at ``/admin/join-invites`` on chat-gateway, gated by ``AdminUser`` (the
EdDSA session-token ``admin`` claim — the cert-login owner). Mirrors the
auth-svc ``/admin/invites`` shape, but a join-invite admits a cert-holder to
*this Self-Host instance* (consumed at cert-login), not a Cloud registration.

``created_by`` is the admin's ``user_identifier`` (a pairwise-sub string on
self-host). Create/revoke each append a ``ModAuditLog`` row under the sentinel
guild 0 (instance-wide, not guild-scoped — same convention as admin_members).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import InstanceJoinInvite
from dcc_chat_gateway.security import AdminUser

router = APIRouter(prefix="/admin/join-invites")

# Instance-wide actions aren't guild-scoped; ModAuditLog needs a BIGINT
# guild_id, so we record them under the sentinel guild 0.
_INSTANCE_GUILD = 0


class JoinInviteCreateIn(BaseModel):
    expires_in_days: int | None = Field(default=None, ge=1, le=365)
    max_uses: int | None = Field(default=None, ge=1, le=100_000)
    note: str | None = Field(default=None, max_length=100)


class JoinInviteOut(BaseModel):
    model_config = {"from_attributes": True}

    code: str
    created_by: str
    created_at: datetime
    expires_at: datetime | None
    max_uses: int | None
    uses: int
    revoked: bool
    note: str | None


@router.get("", response_model=list[JoinInviteOut])
async def list_join_invites(
    session: SessionDep, _actor: AdminUser
) -> list[InstanceJoinInvite]:
    """All join-invite codes, newest first (includes revoked/spent for history)."""
    stmt = select(InstanceJoinInvite).order_by(InstanceJoinInvite.created_at.desc())
    return list((await session.execute(stmt)).scalars())


@router.post("", response_model=JoinInviteOut, status_code=status.HTTP_201_CREATED)
async def create_join_invite(
    payload: JoinInviteCreateIn,
    session: SessionDep,
    actor: AdminUser,
) -> InstanceJoinInvite:
    """Mint a fresh join-invite code. Creatable in any join-mode so the admin
    can prepare codes before flipping to ``invite_only``."""
    expires_at = (
        datetime.now(UTC) + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days is not None
        else None
    )
    invite = InstanceJoinInvite(
        code=secrets.token_urlsafe(24),
        created_by=actor.user_identifier,
        expires_at=expires_at,
        max_uses=payload.max_uses,
        note=payload.note,
    )
    session.add(invite)
    await write_audit_log(
        session,
        guild_id=_INSTANCE_GUILD,
        actor_user_id=actor.id,
        action_type="join_invite_create",
        target_kind=None,
        target_id=None,
        payload={"max_uses": payload.max_uses, "expires_in_days": payload.expires_in_days},
    )
    await session.commit()
    await session.refresh(invite)
    return invite


@router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_join_invite(
    code: str,
    session: SessionDep,
    actor: AdminUser,
) -> None:
    """Soft-revoke a code (row kept for the audit trail). Idempotent: a missing
    or already-revoked code still returns 204."""
    await session.execute(
        update(InstanceJoinInvite)
        .where(InstanceJoinInvite.code == code)
        .values(revoked=True)
    )
    await write_audit_log(
        session,
        guild_id=_INSTANCE_GUILD,
        actor_user_id=actor.id,
        action_type="join_invite_revoke",
        target_kind=None,
        target_id=None,
        payload={"code": code},
    )
    await session.commit()
