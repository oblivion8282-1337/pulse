"""Redis pub/sub channel-handler registry (Plugin-System Schritt 2).

The pub/sub listener loop in :mod:`pubsub_listener` used to be a 6-way
if/elif switch over the channel name. To let plugins (Schritt 4) hook into
new Redis channels without touching the listener, the dispatch table lives
behind this registry.

Design notes
------------
* Handlers receive ``(manager, channel, msg)`` — the :class:`ConnectionManager`
  instance (so handlers can reach ``_filter_by_view_channel`` /
  ``_fan_out`` / ``_lock`` / ``_ws_user`` / etc.), the channel name (matters
  for ``chat:channel:*`` pattern handlers that need the trailing id), and
  the raw redis message dict (handlers decode the payload themselves so a
  malformed message stays local — same contract as the pre-split listener).

* Resolution: exact match first, then the lone ``chat:channel:*`` pattern.
  We keep the pattern matching dead simple — only one wildcard pattern
  exists today; if a second one ever lands, add it to ``_PATTERNS`` below.
  A generic ``fnmatch``-based pattern table would be flashy but would
  match too eagerly (e.g. a future ``chat:dm:*`` would suddenly land in
  the same bucket).

* :func:`register_channel_handler` works as decorator *or* direct call —
  same dual API as :func:`routes.ws_ops_registry.register_ws_op`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from dcc_chat_gateway.pubsub import ConnectionManager


ChannelHandler = Callable[["ConnectionManager", str, dict[str, Any]], Awaitable[None]]


_handlers: dict[str, ChannelHandler] = {}

# Pattern channels — kept tiny and explicit instead of a generic fnmatch
# table. ``"chat:channel:*"`` is the only wildcard today; the lookup checks
# this list after the exact-match table comes up empty.
_PATTERNS: tuple[str, ...] = ("chat:channel:*",)


def register_channel_handler(
    channel: str, handler: ChannelHandler | None = None
) -> ChannelHandler | Callable[[ChannelHandler], ChannelHandler]:
    """Register ``handler`` for the given channel name (or wildcard pattern).

    Two call styles, same as :func:`register_ws_op`::

        register_channel_handler("voice:events", handle_voice_events)

        @register_channel_handler("voice:events")
        async def handle_voice_events(manager, channel, msg): ...

    Wildcard patterns are limited to the entries in :data:`_PATTERNS`
    (currently only ``"chat:channel:*"``). Last writer wins.
    """
    if handler is not None:
        _handlers[channel] = handler
        return handler

    def _deco(fn: ChannelHandler) -> ChannelHandler:
        _handlers[channel] = fn
        return fn

    return _deco


def get_channel_handler(channel: str) -> ChannelHandler | None:
    """Resolve a Redis channel name to its handler, or ``None``.

    Exact-match table first, then the explicit wildcard patterns. The
    pattern match is intentionally minimal — see module docstring.
    """
    h = _handlers.get(channel)
    if h is not None:
        return h
    for pattern in _PATTERNS:
        # Strip trailing ``*`` and match the prefix. ``fnmatch`` would be
        # overkill for the one wildcard we ship.
        if pattern.endswith("*") and channel.startswith(pattern[:-1]):
            h = _handlers.get(pattern)
            if h is not None:
                return h
    return None


def unregister_channel_handler(channel: str) -> bool:
    """Drop the registration for ``channel``. Returns ``True`` if a handler
    was removed, ``False`` otherwise. Used by the Schritt-4 plugin loader to
    roll back a plugin's pub/sub channel handlers on deactivate.
    """
    return _handlers.pop(channel, None) is not None


def registered_channels() -> list[str]:
    """List of currently-registered channel names (incl. patterns)."""
    return sorted(_handlers)


def _clear_for_tests() -> None:
    """Wipe the registry. Used by registry tests to start from a known state."""
    _handlers.clear()
