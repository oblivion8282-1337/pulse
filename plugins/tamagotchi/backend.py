"""Tamagotchi-Plugin backend — Plugin-System PR3 "Server-shared Pet".

Vorher (Schritt 7): Backend war ein dünner Echo-Handler — der Pet-State
lebte komplett im Frontend (Settings-Section + ``user_preferences``-
Cross-Device-Sync), und das Backend ackte nur die Aktion. **Ein Pet
pro User.**

PR3: Der Pet-State lebt jetzt **server-seitig pro Guild**. Auf Guild A
gibt es genau ein Tamagotchi, das alle Mitglieder gemeinsam füttern,
spielen lassen, schlafen schicken oder zurücksetzen. Jede Mutation
wird atomar im Backend (``chat.guild_plugin_state``) angewendet und
per Redis-Pub/Sub-Broadcast an alle Online-Mitglieder der Guild
gepusht.

Concurrency
-----------
Optimistic-with-server-echo: Frontend zeigt das lokale Update sofort,
schickt die WS-Op ``tamagotchi:{feed,play,sleep,reset}`` (Payload
``{guild_id}``), Backend mutiert atomar via ``apply_atomic_update``
(SELECT FOR UPDATE → mutate → UPDATE in einer Transaktion), publisht
das Ergebnis, alle Clients ersetzen ihren lokalen State mit dem
authoritativen Server-State.

5 Mitglieder die parallel ``feed`` klicken → 5 sequentielle
Increments durch den Row-Lock; Endzustand deterministisch
(``hunger`` ist auf 100 gecappt — alle 5 sehen am Ende 100).

Channels
--------
``plugin:tamagotchi:events`` (Redis Pub/Sub) — eine Nachricht pro
erfolgreichem State-Update mit Payload
``{op: "tamagotchi:state_update", guild_id, state,
   updated_by_user_id?, updated_at}``. Der Channel-Handler weiter
unten filtert die WebSocket-Targets auf Guild-Mitglieder
(``_ws_guilds``) und fan-out via ``manager._fan_out``.

Loaded by ``dcc_chat_gateway.plugins.loader`` via die
``backend = "backend:register"``-Eintragung in ``plugin.toml``. Der
Permission-Gate (Schritt 5) erlaubt nur registrierte WS-Ops + Channels
aus ``[plugin.uses]`` — beide Listen sind im Manifest aktualisiert.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from dcc_chat_gateway.plugins.state_store import apply_atomic_update
from dcc_chat_gateway.pubsub_channel_registry import register_channel_handler
from dcc_chat_gateway.routes.ws_ops_registry import (
    WSOpContext,
    register_ws_op,
)

log = logging.getLogger(__name__)


PLUGIN_NAME = "tamagotchi"
# Redis-Channel für State-Update-Broadcasts. Subscription registriert
# der ConnectionManager-Lifespan nicht automatisch — wir psubscriben
# über das ``plugin:*``-Pattern im pubsub.start() oder per impliziter
# Subscribe-on-Publish wie ``guild:events``. Aktuell: das Plugin
# subscribt selbst im ``register()`` (siehe unten).
EVENTS_CHANNEL = "plugin:tamagotchi:events"

# Default-Pet bei Erstkontakt mit einer Guild. Alle Werte 80, generischer
# Name. Renaming wäre eine eigene Op + MANAGE_GUILD-Gate, out-of-scope
# für PR3.
DEFAULT_STATE: dict[str, Any] = {
    "name": "Tamagotchi",
    "hunger": 80,
    "happiness": 80,
    "energy": 80,
    # Wird beim ersten Mutate auf now() überschrieben — der server-default
    # in der Migration ist 0 (kein gültiger ISO-String), darum setzen wir
    # ihn hier sauber.
    "lastUpdatedAt": "1970-01-01T00:00:00+00:00",
}


def _clamp(value: int, lo: int = 0, hi: int = 100) -> int:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def _now_iso() -> str:
    """ISO-8601 mit explizitem ``+00:00`` (kein ``Z``-Suffix — Python <3.11
    parst das mit ``fromisoformat`` nicht zurück; das ``+00:00``-Format
    round-trippt sauber)."""
    return datetime.now(timezone.utc).isoformat()


def _merge_defaults(state: dict[str, Any]) -> dict[str, Any]:
    """Fülle fehlende Keys mit Defaults. Schutz gegen Schema-Drift —
    falls ein älterer State-Blob (z.B. aus einem early-PR3-Migrate)
    weniger Felder hat als heute."""
    merged = dict(DEFAULT_STATE)
    merged.update(state or {})
    # Defensive Coercion: Stats müssen ints im 0–100-Bereich sein.
    for key in ("hunger", "happiness", "energy"):
        try:
            merged[key] = _clamp(int(merged.get(key, 80)))
        except (TypeError, ValueError):
            merged[key] = 80
    if not isinstance(merged.get("name"), str) or not merged["name"]:
        merged["name"] = DEFAULT_STATE["name"]
    return merged


def _mutate_feed(state: dict[str, Any]) -> dict[str, Any]:
    s = _merge_defaults(state)
    s["hunger"] = _clamp(s["hunger"] + 20)
    s["lastUpdatedAt"] = _now_iso()
    return s


def _mutate_play(state: dict[str, Any]) -> dict[str, Any]:
    s = _merge_defaults(state)
    s["happiness"] = _clamp(s["happiness"] + 20)
    s["energy"] = _clamp(s["energy"] - 10)
    s["lastUpdatedAt"] = _now_iso()
    return s


def _mutate_sleep(state: dict[str, Any]) -> dict[str, Any]:
    s = _merge_defaults(state)
    s["energy"] = _clamp(s["energy"] + 30)
    s["lastUpdatedAt"] = _now_iso()
    return s


def _mutate_reset(state: dict[str, Any]) -> dict[str, Any]:
    # state-Argument ignoriert: harter Reset.
    s = dict(DEFAULT_STATE)
    s["lastUpdatedAt"] = _now_iso()
    return s


_MUTATORS = {
    "feed": _mutate_feed,
    "play": _mutate_play,
    "sleep": _mutate_sleep,
    "reset": _mutate_reset,
}


def _coerce_guild_id(value: object) -> int | None:
    """Snowflakes kommen über die API-Grenze als String oder int — der
    WS-Op-Gate hat ``guild_id`` schon validiert (sonst hätte er
    rejected), wir parsen es hier nur in einen int für die DB-Query."""
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


async def _handle_action(
    ctx: WSOpContext, action: str, msg: dict[str, Any]
) -> None:
    """Gemeinsamer Op-Handler-Pfad. Mutiert atomar + broadcastet.

    Pre-Conditions, die der WS-Op-Gate (``plugins.ws_op_gate``) schon
    geprüft hat:
    * Plugin ``tamagotchi`` ist in der Instanz-Allowlist.
    * Caller ist Mitglied der ``guild_id``.
    * Plugin ist für diese Guild aktiviert (``guild_plugins.enabled``).

    Trotzdem prüfen wir hier nochmal ``guild_id``-Coerce — defensive
    Programmierung, sollte aber niemals fehlen.
    """
    guild_id = _coerce_guild_id(msg.get("guild_id"))
    if guild_id is None:
        # Sollte nicht passieren (Gate hätte gefilesst), aber kein Crash.
        log.warning(
            "tamagotchi:%s without guild_id reached handler", action
        )
        return

    mutator = _MUTATORS[action]
    user_id = getattr(ctx.user, "id", None)
    # Wir holen die Session-Factory vom ConnectionManager (vom Lifespan /
    # Test-Fixture injected via ``set_session_factory``). Das ist derselbe
    # Pfad, den der Permission-Filter nutzt — vermeidet die Falle, dass
    # ein direkter ``from dcc_chat_gateway.db import SessionLocal`` die
    # **modulglobale** Factory liest, die in Tests nicht gepatched wird
    # (``conftest.py`` patcht nur ``routes.ws_ops.SessionLocal``).
    session_factory = ctx.manager._session_factory
    if session_factory is None:
        log.error("tamagotchi:%s without session_factory — bailing", action)
        return
    async with session_factory() as session:
        new_state = await apply_atomic_update(
            session,
            guild_id=guild_id,
            plugin_name=PLUGIN_NAME,
            default_state=dict(DEFAULT_STATE),
            mutate=mutator,
            actor_user_id=user_id,
        )

    envelope = {
        "guild_id": str(guild_id),
        "state": new_state,
        "updated_by_user_id": str(user_id) if user_id is not None else None,
        "updated_at": new_state.get("lastUpdatedAt"),
    }
    # Publish auf den Plugin-Channel. Der ConnectionManager subscribt das
    # Pattern ``plugin:*`` (siehe register()-Hook); der Channel-Handler
    # unten fan-outet an Guild-Mitglieder.
    try:
        await ctx.redis.publish(
            EVENTS_CHANNEL,
            json.dumps(envelope, separators=(",", ":")),
        )
    except Exception:  # noqa: BLE001
        # Broadcast-Failure darf den Op nicht killen — der State ist
        # persistiert, andere Clients sehen ihn beim nächsten Reconnect/
        # Fetch. Loggen + weiter.
        log.exception(
            "tamagotchi:%s publish failed (state persisted)", action
        )


async def _handle_feed(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "feed", msg)


async def _handle_play(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "play", msg)


async def _handle_sleep(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "sleep", msg)


async def _handle_reset(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await _handle_action(ctx, "reset", msg)


_OP_HANDLERS = {
    "feed": _handle_feed,
    "play": _handle_play,
    "sleep": _handle_sleep,
    "reset": _handle_reset,
}


async def _broadcast_state_update(
    manager, channel: str, msg: dict[str, Any]
) -> None:
    """Channel-Handler für ``plugin:tamagotchi:events``.

    Wandelt das publish-Envelope in einen ``tamagotchi:state_update``-
    WS-Frame und fan-outet an alle Sockets, deren User Mitglied der
    Guild ist. Membership-Lookup geht über ``manager._ws_guilds`` —
    derselbe Mechanismus, den ``_filter_targets_by_guild`` für
    ``guild:events`` nutzt.
    """
    payload = manager._decode_payload(msg["data"], channel)
    if not isinstance(payload, dict):
        log.warning("plugin:tamagotchi:events malformed: %r", payload)
        return
    raw_gid = payload.get("guild_id")
    try:
        gid_int = int(raw_gid) if raw_gid is not None else 0
    except (TypeError, ValueError):
        log.warning(
            "plugin:tamagotchi:events bad guild_id: %r", raw_gid
        )
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
    log.info(
        "plugin:tamagotchi:events broadcast guild=%s targets=%d/%d",
        gid_int,
        len(targets),
        len(raw_targets),
    )
    await manager._fan_out(targets, envelope)


def register() -> None:
    """Entrypoint vom Plugin-Loader. Idempotent.

    Registriert:
    * 4 WS-Ops ``tamagotchi:{feed,play,sleep,reset}`` (Permission-Gate
      verlangt, dass jeder Op in ``[plugin.uses].ws_ops`` steht).
    * 1 Channel-Handler ``plugin:tamagotchi:events`` (Permission-Gate
      verlangt den Channel in ``[plugin.uses].channels``).

    Der eigentliche **Redis-Subscribe** auf den Plugin-Channel passiert
    in ``app.py`` (siehe ``plugin_subscriptions`` in der Lifespan) —
    der ConnectionManager subscribt seine Channels bei ``start()`` und
    kennt zu dem Zeitpunkt noch keine Plugins. Wir reichen die Liste der
    "zusätzlich zu subscribenden" Channels über den Manager nach.
    """
    for action, handler in _OP_HANDLERS.items():
        register_ws_op(f"{PLUGIN_NAME}:{action}", handler)
    register_channel_handler(EVENTS_CHANNEL, _broadcast_state_update)
    log.info(
        "tamagotchi-plugin: registered ws ops %s + channel %s",
        list(_OP_HANDLERS),
        EVENTS_CHANNEL,
    )


__all__ = [
    "DEFAULT_STATE",
    "EVENTS_CHANNEL",
    "PLUGIN_NAME",
    "register",
]
