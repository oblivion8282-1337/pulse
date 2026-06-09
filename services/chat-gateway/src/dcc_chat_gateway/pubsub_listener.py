"""Redis pub/sub listener loop + fan-out helpers.

The listener was the biggest single block in the old monolith — a 6-way
per-channel ``if/elif`` switch. Since Plugin-System Schritt 2 the dispatch
table lives in :mod:`pubsub_channel_registry`; each branch is a handler in
:mod:`pubsub_channel_handlers`. This file now only owns:

* the long-running ``while True`` polling loop,
* the shared :meth:`_fan_out` helper (per-socket send with timeout,
  drop-on-error), and
* :staticmethod:`_decode_payload` (centralised JSON+bytes decoding so a
  malformed message logs once and skips instead of killing the loop).

State (``_ws_user``, ``_subs``, ``_pubsub`` …) and the higher-level helper
methods called from the channel handlers (``_filter_by_view_channel``,
``_apply_friend_lifecycle`` …) stay on :class:`ConnectionManager`; handlers
reach them via the ``manager`` parameter the dispatcher passes in.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

# Side-effect import: each handler in this module registers itself with
# :mod:`pubsub_channel_registry` at import time, so the dispatch table is
# populated before any listener runs.
from dcc_chat_gateway import pubsub_channel_handlers  # noqa: F401
from dcc_chat_gateway.pubsub_channel_registry import get_channel_handler

log = logging.getLogger(__name__)


class _ListenerMixin:
    """Adds the long-running pub/sub listener + fan-out helpers to
    :class:`ConnectionManager`. Not usable standalone — relies on attributes
    initialised in ``ConnectionManager.__init__`` and on methods defined on
    the host class."""

    # Per-socket send timeout during fan-out: a slow/stuck client must not hold
    # up delivery to everyone else on the channel (head-of-line blocking).
    _SEND_TIMEOUT_SECONDS = 5.0

    async def _fan_out(self, targets: list[WebSocket], envelope: dict) -> None:
        if not targets:
            return

        async def _send(ws: WebSocket, env: dict = envelope) -> WebSocket | None:
            try:
                await asyncio.wait_for(
                    ws.send_json(env), timeout=self._SEND_TIMEOUT_SECONDS
                )
                return None
            except asyncio.CancelledError:
                return ws
            except Exception:  # noqa: BLE001 — timeout, closed socket, etc.
                return ws

        results = await asyncio.gather(
            *(_send(ws) for ws in targets), return_exceptions=True
        )
        for r in results:
            if isinstance(r, WebSocket):
                await self.remove_socket(r)

    @staticmethod
    def _decode_payload(data: object, where: str) -> Any | None:
        if isinstance(data, (str, bytes)):
            try:
                return json.loads(data)
            except (ValueError, TypeError):
                # A malformed message must not kill the listener (it serves
                # *all* channels). Skip it.
                log.warning("skipping malformed pubsub message on %s", where)
                return None
        return data

    async def _dispatch_message(self, msg) -> None:
        """Route one pub/sub message dict to its channel handler.

        Shared by the listen loop and ``start()``'s subscribe-ack drain (the
        drain may encounter a real message buffered during a self-heal
        re-subscribe — it must be delivered, not dropped). Non-message frames
        (subscribe acks) are ignored. Handler failures are isolated: a single
        bad event (malformed payload, an id out of int64 range, a transient DB
        error) must NOT propagate and kill the listener — if it did, ALL
        real-time delivery (chat, voice, watch, stream) would silently stop for
        every client on this pod until something called ``start()`` again
        (exactly the failure that left watch-party play/pause/seek dead).
        """
        if msg.get("type") not in ("message", "pmessage"):
            return
        channel = msg.get("channel")
        if isinstance(channel, bytes):
            channel = channel.decode()
        handler = get_channel_handler(channel)
        if handler is None:
            # No registered handler — silently ignore. Subscribing to a channel
            # we don't dispatch is wasteful but not a bug; logging would spam.
            return
        try:
            await handler(self, channel, msg)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception(
                "pubsub handler for %s failed; skipping this event", channel
            )

    async def _listen(self) -> None:
        try:
            while True:
                msg = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None:
                    continue
                await self._dispatch_message(msg)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # Reaching here means the loop itself broke (e.g. the Redis
            # connection dropped in get_message) — genuinely fatal. Leaving
            # ``_started = True`` with a dead task would make every later
            # ``start()`` a no-op, so reset the flag to allow a restart.
            log.exception("pubsub listener crashed; flagging for restart")
            self._started = False
            raise
