"""WS client→server op-handler registry (Plugin-System Schritt 2).

The op-loop in :mod:`routes.ws_ops` used to be a 9-way if/elif switch. To let
plugins (later, Schritt 4) plug in new client-side ops without touching the
core dispatcher, both halves of the dispatch — *where to send a known op* and
*how to discover them* — live behind a registry.

Design notes
------------
* :class:`WSOpContext` carries the per-connection local state that handlers
  need to read **and mutate**. ``subscribed`` (dict) and ``hosted_parties``
  (set) are already mutable; ``current_voice_channel`` would otherwise need a
  return-value channel back into the loop, so we expose it as a plain
  attribute on the context — handlers reassign ``ctx.current_voice_channel``
  the same way the inline branch used to reassign the local variable.

* :func:`register_ws_op` works as decorator *or* as a direct call. Plugins
  will read better as decorators::

      @register_ws_op("tamagotchi:feed")
      async def handle_feed(ctx: WSOpContext, msg: dict) -> None:
          ...

  Internal handlers in :mod:`routes.ws_ops_handlers` register at import time
  with the direct form so the wiring is obvious in the module.

* Last writer wins. We do not warn on override — that's the contract a
  plugin needs to override a core op for an A/B experiment. Tests cover the
  override case to keep the contract honest.

Behaviour-neutral: the dispatcher in :mod:`routes.ws_ops` keeps the same
unknown-op error frame (``code 4007``) when ``get_handler`` returns ``None``.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from fastapi import WebSocket
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import AsyncSession

    from dcc_chat_gateway.pubsub import ConnectionManager
    from dcc_chat_gateway.security import AuthenticatedUser


class SecondWindow:
    """Nachrichtenzaehler in einem festen Ein-Sekunden-Fenster.

    **Sprungfenster, kein rollendes** — laeuft die Sekunde ab, faengt der
    Zaehler wieder bei null an. An der Fenstergrenze passen dadurch kurz bis zu
    zwei Deckel-Mengen durch. Das ist eine bewusste Entscheidung, kein Versehen:
    die Deckel schuetzen Gateway und Host vor einer *Dauer*flut, und die
    Nachrichten, die sie deckeln, sind selbst eng begrenzt (Eingabe ≤1024
    dekodierte Byte, Signal ≤8 KiB). Ein wirklich rollendes Fenster braeuchte je
    Verbindung eine Zeitstempelliste — Speicher und Aufwand pro Nachricht fuer
    einen Unterschied, der in Byte gerechnet folgenlos ist.

    Liegt auf dem :class:`WSOpContext` (pro Verbindung) und ist damit beim
    Disconnect von selbst weg — gleiches Muster wie ``last_typing``.
    """

    __slots__ = ("start", "count")

    def __init__(self) -> None:
        self.start = 0.0
        self.count = 0

    def hit(self) -> int:
        """Zaehlt eine Nachricht und gibt ihren Stand im laufenden Fenster."""
        now = time.monotonic()
        if now - self.start >= 1.0:
            self.start = now
            self.count = 0
        self.count += 1
        return self.count


@dataclass
class WSOpContext:
    """Per-connection state shared between handlers and the dispatcher loop.

    Mutable fields (``subscribed``, ``hosted_parties``, ``current_voice_channel``)
    are read+written by individual handlers; the dispatcher's ``finally`` block
    reads them once more during cleanup.
    """

    websocket: "WebSocket"
    user: "AuthenticatedUser"
    manager: "ConnectionManager"
    redis: "Redis"
    # cid (str) → guild_id (int) for guild text channels, None for DMs.
    # See routes/ws_ops.py for the original semantics — preserved 1:1.
    subscribed: dict[str, int | None] = field(default_factory=dict)
    # (channel_id, party_id) of watch parties this socket has started as host.
    hosted_parties: set[tuple[str, str]] = field(default_factory=set)
    # (channel_id, party_id) of watch parties this socket currently watches.
    watched_parties: set[tuple[str, str]] = field(default_factory=set)
    # Voice channel id (as string) the user is currently in, as reported by
    # voice_self_state. ``None`` when not in a voice channel.
    current_voice_channel: str | None = None
    # Per-channel monotonic timestamp of the last ``typing`` broadcast this
    # socket sent — server-side throttle backstop for the typing indicator.
    # Lives on the context (per connection) so it's freed on disconnect.
    last_typing: dict[str, float] = field(default_factory=dict)
    # Monotonic timestamp of the last ``resync`` this socket served — server-side
    # throttle backstop. ``resync`` rebuilds the full ready frame (several DB
    # queries + Redis/S3 reads), so an unthrottled loop is a DB-pool DoS vector.
    last_resync: float = 0.0
    # Sekunden-Deckel der Fernsteuerung. Die Grenzen je Nachricht formen nur
    # eine EINZELNE Nachricht — ohne diese Zaehler kostet ein Verstoss nichts
    # und ein Steuernder flutet Gateway und Host mit Leitungsgeschwindigkeit.
    # ``remote_signal`` bekam seinen Deckel spaeter als ``remote_input``: es ist
    # derselbe Weiterleiter zum selben Empfaenger, nur mit anderer Nutzlast.
    remote_input_rate: SecondWindow = field(default_factory=SecondWindow)
    remote_signal_rate: SecondWindow = field(default_factory=SecondWindow)
    # Monotonic-Zeitpunkt der letzten ``remote_request``-Anfrage dieses Sockets.
    # Anders als die beiden Deckel oben eine Mindestpause statt eines Zaehlers:
    # eine Anfrage kostet drei DB-Abfragen und legt beim Gegenueber einen
    # modalen Dialog auf — der legitime Takt ist ein Klick, nicht ein Strom.
    last_remote_request: float = 0.0
    # Dasselbe fuer die beiden Geraete-Ops mit Datenbankzugriff. Getrennt
    # gefuehrt, weil ein verworfener Weckruf einen Klick kostet, eine
    # verworfene Anmeldung dagegen „Geraet bleibt offline"
    # (``ws_device_handlers._takt_frei``).
    last_device_announce: float = 0.0
    last_device_wake: float = 0.0
    # Optional DB session passed from the plugin op-gate to avoid double
    # session acquisition. Only set for plugin ops that pass the gate.
    # Internal use only; handlers should not rely on this being set.
    _db_session: "AsyncSession | None" = None


WSOpHandler = Callable[[WSOpContext, dict[str, Any]], Awaitable[None]]


_handlers: dict[str, WSOpHandler] = {}

# Built-in op names that plugins must not shadow.  A plugin op name contains a
# colon (``"tamagotchi:feed"``), so this guard only triggers for unnamespaced
# ops — internal handlers register *before* any plugin runs, so they are always
# safe; it's a plugin registration that accidentally omits its namespace that
# we want to catch early.
CORE_OPS: frozenset[str] = frozenset({
    "send",
    "subscribe",
    "unsubscribe",
    "voice_self_state",
    "activity",
    "typing",
    "ping",
    "resync",
    "watch_start",
    "watch_stop",
    "watch_control",
    "watch_heartbeat",
    "watch_join",
    "watch_leave",
    "watch_handoff",
    "watch_queue_add",
    "watch_queue_remove",
    "watch_queue_move",
    "watch_queue_advance",
    # Standplatz-Geraete: „dieser Rechner ist Geraet X" und die Ruecknahme.
    "device_announce",
    "device_streams",
    "device_withdraw",
    "device_wake",
    "remote_request",
    "remote_respond",
    "remote_signal",
    "remote_input",
    "remote_end",
    "profile_statement",
})


def register_ws_op(
    op: str, handler: WSOpHandler | None = None
) -> WSOpHandler | Callable[[WSOpHandler], WSOpHandler]:
    """Register ``handler`` under name ``op``.

    Two call styles, both supported deliberately so plugin authors and core
    code can pick the one that reads better in context:

    Direct::
        register_ws_op("foo", handle_foo)

    Decorator::
        @register_ws_op("foo")
        async def handle_foo(ctx, msg): ...

    A second registration for the same ``op`` overrides the first (last-writer-
    wins). The previous handler is silently dropped — tests in
    ``test_ws_op_registry.py`` lock this in.

    Protection: a built-in op name (in ``CORE_OPS``, no colon) may be registered
    exactly ONCE — by the core handler module at import time. Any *later* attempt
    to register the same bare core name (i.e. it is already in ``_handlers``)
    raises ``ValueError`` so a plugin cannot override a built-in handler. The
    first/core registration passes (the name is not yet present); the override
    attempt is what we reject. Plugins are namespaced (``myplugin:send``) and so
    never collide with this guard for their own ops.
    """
    if ":" not in op and op in CORE_OPS and op in _handlers:
        raise ValueError(
            f"register_ws_op: {op!r} is a built-in op name and cannot be "
            "overridden by a plugin. Use a namespaced op name (e.g. 'myplugin:send')."
        )
    if handler is not None:
        _handlers[op] = handler
        return handler

    def _deco(fn: WSOpHandler) -> WSOpHandler:
        _handlers[op] = fn
        return fn

    return _deco


def get_handler(op: str) -> WSOpHandler | None:
    """Return the handler for ``op`` or ``None`` for unknown ops."""
    return _handlers.get(op)


def unregister_ws_op(op: str) -> bool:
    """Drop the registration for ``op``. Returns ``True`` if a handler was
    removed, ``False`` if there was nothing to remove. Used by the Schritt-4
    plugin loader on `deactivate(name)` to roll back a plugin's registrations.
    """
    return _handlers.pop(op, None) is not None


def registered_ops() -> list[str]:
    """List of currently-registered op names. Test/debug helper."""
    return sorted(_handlers)


def _clear_for_tests() -> None:
    """Wipe the registry. Tests use this to start from a known state."""
    _handlers.clear()
