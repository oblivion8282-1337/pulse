"""Instance-wide Member-Verwaltung (F11c) — Self-Host.

Listet die ``cached_user_profiles`` (= die Nutzer, die sich je per Cert-Login
auf dieser Instanz angemeldet haben) und erlaubt einem Cloud-Admin, einzelne
Nutzer **instanzweit** zu bannen. Ein Ban setzt ``banned_at``; der Cert-Login-
Handler verweigert dann das Session-Token (siehe ``routes/cert_login.py``).

Gated via ``AdminUser`` — der EdDSA-Session-Token-``admin``-Claim (Cert-Login-
Owner) reicht, kein auth-svc-Token nötig. Auf der Cloud gibt es keine pairwise-
sub-Profile zum Bannen; das Frontend rendert den Bereich nur auf Self-Host.

Jede Ban/Unban-Aktion schreibt einen ``ModAuditLog``-Eintrag (guild_id=0 →
instanzweit, nicht guild-scoped; das gebannte ``user_identifier`` steht im
``payload``, da ``target_id`` ein BigInteger ist und die ID hier TEXT ist).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CachedUserProfile
from dcc_chat_gateway.security import AdminUser

router = APIRouter(prefix="/admin/members")

# Instance-wide actions are not guild-scoped; ModAuditLog requires a BIGINT
# guild_id, so we record them under the sentinel guild 0.
_INSTANCE_GUILD = 0


class InstanceMemberOut(BaseModel):
    user_identifier: str
    username: str
    display_name: str
    avatar_hash: str | None
    banned_at: datetime | None
    ban_reason: str | None


class BanRequest(BaseModel):
    reason: str | None = None


def _to_out(row: CachedUserProfile) -> InstanceMemberOut:
    return InstanceMemberOut(
        user_identifier=row.user_identifier,
        username=row.username,
        display_name=row.display_name,
        avatar_hash=row.avatar_hash,
        banned_at=row.banned_at,
        ban_reason=row.ban_reason,
    )


async def _get_or_404(session, user_identifier: str) -> CachedUserProfile:
    row = await session.get(CachedUserProfile, user_identifier)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="member not found")
    return row


@router.get("", response_model=list[InstanceMemberOut])
async def list_members(session: SessionDep, _actor: AdminUser) -> list[InstanceMemberOut]:
    """All cached profiles — banned first, then alphabetical by username."""
    stmt = select(CachedUserProfile).order_by(
        CachedUserProfile.banned_at.is_(None),  # False (banned) sorts before True
        CachedUserProfile.username,
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [_to_out(r) for r in rows]


@router.post("/{user_identifier}/ban", response_model=InstanceMemberOut)
async def ban_member(
    user_identifier: str,
    payload: BanRequest,
    session: SessionDep,
    actor: AdminUser,
) -> InstanceMemberOut:
    """Set ``banned_at``/``ban_reason``. Idempotent (re-ban refreshes the reason)."""
    # Selbst-Bann blocken (wie bans.py): der cert-login-Owner ist vom Ban-Gate
    # ohnehin ausgenommen (cert_login.py „never lock themselves out"), ein
    # Self-Ban würde also nur einen verwirrenden „gebannt"-Status im Admin-Panel
    # + einen Audit-Eintrag gegen die eigene Identität erzeugen, ohne Wirkung.
    if actor.user_identifier and actor.user_identifier == user_identifier:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="cannot ban yourself")
    row = await _get_or_404(session, user_identifier)
    row.banned_at = datetime.now(timezone.utc)
    row.ban_reason = payload.reason
    await write_audit_log(
        session,
        guild_id=_INSTANCE_GUILD,
        actor_user_id=actor.id,
        action_type="instance_ban",
        target_kind="user",
        target_id=None,
        payload={"user_identifier": user_identifier, "reason": payload.reason},
    )
    await session.commit()
    await session.refresh(row)
    return _to_out(row)


@router.post("/{user_identifier}/unban", response_model=InstanceMemberOut)
async def unban_member(
    user_identifier: str,
    session: SessionDep,
    actor: AdminUser,
) -> InstanceMemberOut:
    """Clear ``banned_at``/``ban_reason``. Idempotent (no-op when not banned)."""
    row = await _get_or_404(session, user_identifier)
    row.banned_at = None
    row.ban_reason = None
    await write_audit_log(
        session,
        guild_id=_INSTANCE_GUILD,
        actor_user_id=actor.id,
        action_type="instance_unban",
        target_kind="user",
        target_id=None,
        payload={"user_identifier": user_identifier},
    )
    await session.commit()
    await session.refresh(row)
    return _to_out(row)
