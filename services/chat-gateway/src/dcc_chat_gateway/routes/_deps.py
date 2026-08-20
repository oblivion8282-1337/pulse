"""Shared dependencies and membership helpers for chat-gateway routers."""

from __future__ import annotations

from fastapi import Depends, HTTPException, status
from sqlalchemy import select

from dcc_chat_gateway.models import Channel, DirectMessageChannel, Guild, GuildMember


async def is_guild_suspended(session, guild_id: int) -> bool:
    """True iff the community is platform-suspended (frozen by the operator).

    A light PK-scoped scalar lookup. Used by the membership-only guards below
    to fully freeze a suspended guild — including read access — which the
    permission overlay (``permissions._load_context``) alone would leave
    read-open (it only zeroes *permission* checks). These guards have no
    ``is_admin`` context, so the freeze here applies to everyone; a global
    admin who needs the content unfreezes first (or uses the owner tools)."""
    suspended_at = (
        await session.execute(select(Guild.suspended_at).where(Guild.id == guild_id))
    ).scalar_one_or_none()
    return suspended_at is not None


async def require_cloud() -> None:
    """FastAPI dependency — raises 404 on self-host instances.

    The Friend/DM/Block social layer is cloud-only (global identity).
    Self-host instances do not serve these routes; the underlying DB tables
    are left intact (harmless dead weight — the Cloud needs them in its own
    schema). Returning 404 (not 403) avoids leaking that the route exists.

    Late-imports ``get_settings`` so that test fixtures which replace
    ``dcc_chat_gateway.config.get_settings`` at the module level are
    respected at dependency-evaluation time (not at import time).
    """
    import dcc_chat_gateway.config as _cfg  # noqa: PLC0415

    if _cfg.get_settings().pulse_instance_mode != "cloud":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")


#: Shorthand for ``Depends(require_cloud)`` — import this in router files.
CloudOnly = Depends(require_cloud)


async def require_member(session, guild_id: int, user_id: int) -> None:
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this guild")
    if await is_guild_suspended(session, guild_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="community is suspended")


async def is_guild_member(session, guild_id: int, user_id: int) -> bool:
    """Wie ``require_member``, aber ohne zu werfen.

    Gebraucht dort, wo ein 403 die falsche Antwort wäre — etwa beim Prüfen
    einer FREMDEN Community, deren blosse Existenz ein 403 verriete
    (``routes/devices.py::_ziel_standplatz``). Bewusst schmal: prüft nur die
    Mitgliedschaft, nicht die Suspendierung — der Aufrufer entscheidet selbst,
    was eine fehlende Mitgliedschaft für ihn bedeutet.
    """
    member = await session.get(GuildMember, (guild_id, user_id))
    return member is not None


async def channel_membership(session, channel_id: int, user_id: int) -> Channel | None:
    channel = await session.get(Channel, channel_id)
    if channel is None:
        return None
    member = await session.get(GuildMember, (channel.guild_id, user_id))
    if member is None:
        return None
    if await is_guild_suspended(session, channel.guild_id):
        return None
    return channel


async def dm_member_check(
    session, dm_channel_id: int, user_id: int
) -> DirectMessageChannel | None:
    """Return the DM channel iff user_id is one of its two members."""
    dm = await session.get(DirectMessageChannel, dm_channel_id)
    if dm is None:
        return None
    if user_id not in (dm.user_a_id, dm.user_b_id):
        return None
    return dm


async def resolve_channel_for_user(
    session, channel_id: int, user_id: int
) -> tuple[str, Channel] | tuple[str, DirectMessageChannel] | None:
    """Look up ``channel_id`` in both guild channels and DM channels.

    Returns ``("guild", Channel)`` or ``("dm", DirectMessageChannel)`` if
    ``user_id`` has access, else ``None``. Snowflake IDs are globally
    unique across both tables (same generator), so the order of lookup
    is irrelevant for correctness — we try guild first because that's
    by far the more common case.

    Access semantics:
      - guild channel → user must be in ``guild_members``
      - dm channel    → user must be ``user_a_id`` or ``user_b_id``

    For routes that need to distinguish 404 (channel doesn't exist) from
    403 (exists, no access), prefer ``resolve_channel_or_raise`` — this
    helper collapses both into ``None``.
    """
    channel = await channel_membership(session, channel_id, user_id)
    if channel is not None:
        return ("guild", channel)
    dm = await dm_member_check(session, channel_id, user_id)
    if dm is not None:
        return ("dm", dm)
    return None


async def resolve_channel_or_raise(
    session, channel_id: int, user_id: int
) -> tuple[str, Channel] | tuple[str, DirectMessageChannel]:
    """Resolve a polymorphic channel id, raising the right HTTP status.

    Status-code semantics (matches existing guild-channel behavior so
    existing tests stay green):
      - 404 ``channel not found`` — id matches no channel at all
      - 403 ``not a member of this guild`` — guild channel but user
            isn't in ``guild_members``
      - 404 ``channel not found`` — DM channel but user isn't a member
            (deliberately a 404, not 403: DM channel ids are enumerable
            snowflakes, so we don't want to leak their existence)
    """
    channel = await session.get(Channel, channel_id)
    if channel is not None:
        member = await session.get(GuildMember, (channel.guild_id, user_id))
        if member is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, detail="not a member of this guild"
            )
        if await is_guild_suspended(session, channel.guild_id):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, detail="community is suspended"
            )
        return ("guild", channel)

    dm = await session.get(DirectMessageChannel, channel_id)
    if dm is not None:
        if user_id not in (dm.user_a_id, dm.user_b_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
        return ("dm", dm)

    raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
