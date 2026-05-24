"""WS-Op-Gate für Plugin-Ops.

Plugin-Ops sind colon-namespaced (``tamagotchi:feed``). Vor jedem
solchen Op prüft der Dispatcher:

1. **Allowlist-Snapshot**: Plugin muss in ``app.state.plugin_allowlist``
   stehen. Der Snapshot wird beim Lifespan-Start aus der DB gefüllt UND
   live aktualisiert durch die Admin-PUT/DELETE-Endpunkte
   (``routes/admin_plugins.py``): nach einem erfolgreichen DB-Commit
   ruft der Handler ``update_plugin_allowlist_snapshot(add=/remove=)``
   unter Lock, sodass der WS-Op-Gate ohne Service-Restart sofort
   weiß, dass das Plugin (de)aktiviert ist.
2. **Guild-Membership**: Caller muss Mitglied der ``guild_id`` aus dem
   Payload sein.
3. **Guild-Toggle**: ``chat.guild_plugins.enabled = True`` für
   (guild_id, plugin_name).

Hello-Bypass
------------
Ops des ``hello``-Plugins (``hello:*``) überspringen Schritt 2 + 3 (hello
gilt instanzweit als aktiv, kein Guild-Toggle nötig). Schritt 1 greift
ebenfalls — aber ``hello`` ist immer in der Allowlist (siehe Loader-
Self-Heal).

Caching
-------
``guild_plugins.enabled``-Reads passieren auf dem WS-Op-Hot-Path. Wir
cachen mit einer kleinen TTL-Map (Default 60 s), damit ein
Massen-Feed-Spam nicht jeden Op gegen die DB schickt. Trade-off: ein
Guild-Toggle vom Admin kann bis zu 60 s brauchen, bis er greift. Im
Plugin-Manager-UI (PR2) kommt ein "Refresh"-Button, der den Cache
invalidiert; für PR1 bleibt der TTL-Pfad allein als Konsistenz-Garantie.

Performance-Trade-Off-Doku
~~~~~~~~~~~~~~~~~~~~~~~~~~
Saubere Lösung wäre ein Redis-Pub/Sub-Event ``plugin:toggle`` beim
PUT, das die Caches der laufenden Gateway-Pods invalidiert. Das wäre
PR2 wert; PR1 ist Foundation. LRU mit TTL ist einfach genug, dass
ein zukünftiger Refactor das ohne API-Bruch ersetzen kann.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import GuildMember, GuildPlugin
from dcc_chat_gateway.plugins.allowlist import HELLO_PLUGIN_NAME

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# WS-Error-Codes für das Plugin-Gate.
#
# **Wichtig**: kein zentrales Code-Registry vorhanden, jeder Bereich verwaltet
# seinen Block selbst — Kollisionen müssen wir per Konvention vermeiden.
# Stand des Code-Audits beim Plugin-Admin-Aktivierungs-PR1:
#
# * ``ws.py``              — 4001 (token), 4003 (email-unverified),
#                            4009 (too many connections)
# * ``ws_ops.py``          — 4001/4002/4007/4009 (frame/JSON/unknown op)
# * ``ws_ops_handlers.py`` — 4003/4004/4011/4012 (subscribe/voice errors)
# * ``ws_op_send.py``      — 4005/4006/4008/4013/4014/4290 (send-Pfad)
# * ``ws_watch.py``        — 4012–4017 (watch-party-Fehler)
#
# Plugin-Gate nutzt ``4040–4043`` — getrennter Block, sodass Frontends
# anhand des Codes eindeutig zwischen Plugin-Reject und Send-/Watch-Reject
# unterscheiden können. Falls weitere Plugin-Fehler dazukommen, **diesen
# Block weiterzählen** (4044…). Vor jedem neuen Code: Audit wiederholen.
WS_CODE_PLUGIN_NOT_ALLOWED = 4040      # Plugin nicht in Instanz-Allowlist
WS_CODE_PLUGIN_GUILD_ID_MISSING = 4041  # ``guild_id`` fehlt im Payload
WS_CODE_PLUGIN_NOT_MEMBER = 4042        # Caller nicht Mitglied der Guild
WS_CODE_PLUGIN_NOT_ENABLED = 4043       # Plugin auf Guild nicht aktiviert


# Cache-Konfiguration. ``_TTL_SECONDS`` ist absichtlich klein gehalten,
# damit ein Guild-Toggle nicht "stundenlang nachhinkt". Tests können
# über ``_clear_cache()`` zurücksetzen.
_TTL_SECONDS = 60.0
_MAX_ENTRIES = 4096


@dataclass
class _CacheEntry:
    enabled: bool
    expires_at: float


_cache: dict[tuple[int, str], _CacheEntry] = {}


def _now() -> float:
    return time.monotonic()


def _cache_get(guild_id: int, plugin_name: str) -> bool | None:
    entry = _cache.get((guild_id, plugin_name))
    if entry is None:
        return None
    if entry.expires_at <= _now():
        _cache.pop((guild_id, plugin_name), None)
        return None
    return entry.enabled


def _cache_put(guild_id: int, plugin_name: str, enabled: bool) -> None:
    if len(_cache) >= _MAX_ENTRIES:
        # Naiver Eviction-Pfad: erstes Element droppen. Bei _TTL_SECONDS=60
        # und 4096 Slots ist das eine theoretische Defensive — eine echte
        # LRU wäre Overkill für PR1.
        try:
            _cache.pop(next(iter(_cache)))
        except StopIteration:  # pragma: no cover
            pass
    _cache[(guild_id, plugin_name)] = _CacheEntry(
        enabled=enabled, expires_at=_now() + _TTL_SECONDS
    )


def _clear_cache() -> None:
    """Test-Helper: Cache komplett leeren."""
    _cache.clear()


def invalidate_guild_plugin_cache(
    guild_id: int, plugin_name: str | None = None
) -> None:
    """Cache-Invalidation für einen Toggle-Write.

    ``plugin_name=None`` invalidiert alle Plugins der Guild (z.B. wenn
    ein Plugin instanzweit aus der Allowlist fliegt und der DELETE-Pfad
    sicherheitshalber alle Guild-Caches durchspülen will). Sonst nur
    die eine `(guild_id, plugin_name)`-Zelle.

    Wird vom PUT-Toggle in ``routes/guild_plugins.py`` aufgerufen, damit
    eine UI-Änderung im selben Prozess sofort wirkt (statt der bis zu
    60 s TTL-Lag). Multi-Pod-Setup würde zusätzlich Redis-Pub/Sub
    brauchen — PR2.
    """
    if plugin_name is not None:
        _cache.pop((guild_id, plugin_name), None)
        return
    for key in [k for k in _cache if k[0] == guild_id]:
        _cache.pop(key, None)


def parse_plugin_op(op: str) -> tuple[str, str] | None:
    """Splittet einen Op-Code in ``(plugin_name, action)``.

    Returnt ``None`` für non-Plugin-Ops (keine ``:`` enthalten).
    Validiert nur das Format; die Plugin-Existenz prüft das Gate.
    """
    if ":" not in op:
        return None
    plugin, _, action = op.partition(":")
    if not plugin or not action:
        return None
    return plugin, action


def coerce_guild_id(value: object) -> int | None:
    """Snowflake-IDs kommen über die API-Grenze als String oder int.

    Hier minimal-toleranter Parser — keine Pydantic-Schema-Validation
    nötig, weil die Gate-Funktion ein Boolean returnt (True = pass,
    False = block), nicht das Payload bauchschmerzlich validiert.
    """
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


async def is_guild_member(
    session: AsyncSession, guild_id: int, user_id: int
) -> bool:
    """Membership-Check ohne Permission-Resolver-Overhead."""
    member = await session.get(GuildMember, (guild_id, user_id))
    return member is not None


async def is_plugin_enabled_for_guild(
    session: AsyncSession, guild_id: int, plugin_name: str
) -> bool:
    """Cached Read von ``guild_plugins.enabled``.

    Default für fehlende Row: ``False`` (Guild-Admin muss explizit
    einschalten). Im Cache landet auch das ``False``-Ergebnis, damit
    ein Spam von Plugin-Ops auf einer nicht-aktivierten Guild nicht
    jeden Op an die DB schickt.
    """
    cached = _cache_get(guild_id, plugin_name)
    if cached is not None:
        return cached
    row = await session.execute(
        select(GuildPlugin.enabled).where(
            GuildPlugin.guild_id == guild_id,
            GuildPlugin.plugin_name == plugin_name,
        )
    )
    value = row.scalar_one_or_none()
    enabled = bool(value)
    _cache_put(guild_id, plugin_name, enabled)
    return enabled


@dataclass
class GateDecision:
    """Resultat eines Gate-Checks.

    ``allowed`` = darf der Handler laufen? Wenn ``False``, ist
    ``error_code`` + ``error_msg`` für den Error-Frame an den Client
    gefüllt — der Dispatcher rendert daraus das Frame.
    """

    allowed: bool
    error_code: int = 0
    error_msg: str = ""


async def check_plugin_op_gate(
    *,
    session: AsyncSession,
    op: str,
    payload: dict,
    user_id: int,
    allowlist: frozenset[str],
) -> GateDecision:
    """Allowlist + Membership + Guild-Toggle in einem Aufruf.

    ``allowlist`` ist der Snapshot von ``app.state.plugin_allowlist``.
    Plugin-Ops ohne valides ``guild_id``-Feld werden geblockt — das
    Schema-Update auf den EVENT_REGISTRY-Einträgen macht das
    Pflicht-Feld auch publisher-seitig sichtbar; hier nochmal als
    Dispatcher-side Defense-in-Depth.
    """
    parsed = parse_plugin_op(op)
    if parsed is None:
        # Kein Plugin-Op — Gate ist nicht zuständig, durchwinken.
        return GateDecision(allowed=True)
    plugin_name, _ = parsed

    if plugin_name not in allowlist:
        return GateDecision(
            allowed=False,
            error_code=WS_CODE_PLUGIN_NOT_ALLOWED,
            error_msg=f"plugin not allowed: {plugin_name}",
        )

    if plugin_name == HELLO_PLUGIN_NAME:
        # hello hat keinen Guild-Scope — instanzweit aktiv.
        return GateDecision(allowed=True)

    guild_id = coerce_guild_id(payload.get("guild_id"))
    if guild_id is None:
        return GateDecision(
            allowed=False,
            error_code=WS_CODE_PLUGIN_GUILD_ID_MISSING,
            error_msg="plugin op requires guild_id",
        )

    if not await is_guild_member(session, guild_id, user_id):
        return GateDecision(
            allowed=False,
            error_code=WS_CODE_PLUGIN_NOT_MEMBER,
            error_msg="not a member of this guild",
        )

    if not await is_plugin_enabled_for_guild(session, guild_id, plugin_name):
        return GateDecision(
            allowed=False,
            error_code=WS_CODE_PLUGIN_NOT_ENABLED,
            error_msg=f"plugin not enabled for guild: {plugin_name}",
        )

    return GateDecision(allowed=True)


__all__ = [
    "GateDecision",
    "WS_CODE_PLUGIN_GUILD_ID_MISSING",
    "WS_CODE_PLUGIN_NOT_ALLOWED",
    "WS_CODE_PLUGIN_NOT_ENABLED",
    "WS_CODE_PLUGIN_NOT_MEMBER",
    "_clear_cache",
    "check_plugin_op_gate",
    "coerce_guild_id",
    "invalidate_guild_plugin_cache",
    "is_guild_member",
    "is_plugin_enabled_for_guild",
    "parse_plugin_op",
]
