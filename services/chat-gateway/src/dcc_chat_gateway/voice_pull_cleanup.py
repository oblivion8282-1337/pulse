"""Revoke + reaper for temporary voice-pull grants.

``revoke_voice_pull`` is the single path that removes one pull grant: the
``channel_voice_pulls`` marker row, the pull's ``VIEW_CHANNEL|CONNECT``
bits from the user-overwrite (row deleted only when fully empty, so a
coexisting permanent grant survives), the Redis leave-check marker, and
the invalidation events (``channel_permissions_updated`` +
``channel_hidden``).

Called from two places:

* ``routes/internal.py`` — voice-signaling signals "target left the
  channel" (authoritative; the ``participant_left`` webhook).
* ``voice_pull_reaper_loop`` — backstop for grants the webhook missed
  (network blip) or that the target never connected to.

Fail-safes:

* Idempotent — no marker row ⇒ no-op. A stale Redis marker therefore can
  never cause a permanent user-overwrite to be touched.
* The reaper only revokes when Redis *confirms* the user is absent from
  the channel's presence set; on Redis error it skips the row (never
  yanks a grant from a user who is still in the call).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from dcc_shared.events import ChannelHiddenEvent
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from dcc_chat_gateway.models import Channel, ChannelVoicePull, PermissionOverwrite
from dcc_chat_gateway.permissions import OVERWRITE_TARGET_USER, Permissions
from dcc_chat_gateway.routes.permission_overwrites import (
    _fetch_all_overwrites,
    _overwrite_dict,
    _publish_perms_event,
)

log = logging.getLogger(__name__)

# Fixed bitset a pull grants — kept here (not in the route) so revoke masks
# off exactly the same bits that pull set.
_PULL_ALLOW = int(Permissions.VIEW_CHANNEL) | int(Permissions.CONNECT)

# Voice-presence set key — synchron mit voice-signaling
# (``_room_for_channel`` ⇒ room ``channel-<id>``, key ``voice:room:{room}``).
_PRESENCE_KEY = "voice:room:channel-{channel_id}"

# Redis leave-check marker written by the pull endpoint.
_MARKER_KEY = "voice_pull:channel-{channel_id}:user-{user_id}"


def marker_key(channel_id: int, user_id: int) -> str:
    return _MARKER_KEY.format(channel_id=channel_id, user_id=user_id)


def _presence_key(channel_id: int) -> str:
    return _PRESENCE_KEY.format(channel_id=channel_id)


async def revoke_voice_pull(
    session,
    *,
    channel_id: int,
    user_id: int,
    manager=None,
    redis=None,
) -> bool:
    """Revoke one voice-pull grant. Returns True if a grant was found and
    removed, False if none existed (idempotent no-op)."""
    pull = await session.get(ChannelVoicePull, (channel_id, user_id))
    if pull is None:
        return False

    channel = await session.get(Channel, channel_id)  # for guild_id; may be None
    await session.delete(pull)

    # Mask off only the pull bits — a coexisting permanent user-overwrite
    # (extra allow/deny bits) is preserved; drop the row only if empty.
    overwrite = await session.get(
        PermissionOverwrite, (channel_id, OVERWRITE_TARGET_USER, user_id)
    )
    if overwrite is not None:
        overwrite.allow_bf &= ~_PULL_ALLOW
        if overwrite.allow_bf == 0 and overwrite.deny_bf == 0:
            await session.delete(overwrite)

    await session.commit()

    if redis is not None:
        try:
            await redis.delete(marker_key(channel_id, user_id))
        except Exception:  # noqa: BLE001 — best-effort; reaper is the backstop
            log.warning("voice_pull: could not clear redis marker cid=%s uid=%s", channel_id, user_id)

    if manager is not None and channel is not None:
        overwrites = [_overwrite_dict(ow) for ow in await _fetch_all_overwrites(session, channel_id)]
        await _publish_perms_event(manager, session, channel_id, channel.guild_id, overwrites)
        await manager.publish_user_event(
            user_id,
            ChannelHiddenEvent(guild_id=str(channel.guild_id), channel_id=str(channel_id)),
        )
    return True


async def _reap_once(engine: AsyncEngine, redis, grace_s: int, manager=None) -> int:
    """Revoke grants whose target is no longer in the channel and whose
    ``granted_at`` is older than ``grace_s``. Returns the count revoked.

    ``manager`` is forwarded to ``revoke_voice_pull`` so a reaper-driven
    cleanup also publishes ``channel_hidden`` — otherwise the client sidebar
    keeps a stale entry until its next reconnect even though the server has
    already withdrawn the grant."""
    if redis is None:
        return 0
    cutoff = datetime.now(UTC) - timedelta(seconds=grace_s)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    revoked = 0
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(ChannelVoicePull).where(ChannelVoicePull.granted_at < cutoff)
            )
        ).scalars().all()
        for row in rows:
            # Fail-safe: only revoke when Redis CONFIRMS absence. On any
            # Redis error leave the grant alone (next pass retries).
            try:
                still_present = await redis.sismember(
                    _presence_key(row.channel_id), str(row.user_id)
                )
            except Exception:  # noqa: BLE001
                log.warning("voice_pull_reaper: redis check failed cid=%s — skipping", row.channel_id)
                continue
            if still_present:
                continue
            if await revoke_voice_pull(
                session,
                channel_id=row.channel_id,
                user_id=row.user_id,
                manager=manager,
                redis=redis,
            ):
                revoked += 1
    return revoked


async def voice_pull_reaper_loop(settings, engine: AsyncEngine, redis, manager=None) -> None:
    """Sweep stale voice-pull grants on a fixed cadence."""
    interval_s = settings.voice_pull_reaper_interval_seconds
    grace_s = settings.voice_pull_reaper_grace_seconds
    log.info("voice_pull_reaper start interval_s=%d grace_s=%d", interval_s, grace_s)
    while True:
        await asyncio.sleep(interval_s)
        try:
            n = await _reap_once(engine, redis, grace_s, manager)
            if n:
                log.info("voice_pull_reaper revoked %d stale grant(s)", n)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("voice_pull_reaper_failed")


__all__ = ["revoke_voice_pull", "voice_pull_reaper_loop", "marker_key", "_PULL_ALLOW"]
