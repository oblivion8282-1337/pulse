"""Redis pub/sub listener loop + fan-out helpers.

Extracted from :mod:`pubsub` as a mixin so the listener (the biggest single
block in the old monolith — 6 per-channel handler branches) lives in its
own file. State (``_ws_user``, ``_subs``, ``_pubsub`` …) and the helper
methods it calls (``_filter_by_view_channel``, ``_apply_friend_lifecycle`` …)
remain on :class:`ConnectionManager`; the mixin reaches them via ``self.``
through cooperative inheritance.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway.pubsub_channels import (
    GUILD_EVENTS_CHANNEL,
    STREAM_EVENTS_CHANNEL,
    USER_EVENTS_CHANNEL,
    VOICE_EVENTS_CHANNEL,
)
from dcc_chat_gateway.watchkeys import WATCH_EVENTS_CHANNEL

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

    async def _listen(self) -> None:
        try:
            while True:
                msg = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None:
                    continue
                if msg.get("type") not in ("message", "pmessage"):
                    continue
                channel = msg.get("channel")
                if isinstance(channel, bytes):
                    channel = channel.decode()

                if channel == VOICE_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], VOICE_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "channel_id" not in payload:
                        log.warning(
                            "voice:events malformed or missing channel_id: %r", payload
                        )
                        continue
                    # voice-signaling also publishes admin-override events on
                    # this channel (force-mute / unmute). Recognise them by the
                    # explicit ``op`` field and broadcast as a dedicated envelope
                    # rather than the snapshot path below.
                    if payload.get("op") == "voice_disconnect":
                        voice_cid = str(payload.get("channel_id"))
                        envelope = {
                            "op": "voice_disconnect",
                            "channel_id": voice_cid,
                            "user_id": str(payload.get("user_id", "")),
                        }
                        async with self._lock:
                            raw_targets = list(self._connections)
                        targets = await self._filter_by_view_channel(
                            raw_targets, voice_cid
                        )
                        log.info(
                            "voice:events disconnect channel=%s user=%s targets=%d/%d",
                            envelope["channel_id"],
                            envelope["user_id"],
                            len(targets),
                            len(raw_targets),
                        )
                        await self._fan_out(targets, envelope)
                        continue
                    if payload.get("op") == "voice_override":
                        voice_cid = str(payload.get("channel_id"))
                        envelope = {
                            "op": "voice_override",
                            "channel_id": voice_cid,
                            "user_id": str(payload.get("user_id", "")),
                            "muted": bool(payload.get("muted", False)),
                            "deafened": bool(payload.get("deafened", False)),
                        }
                        async with self._lock:
                            raw_targets = list(self._connections)
                        targets = await self._filter_by_view_channel(
                            raw_targets, voice_cid
                        )
                        log.info(
                            "voice:events override channel=%s user=%s muted=%s deafened=%s targets=%d/%d",
                            envelope["channel_id"],
                            envelope["user_id"],
                            envelope["muted"],
                            envelope["deafened"],
                            len(targets),
                            len(raw_targets),
                        )
                        await self._fan_out(targets, envelope)
                        continue
                    voice_cid = str(payload.get("channel_id"))
                    user_ids = [str(u) for u in payload.get("user_ids", [])]
                    raw_states = payload.get("user_states")
                    # voice-signaling publishes without user_states (it owns
                    # membership, not mute/deafen) — enrich here so clients always
                    # get a complete snapshot. Our own _republish path includes
                    # the field already; trust it then to avoid a second mget.
                    if isinstance(raw_states, dict):
                        user_states = {
                            str(uid): {
                                "mic_muted": bool(s.get("mic_muted")),
                                "deafened": bool(s.get("deafened")),
                            }
                            for uid, s in raw_states.items()
                            if isinstance(s, dict)
                            and (s.get("mic_muted") or s.get("deafened"))
                        }
                    else:
                        user_states = await self.user_voice_states_for(user_ids)
                    envelope = {
                        "op": "voice_state",
                        "channel_id": voice_cid,
                        "user_ids": user_ids,
                        "streaming_user_ids": [
                            str(u) for u in payload.get("streaming_user_ids", [])
                        ],
                        "user_states": user_states,
                    }
                    async with self._lock:
                        raw_targets = list(self._connections)
                    targets = await self._filter_by_view_channel(raw_targets, voice_cid)
                    log.info(
                        "voice:events broadcast channel=%s user_ids=%s streaming=%s states=%d targets=%d/%d",
                        envelope["channel_id"],
                        envelope["user_ids"],
                        envelope["streaming_user_ids"],
                        len(envelope["user_states"]),
                        len(targets),
                        len(raw_targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == WATCH_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], WATCH_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "channel_id" not in payload:
                        log.warning(
                            "watch:events malformed or missing channel_id: %r", payload
                        )
                        continue
                    watch_cid = str(payload.get("channel_id"))
                    envelope = {
                        "op": "watch_state",
                        "channel_id": watch_cid,
                        "state": payload.get("state"),
                    }
                    async with self._lock:
                        raw_targets = list(self._connections)
                    targets = await self._filter_by_view_channel(raw_targets, watch_cid)
                    log.info(
                        "watch:events broadcast channel=%s active=%s targets=%d/%d",
                        envelope["channel_id"],
                        envelope["state"] is not None,
                        len(targets),
                        len(raw_targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == STREAM_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], STREAM_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "channel_id" not in payload:
                        log.warning(
                            "stream:events malformed or missing channel_id: %r", payload
                        )
                        continue
                    stream_cid = str(payload.get("channel_id"))
                    envelope = {
                        "op": "stream_state",
                        "channel_id": stream_cid,
                        "user_ids": [str(u) for u in payload.get("user_ids", [])],
                    }
                    async with self._lock:
                        raw_targets = list(self._connections)
                    targets = await self._filter_by_view_channel(raw_targets, stream_cid)
                    log.info(
                        "stream:events broadcast channel=%s user_ids=%s targets=%d/%d",
                        envelope["channel_id"],
                        envelope["user_ids"],
                        len(targets),
                        len(raw_targets),
                    )
                    await self._fan_out(targets, envelope)
                    continue

                if channel == USER_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], USER_EVENTS_CHANNEL)
                    if not isinstance(payload, dict):
                        log.warning("user:events malformed: %r", payload)
                        continue
                    target_uid_raw = payload.pop("_target_user_id", None)
                    if target_uid_raw is None:
                        log.warning("user:events missing _target_user_id: %r", payload)
                        continue
                    try:
                        target_uid = int(target_uid_raw)
                    except (TypeError, ValueError):
                        log.warning(
                            "user:events bad _target_user_id: %r", target_uid_raw
                        )
                        continue
                    # Friend/block lifecycle events (Etappe 2) update the
                    # per-socket caches BEFORE fan-out so a follow-up
                    # mention/presence filter sees the new state without
                    # waiting for the round-trip of a re-hydration call.
                    self._apply_friend_lifecycle(target_uid, payload)
                    async with self._lock:
                        targets = [
                            ws for ws, u in self._ws_user.items() if u.id == target_uid
                        ]
                    log.info(
                        "user:events broadcast op=%s target_user=%s targets=%d",
                        payload.get("op"), target_uid, len(targets),
                    )
                    await self._fan_out(targets, payload)
                    continue

                if channel == GUILD_EVENTS_CHANNEL:
                    payload = self._decode_payload(msg["data"], GUILD_EVENTS_CHANNEL)
                    if not isinstance(payload, dict) or "op" not in payload:
                        log.warning("guild:events malformed or missing op: %r", payload)
                        continue
                    self._apply_guild_membership_update(payload)
                    self._maybe_invalidate(payload)
                    async with self._lock:
                        targets = list(self._connections)
                    # Per-guild events (bans, member adds/removes/updates,
                    # channel_bump) are scoped to actual guild members rather
                    # than blasted to every connected socket. Other ops keep
                    # the wide broadcast pattern they were built on.
                    targets = self._filter_targets_by_guild(payload, targets)
                    # ``presence_update`` is broadcast to *every* connected
                    # socket so clients learn about online/offline transitions
                    # in any guild they share — but we never deliver the event
                    # for our OWN user to OUR sockets. Semantically meaningless
                    # (the client trivially knows it's online), and avoids the
                    # listener-loop racing the first-connect event ahead of
                    # this socket's own ``ready`` frame.
                    if payload.get("op") == "presence_update":
                        try:
                            self_uid = int(payload.get("user_id", "0"))
                        except (TypeError, ValueError):
                            self_uid = 0
                        if self_uid:
                            # Strip the sender's own sockets first (semantically
                            # meaningless self-event; would also race the ready
                            # frame), then apply block-aware visibility filter
                            # — a blocker / blocked party must not see status
                            # transitions of the other. Friend-only / shared-
                            # guild gating stays purely client-side for now
                            # (the FE already filters by visible_member_ids);
                            # this filter only blocks the hard cut.
                            targets = [
                                ws for ws in targets
                                if (u := self._ws_user.get(ws)) is None
                                or u.id != self_uid
                            ]
                            target_uids = {
                                u.id for ws in targets
                                if (u := self._ws_user.get(ws)) is not None
                            }
                            visible = self._filter_presence_visibility(
                                target_uids, self_uid
                            )
                            if visible != target_uids:
                                targets = [
                                    ws for ws in targets
                                    if (u := self._ws_user.get(ws)) is not None
                                    and u.id in visible
                                ]
                    # ``presence_status_changed`` (Etappe 3) is published on
                    # guild:events by the REST route + idle sweeper. The
                    # envelope carries ``_sender_user_id`` so we can strip the
                    # sender's own sockets (they already received the real
                    # status via USER_EVENTS_CHANNEL) and apply the block-aware
                    # visibility filter. The status value in the envelope has
                    # already been masked (invisible → offline) by the
                    # publisher — we only drop/keep recipients here.
                    if payload.get("op") == "presence_status_changed":
                        sender_raw = payload.pop("_sender_user_id", None)
                        try:
                            sender_uid_psc = int(sender_raw) if sender_raw else 0
                        except (TypeError, ValueError):
                            sender_uid_psc = 0
                        if sender_uid_psc:
                            targets = [
                                ws for ws in targets
                                if (u := self._ws_user.get(ws)) is None
                                or u.id != sender_uid_psc
                            ]
                            target_uids_psc = {
                                u.id for ws in targets
                                if (u := self._ws_user.get(ws)) is not None
                            }
                            visible_psc = self._filter_presence_visibility(
                                target_uids_psc, sender_uid_psc
                            )
                            if visible_psc != target_uids_psc:
                                targets = [
                                    ws for ws in targets
                                    if (u := self._ws_user.get(ws)) is not None
                                    and u.id in visible_psc
                                ]
                    # ``channel_bump`` carries no body, but still flags a
                    # channel as unread + plays a ping sound. On top of the
                    # guild-member scoping above, gate it on VIEW_CHANNEL so a
                    # member without access to a private channel isn't pinged
                    # for it. ``dm_bump`` deliberately stays wide — DM channels
                    # have no permission overlay; the client filters by
                    # membership.
                    if payload.get("op") == "channel_bump":
                        targets = await self._filter_by_view_channel(
                            targets, str(payload.get("channel_id", ""))
                        )
                    log.info(
                        "guild:events broadcast op=%s targets=%d", payload.get("op"), len(targets)
                    )
                    await self._fan_out(targets, payload)
                    continue

                channel_id = channel.split(":")[-1]
                payload = self._decode_payload(msg["data"], channel_id)
                if payload is None:
                    continue
                # Publishers may submit either a bare message dict (legacy,
                # auto-wrapped as `op: "message"`) or a full envelope already
                # carrying its own `op` (used for message_update /
                # message_delete / reaction_add / reaction_remove).
                if isinstance(payload, dict) and "op" in payload:
                    envelope = payload
                else:
                    envelope = {"op": "message", "data": payload}
                async with self._lock:
                    raw_targets = list(self._subs.get(channel_id, ()))
                targets = await self._filter_by_view_channel(raw_targets, channel_id)
                await self._fan_out(targets, envelope)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # A fatal error here would otherwise leave `_started = True` with a
            # dead task — no further `start()` would do anything. Reset the flag
            # so the next `start()` (e.g. a health-check-triggered restart, or a
            # fresh request path that calls start()) can bring it back.
            log.exception("pubsub listener crashed; flagging for restart")
            self._started = False
            raise
