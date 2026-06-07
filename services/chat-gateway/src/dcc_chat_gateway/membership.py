"""DB helpers for the Self-Host instance join gate.

Thin, focused helpers over :class:`InstanceMember` used by the cert-login join
gate (``routes/cert_login.py``). Kept stateless — the caller owns
commit/rollback.

Access is decided per community (a friend community-invite grant or a public
address) with the single ``chat_settings.locked`` "Server gesperrt" not-aus
toggle on top — see :func:`is_instance_locked`. The former 3-way ``join_mode``
+ ``InstanceJoinInvite`` code system was removed in Stufe 5.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import ChatSettings, Guild, GuildInvite, InstanceMember


async def is_member(session: AsyncSession, user_identifier: str) -> bool:
    """True iff ``user_identifier`` has already joined this instance."""
    row = await session.get(InstanceMember, user_identifier)
    return row is not None


async def is_instance_locked(session: AsyncSession) -> bool:
    """True iff the "Server gesperrt" not-aus toggle is on.

    When locked the instance refuses **every** new join — the check sits at the
    very top of the gate, BEFORE any grant path, so it overrides both the
    community-invite grant and the public-community handle (Entscheidung 7 /
    Stufe 5). A missing singleton (broken deploy) is treated as **locked** —
    fail-closed: a missing row must never silently re-open the door.
    """
    row = await session.get(ChatSettings, 1)
    return row.locked if row is not None else True


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


async def community_invite_grants_access(
    session: AsyncSession, code: str
) -> bool:
    """True iff ``code`` is a **live** community (``GuildInvite``) invite.

    This is the Self-Host *instance*-membership grant for the Community-Invite
    flow (Stufe 2 / B-lite): a valid community invite is itself the permission
    to join the instance — no separate join code needed.

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

    This grant does NOT override the ``locked`` not-aus toggle — the gate checks
    ``locked`` first (Stufe 5), before any grant path, so a community invite can
    never bypass a sealed instance.

    Deliberately **not guild-scoped**: this only asserts the code is a live
    invite *of this instance*, not that it points at a specific community. Any
    live ``GuildInvite`` of the instance therefore grants *instance* access —
    that's fine, because instance membership is only the coarse gate. The real
    per-community check happens in ``accept_invite`` (atomic guarded UPDATE,
    correct guild binding, burns the use). Knowing any live invite of the
    instance lets you in the door; the sensitive resource (community membership)
    is gated separately.
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
    join the instance — community-scoped.

    A public-community grant is one of the two per-community access paths; both
    sit BELOW the single ``locked`` "Server gesperrt" not-aus toggle (Stufe 5),
    which the gate checks first and which overrides even a public community. As
    long as the instance is not locked, an ``is_public`` community admits anyone
    by handle (Entscheidung 5 — a community opening its doors is its own
    decision).

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
    "add_member",
    "community_invite_grants_access",
    "is_instance_locked",
    "is_member",
    "public_community_grants_access",
]
