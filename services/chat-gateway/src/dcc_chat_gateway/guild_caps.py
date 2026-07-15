"""Per-community scale-cap enforcement (Boost foundation, Etappe 3.3/3.4).

Server-enforced count checks for the Cloud-operator-set per-guild caps
(``max_members`` / ``max_channels`` / ``max_roles``). Each helper is a no-op
when the cap is NULL (unlimited) and raises 403 when the current count already
meets the cap — called right before the relevant insert.

SELECT-count-then-INSERT is not atomic, so a concurrent burst can exceed a cap
by a small margin. This matches the existing ban-race tolerance in the join
paths and is acceptable for a cost cap (not a security boundary).

The concurrent-HQ-stream cap lives at the stream-token issuance point
(``routes/streaming.py``), not here, because it counts live-stream Redis state
rather than a DB row.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Channel, Guild, GuildMember, Role


async def _cap_and_count(
    session: AsyncSession, guild_id: int, cap_attr: str, count_stmt
) -> None:
    guild = await session.get(Guild, guild_id)
    cap = getattr(guild, cap_attr) if guild else None
    if cap is None:
        return
    current = (await session.execute(count_stmt)).scalar_one()
    if current >= cap:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=f"community {cap_attr} limit reached ({current}/{cap})",
        )


async def enforce_member_cap(session: AsyncSession, guild_id: int) -> None:
    """Raise 403 if adding a member would exceed ``max_members``. The guild
    owner's own membership (guild creation) is not routed through here, so it is
    exempt by construction."""
    await _cap_and_count(
        session,
        guild_id,
        "max_members",
        select(func.count()).select_from(GuildMember).where(GuildMember.guild_id == guild_id),
    )


async def enforce_channel_cap(session: AsyncSession, guild_id: int) -> None:
    """Raise 403 if creating a channel would exceed ``max_channels`` (counts
    all channel types)."""
    await _cap_and_count(
        session,
        guild_id,
        "max_channels",
        select(func.count()).select_from(Channel).where(Channel.guild_id == guild_id),
    )


async def enforce_role_cap(session: AsyncSession, guild_id: int) -> None:
    """Raise 403 if creating a role would exceed ``max_roles``. The auto-seeded
    @everyone role is excluded from the count."""
    await _cap_and_count(
        session,
        guild_id,
        "max_roles",
        select(func.count())
        .select_from(Role)
        .where(Role.guild_id == guild_id, Role.is_everyone.is_(False)),
    )
