"""DB helpers for the Self-Host instance join gate.

Thin, focused helpers over :class:`InstanceMember` / :class:`InstanceJoinInvite`
used by the cert-login join gate (``routes/cert_login.py``) and the admin
join-invite routes. Kept stateless — the caller owns commit/rollback.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Guild, GuildInvite, InstanceJoinInvite, InstanceMember

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


async def community_invite_grants_access(
    session: AsyncSession, code: str
) -> bool:
    """True iff ``code`` is a **live** community (``GuildInvite``) invite.

    This is the Self-Host *instance*-membership grant for the Community-Invite
    flow (Stufe 2 / B-lite): a valid community invite is itself the permission
    to join the instance — no separate ``InstanceJoinInvite`` join_code needed.

    Deliberately *non-consuming*: it only checks current validity (not revoked,
    not expired, not use-exhausted). The invite's single ``use`` is consumed
    later by ``invites.py::accept_invite`` when the user actually joins the
    community. Granting instance access here without burning a use mirrors the
    real lock semantics — instance membership is a coarser gate than community
    membership, and a user may legitimately re-auth (mint a fresh session) many
    times against one community invite.

    An empty/unknown/revoked/expired/exhausted code returns ``False`` → the
    caller grants nothing. (Replay-safety: because this reads live state, a
    code that was revoked or whose use-budget the host later exhausts stops
    granting access immediately on the next cert-login.)

    Deliberately **not guild-scoped**: this only asserts the code is a live
    invite *of this instance*, not that it points at a specific community. Any
    live ``GuildInvite`` of the instance therefore grants *instance* access —
    that's fine, because instance membership is only the coarse gate. The real
    per-community check happens in ``accept_invite`` (atomic guarded UPDATE,
    correct guild binding, burns the use). Same trust level as a public
    ``join_code``: knowing any live invite of the instance lets you in the door;
    the sensitive resource (community membership) is gated separately.
    """
    if not code:
        return False
    inv = await session.get(GuildInvite, code)
    if inv is None or inv.revoked_at is not None:
        return False
    now = datetime.now(tz=UTC)
    expires_at = inv.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at is not None and expires_at <= now:
        return False
    if inv.max_uses is not None and inv.uses >= inv.max_uses:
        return False
    return True


async def public_community_grants_access(
    session: AsyncSession, handle: str
) -> bool:
    """True iff ``handle`` names a **public** community on this instance.

    The Self-Host *instance*-membership grant for the public-address flow
    (Stufe 4 / Entscheidung 5): a public community is its own permission to
    join the instance — community-scoped, ``join_mode``-independent.

    Unlike ``community_invite_grants_access`` (which deliberately does NOT bypass
    ``closed``), a public-community grant is checked **before** the ``join_mode``
    branch in the gate and therefore admits even in ``closed`` mode. Rationale
    (plan Entscheidung 5 + the Stufe-4 note): a community publicly opening its
    doors is its own decision; the legacy instance lock does not gate it. The
    future single "Server gesperrt" not-aus toggle (Stufe 5) will override even
    this — it does not exist yet, so today the only gate is the ``is_public``
    flag itself.

    An empty/unknown handle, or one that resolves to a *non-public* community,
    returns ``False`` → the caller grants nothing. Reading live state means a
    community flipped back to private stops granting access immediately on the
    next cert-login (replay-safe — no state carried over time).
    """
    if not handle:
        return False
    guild = (
        await session.execute(select(Guild).where(Guild.handle == handle))
    ).scalar_one_or_none()
    return guild is not None and guild.is_public


__all__ = [
    "JOIN_MODES",
    "add_member",
    "community_invite_grants_access",
    "is_member",
    "public_community_grants_access",
    "redeem_join_invite",
]
