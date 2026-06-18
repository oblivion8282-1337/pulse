"""Tamagotchi-Plugin backend — "Lebendiges Pet" (v0.3.0).

Server-shared Pet pro Guild (seit PR3): alle Mitglieder füttern/spielen/
schlafen gemeinsam, State lebt in ``chat.guild_plugin_state``, jede
Mutation wird atomar (``apply_atomic_update``: SELECT FOR UPDATE → mutate
→ UPDATE) angewendet und per Redis-Pub/Sub an alle Online-Mitglieder
gepusht.

v0.3.0 "Lebendiges Pet": die zustandslose Spiel-Logik (Zeit-Decay,
Tod-Berechnung, XP/Level, Aktions-Transitions) liegt in ``mechanics.py``
— dieses Modul ist nur noch DB-/Redis-Plumbing + das MANAGE_GUILD-Gate
für die destruktiven Ops (reset/revive). Decay ist lazy/timestamp-basiert
(kein Background-Loop), deshalb wird vor jeder Aktion ein Catch-up
gerechnet (``mechanics.apply_action``).

Ops:
* ``tamagotchi:{feed,play,sleep}`` — alle Mitglieder, geben XP.
* ``tamagotchi:reset``  — MANAGE_GUILD, harter Voll-Reset.
* ``tamagotchi:revive`` — MANAGE_GUILD, totes Pet zurückholen.

Channel ``plugin:tamagotchi:events`` (Redis) — ein Broadcast pro
erfolgreicher Mutation; der Channel-Handler fan-outet an Guild-Member.

``mechanics.py`` ist ein Geschwister-Modul: Plugins sind kein Python-
Package, also lädt dieses Modul es explizit via ``importlib`` (gleiches
synthetisches ``pulse_plugin.<name>.<module>``-Schema wie der Loader).
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dcc_chat_gateway.permissions import resolve_permissions
from dcc_chat_gateway.plugins.state_store import apply_atomic_update, RowVanishedError
from dcc_chat_gateway.plugins.ws_op_gate import WS_CODE_PLUGIN_PERMISSION_DENIED
from dcc_chat_gateway.pubsub_channel_registry import register_channel_handler
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext, register_ws_op
from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions

log = logging.getLogger(__name__)


def _load_mechanics():
    """Lade das Geschwister-Modul ``mechanics.py`` idempotent unter dem
    synthetischen Loader-Namen (kein Package → kein relativer Import)."""
    name = "pulse_plugin.tamagotchi.mechanics"
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).resolve().parent / "mechanics.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


mechanics = _load_mechanics()

PLUGIN_NAME = "tamagotchi"
EVENTS_CHANNEL = "plugin:tamagotchi:events"
# Re-Export: der State-Store + die Tests nutzen das als default_state.
DEFAULT_STATE: dict[str, Any] = mechanics.DEFAULT_STATE


def _coerce_guild_id(value: object) -> int | None:
    """Snowflake (str|int) → int für die DB-Query. Der WS-Op-Gate hat
    ``guild_id`` schon validiert; hier nur defensives Parsen."""
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


async def _publish(
    ctx: WSOpContext, guild_id: int, new_state: dict[str, Any], user_id: int | None
) -> None:
    """Broadcast eines State-Updates auf den Plugin-Channel. ``updated_by_
    user_id`` ist bewusst guild-weit sichtbar (gleiche Info wie die
    Member-Liste). Publish-Fehler killen den Op nicht — State ist
    persistiert, andere Clients holen ihn beim nächsten Fetch."""
    envelope = {
        "guild_id": str(guild_id),
        "state": new_state,
        "updated_by_user_id": str(user_id) if user_id is not None else None,
        "updated_at": new_state.get("lastUpdatedAt"),
    }
    try:
        await ctx.redis.publish(
            EVENTS_CHANNEL, json.dumps(envelope, separators=(",", ":"))
        )
    except Exception:  # noqa: BLE001
        log.exception("tamagotchi publish failed (state persisted)")


async def _mutate_and_broadcast(ctx: WSOpContext, guild_id: int, mutate) -> None:
    """Atomare Mutation über den ConnectionManager-Session-Factory-Pfad
    (derselbe wie der Permission-Filter — vermeidet die ungepatchte
    Modul-Factory-Falle in Tests), dann Broadcast."""
    factory = ctx.manager._session_factory
    if factory is None:
        log.error("tamagotchi: no session_factory — bailing")
        return
    user_id = getattr(ctx.user, "id", None)
    try:
        async with factory() as session:
            new_state = await apply_atomic_update(
                session,
                guild_id=guild_id,
                plugin_name=PLUGIN_NAME,
                default_state=dict(DEFAULT_STATE),
                mutate=mutate,
                actor_user_id=user_id,
            )
    except RowVanishedError:
        log.warning("tamagotchi: guild row vanished — skipping broadcast")
        return
    await _publish(ctx, guild_id, new_state, user_id)


async def _handle_action(ctx: WSOpContext, action: str, msg: dict[str, Any]) -> None:
    """Gemeinsamer Pfad für die offenen Pflege-Ops (feed/play/sleep)."""
    guild_id = _coerce_guild_id(msg.get("guild_id"))
    if guild_id is None:
        log.warning("tamagotchi:%s without guild_id reached handler", action)
        return
    now = datetime.now(timezone.utc)
    await _mutate_and_broadcast(
        ctx, guild_id, lambda s: mechanics.apply_action(s, action, now)
    )


async def _handle_privileged(
    ctx: WSOpContext, msg: dict[str, Any], mutate_for: str
) -> None:
    """MANAGE_GUILD-gated Pfad für reset/revive. Permission-Check + Mutation
    teilen eine Session (eine Connection). Fehlt die Permission → Error-Frame
    zurück, kein Broadcast."""
    guild_id = _coerce_guild_id(msg.get("guild_id"))
    if guild_id is None:
        log.warning("tamagotchi:%s without guild_id reached handler", mutate_for)
        return
    factory = ctx.manager._session_factory
    if factory is None:
        log.error("tamagotchi:%s: no session_factory — bailing", mutate_for)
        return
    user_id = getattr(ctx.user, "id", None)
    now = datetime.now(timezone.utc)
    if mutate_for == "revive":
        mutate = lambda s: mechanics.revive(s, now)  # noqa: E731
    else:
        mutate = lambda s: mechanics.apply_action(s, "reset", now)  # noqa: E731

    async with factory() as session:
        perms = await resolve_permissions(session, ctx.user, guild_id)
        if not has_permission(perms, Permissions.MANAGE_GUILD):
            await ctx.websocket.send_json(
                {
                    "op": "error",
                    "code": WS_CODE_PLUGIN_PERMISSION_DENIED,
                    "msg": "missing permission: MANAGE_GUILD",
                }
            )
            return
        try:
            new_state = await apply_atomic_update(
                session,
                guild_id=guild_id,
                plugin_name=PLUGIN_NAME,
                default_state=dict(DEFAULT_STATE),
                mutate=mutate,
                actor_user_id=user_id,
            )
        except RowVanishedError:
            log.warning("tamagotchi:%s: guild row vanished — skipping broadcast", mutate_for)
            return
    await _publish(ctx, guild_id, new_state, user_id)


async def _handle_feed(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "feed", msg)


async def _handle_play(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "play", msg)


async def _handle_sleep(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "sleep", msg)


async def _handle_reset(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_privileged(ctx, msg, "reset")


async def _handle_revive(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_privileged(ctx, msg, "revive")


_OP_HANDLERS = {
    "feed": _handle_feed,
    "play": _handle_play,
    "sleep": _handle_sleep,
    "reset": _handle_reset,
    "revive": _handle_revive,
}


async def _broadcast_state_update(manager, channel: str, msg: dict[str, Any]) -> None:
    """Channel-Handler für ``plugin:tamagotchi:events`` → ``tamagotchi:
    state_update``-Frame an alle Sockets, deren User Mitglied der Guild
    ist (``_ws_guilds``-Filter, wie ``guild:events``)."""
    payload = manager._decode_payload(msg["data"], channel)
    if not isinstance(payload, dict):
        log.warning("plugin:tamagotchi:events malformed: %r", payload)
        return
    raw_gid = payload.get("guild_id")
    try:
        gid_int = int(raw_gid) if raw_gid is not None else 0
    except (TypeError, ValueError):
        log.warning("plugin:tamagotchi:events bad guild_id: %r", raw_gid)
        return
    if not gid_int:
        return

    envelope = {
        "op": "tamagotchi:state_update",
        "guild_id": str(gid_int),
        "state": payload.get("state"),
        "updated_by_user_id": payload.get("updated_by_user_id"),
        "updated_at": payload.get("updated_at"),
    }
    async with manager._lock:
        raw_targets = list(manager._connections)
    targets = [
        ws
        for ws in raw_targets
        if (gs := manager._ws_guilds.get(ws)) is not None and gid_int in gs
    ]
    await manager._fan_out(targets, envelope)


def register() -> None:
    """Entrypoint vom Plugin-Loader. Registriert die 5 WS-Ops + den
    Broadcast-Channel-Handler. Idempotent. Der Redis-Subscribe auf den
    Channel passiert in der app.py-Lifespan (siehe plugin_subscriptions)."""
    for action, handler in _OP_HANDLERS.items():
        register_ws_op(f"{PLUGIN_NAME}:{action}", handler)
    register_channel_handler(EVENTS_CHANNEL, _broadcast_state_update)
    log.info(
        "tamagotchi-plugin: registered ws ops %s + channel %s",
        list(_OP_HANDLERS),
        EVENTS_CHANNEL,
    )


__all__ = ["DEFAULT_STATE", "EVENTS_CHANNEL", "PLUGIN_NAME", "mechanics", "register"]
