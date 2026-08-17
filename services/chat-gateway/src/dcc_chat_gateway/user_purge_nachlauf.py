"""Nachlauf des Konto-Purge: die Schritte, die NACH dem Commit laufen.

Abgetrennt von ``user_purge.py``, weil die Datei sonst über die Größen-Policy
läuft (PLAN.md §12.1). Die Trennlinie ist keine willkürliche: alles hier
passiert erst, wenn die Transaktion durch ist, spricht ausschließlich mit
Systemen ausserhalb der Datenbank (LiveKit, In-Prozess-Register) und ist
best-effort — ein Fehlschlag darf die bereits vollzogene Löschung nicht mehr
umstossen.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.voice_evict import (
    evict_all_from_voice_channels,
    evict_user_from_guild_voice,
)

if TYPE_CHECKING:  # pragma: no cover - nur fuer die Typpruefung
    from dcc_chat_gateway.pubsub import ConnectionManager

log = logging.getLogger(__name__)


async def evict_voice_sessions(
    session: AsyncSession,
    redis: Any,
    user_id: int,
    *,
    owned_voice_channel_ids: list[int],
    other_member_guild_ids: list[int],
) -> None:
    """Best-effort, post-commit: throw a still-connected LiveKit session out.

    Two shapes (Bughunt 2026-08-17): the deleted user's OWN voice channels
    in an owned (now hard-deleted) guild need everyone evicted — the room
    would otherwise keep running for a channel that no longer exists, same
    as ``routes/guilds.py::delete_guild``. Every OTHER guild they were a
    member of still exists, so only the deleted user themself needs
    throwing out via the normal per-guild evict call."""
    if owned_voice_channel_ids:
        try:
            await evict_all_from_voice_channels(redis, owned_voice_channel_ids)
        except Exception:  # noqa: BLE001
            log.warning("purge: voice eviction failed for deleted guild channels", exc_info=True)
    for gid in other_member_guild_ids:
        try:
            await evict_user_from_guild_voice(session, gid, user_id)
        except Exception:  # noqa: BLE001
            log.warning("purge: voice eviction failed for guild %s", gid, exc_info=True)


async def forget_devices(
    manager: ConnectionManager | None,
    removed_devices: list[tuple[int, int, int, dict]],
) -> None:
    """Post-commit: announce every purged Standplatz-Geraet as removed and
    drop it from the in-process register (``device_registry.py``). Same
    order as ``remote_guard.remove_devices_for_member`` — publish before
    forgetting, since the publish needs the remembered Standplatz.

    Das Beenden laufender Fernsteuerungen gehoert NICHT hierher: das muss vor
    dem Commit passieren, solange die Geraetezeilen noch stehen (s.
    ``user_purge._purge_db``)."""
    if manager is None or not removed_devices:
        return
    for device_id, guild_id, channel_id, payload in removed_devices:
        try:
            await manager.publish_device_change(
                guild_id=guild_id, channel_id=channel_id, device=payload, removed=True
            )
        except Exception:  # noqa: BLE001
            log.warning("purge: device_changed publish failed for device %s", device_id, exc_info=True)
        manager.device_forget(device_id)
