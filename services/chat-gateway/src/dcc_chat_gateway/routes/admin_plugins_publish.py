"""Publish-Helper für die Admin-Plugin-Routes.

Aus ``admin_plugins.py`` ausgelagert, damit dieses Modul unter der
350-Zeilen-Grenze bleibt (Code-Größen-Policy). Beide Helper sind
strikt Side-Effect-Wrapper rund um die Redis-Publishes — keine
Routing- oder Validierungslogik.
"""

from __future__ import annotations

import json
import logging

from dcc_shared.events import GuildPluginsChangedEvent
from fastapi import Request

log = logging.getLogger(__name__)


# Redis-Channel für Cross-Pod-Allowlist-Notifications. Publish-Only —
# kein Subscriber in dieser Codebase (Stufe-B-Vorbereitung).
ALLOWLIST_CHANGED_CHANNEL = "plugin:allowlist:changed"


async def publish_allowlist_changed(
    request: Request, *, op: str, name: str, actor_id: int | None
) -> None:
    """Cross-Pod-Notify auf ``plugin:allowlist:changed``.

    Publish-Only — kein Subscriber in dieser Codebase
    (Stufe-B-Vorbereitung für Multi-Pod-Setups). Failure-Modes:

    * Kein Redis am ``app.state`` (REST-Test-Fixture, ``skip_redis``
      branch) → silent skip.
    * Redis-Connection-Error → loggen + ignorieren. Der lokale Snapshot
      ist schon konsistent; der Notify wäre nur für andere Pods relevant.
    """
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    payload = json.dumps(
        {"op": op, "name": name, "actor_id": actor_id},
        separators=(",", ":"),
    )
    try:
        await redis.publish(ALLOWLIST_CHANGED_CHANNEL, payload)
    except Exception:  # noqa: BLE001
        log.exception(
            "admin %s /admin/plugins/%s: cross-pod notify publish failed "
            "(local snapshot already updated)",
            op.upper(),
            name,
        )


async def publish_guild_plugins_disabled(
    request: Request, *, guild_ids: list[int], plugin_name: str
) -> None:
    """Pro Guild, die das Plugin aktiv hatte, ein
    ``guild_plugins_changed``-Event mit ``enabled=False`` pushen.

    Spiegelt das Verhalten des PUT-Pfads in ``routes/guild_plugins.py``;
    publiziert auf ``guild:events`` mit per-Op-Membership-Scoping
    (``_GUILD_MEMBER_SCOPED_OPS``). Trade-off: bis zu N Publishes pro
    DELETE; Self-Host-Setup mit kleinen Guild-Counts → tolerabel.
    Failure ist non-fatal — der lokale DB-State (Cascade-Drop der
    Toggle-Rows) ist bereits committed.
    """
    if not guild_ids:
        return
    manager = getattr(request.app.state, "connection_manager", None)
    if manager is None:
        return
    for gid in guild_ids:
        envelope = GuildPluginsChangedEvent(
            guild_id=str(gid), plugin_name=plugin_name, enabled=False
        )
        try:
            await manager.publish_guild_event(envelope)
        except Exception:  # noqa: BLE001
            log.exception(
                "guild_plugins_changed (disabled) publish failed "
                "(guild=%s plugin=%s); local DB already committed",
                gid, plugin_name,
            )


__all__ = [
    "ALLOWLIST_CHANGED_CHANNEL",
    "publish_allowlist_changed",
    "publish_guild_plugins_disabled",
]
