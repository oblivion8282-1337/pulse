"""DB helpers for the Self-Host instance join gate.

Thin, focused helpers over :class:`InstanceMember` / :class:`InstanceJoinInvite`
used by the cert-login join gate (``routes/cert_login.py``) and the admin
join-invite routes. Kept stateless — the caller owns commit/rollback.
"""

from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import InstanceJoinInvite, InstanceMember

# Allowed values for ``chat_settings.join_mode`` (mirrored in the admin schema).
JOIN_MODES: frozenset[str] = frozenset({"open", "invite_only", "closed"})


async def is_member(session: AsyncSession, user_identifier: str) -> bool:
    """True iff ``user_identifier`` has already joined this instance."""
    row = await session.get(InstanceMember, user_identifier)
    return row is not None


async def add_member(
    session: AsyncSession, user_identifier: str, joined_via: str | None
) -> None:
    """Idempotently record a member. No-op (keeps the original ``joined_via``)
    if the user already joined — the first provenance wins."""
    if await is_member(session, user_identifier):
        return
    session.add(
        InstanceMember(user_identifier=user_identifier, joined_via=joined_via)
    )
    await session.flush()


async def redeem_join_invite(session: AsyncSession, code: str) -> bool:
    """Atomically spend one use of ``code``; return True on success.

    Single guarded UPDATE (no read-then-write race): a code is spendable iff it
    is not revoked, not expired, and either unlimited or below ``max_uses``.
    ``rowcount == 1`` means this caller won the use; concurrent redemptions of a
    single-use code can never over-spend it.
    """
    now = func.now()
    stmt = (
        update(InstanceJoinInvite)
        .where(
            InstanceJoinInvite.code == code,
            InstanceJoinInvite.revoked.is_(False),
            (InstanceJoinInvite.expires_at.is_(None))
            | (InstanceJoinInvite.expires_at > now),
            (InstanceJoinInvite.max_uses.is_(None))
            | (InstanceJoinInvite.uses < InstanceJoinInvite.max_uses),
        )
        .values(uses=InstanceJoinInvite.uses + 1)
    )
    result = await session.execute(stmt)
    return result.rowcount == 1


__all__ = [
    "JOIN_MODES",
    "add_member",
    "is_member",
    "redeem_join_invite",
]
