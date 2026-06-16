"""Built-in pub/sub channel handlers (Plugin-System Schritt 2).

Each branch of the old 6-way ``if/elif`` switch in
:meth:`pubsub_listener._ListenerMixin._listen` is now a free function
registered with :mod:`pubsub_channel_registry`. The listener calls
:func:`pubsub_channel_registry.get_channel_handler` and delegates — plugins
register additional handlers the same way (Schritt 4).

Behaviour is verbatim from the pre-split listener: same envelope shapes,
same log lines (channel/user_ids/targets), same membership / view-channel
filtering, same friend-cache lifecycle update for ``user:events``, same
strip-of-own-sockets + visibility filter on ``presence_update`` and
``presence_status_changed``. The mixin methods invoked here
(``_decode_payload``, ``_fan_out``, ``_filter_by_view_channel``,
``_apply_friend_lifecycle``, ``_apply_guild_membership_update``,
``_maybe_invalidate``, ``_filter_targets_by_guild``,
``_filter_presence_visibility``, ``user_voice_states_for``) still live on
:class:`pubsub.ConnectionManager`; we reach them via the ``manager``
parameter.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from dcc_chat_gateway.pubsub_channel_registry import register_channel_handler
from dcc_chat_gateway.pubsub_channels import (
    STREAM_EVENTS_CHANNEL,
    USER_EVENTS_CHANNEL,
    VOICE_EVENTS_CHANNEL,
)
from dcc_chat_gateway.pubsub_event_validation import maybe_drop
from dcc_chat_gateway.watchkeys import WATCH_EVENTS_CHANNEL, now_ms

# Side-effect: registers ``guild:events`` — kept in its own module so this
# file stays under the 350-line policy.
from dcc_chat_gateway import pubsub_channel_guild  # noqa: F401

if TYPE_CHECKING:
    from dcc_chat_gateway.pubsub import ConnectionManager

log = logging.getLogger(__name__)


def _payload_or_skip(
    manager: "ConnectionManager",
    msg: dict[str, Any],
    channel_label: str,
) -> dict | None:
    """Common decode + sanity guard for the channel handlers below.

    Returns the decoded ``dict`` payload, or ``None`` when the message is
    malformed / non-dict (logged + skipped — same as the inline branches).
    """
    payload = manager._decode_payload(msg["data"], channel_label)
    if not isinstance(payload, dict):
        return None
    return payload


@register_channel_handler(VOICE_EVENTS_CHANNEL)
async def handle_voice_events(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    payload = _payload_or_skip(manager, msg, VOICE_EVENTS_CHANNEL)
    if payload is None or "channel_id" not in payload:
        log.warning("voice:events malformed or missing channel_id: %r", payload)
        return
    # voice-signaling also publishes admin-override events on this channel
    # (force-mute / unmute). Recognise them by the explicit ``op`` field
    # and broadcast as a dedicated envelope rather than the snapshot path
    # below.
    if payload.get("op") == "voice_disconnect":
        if maybe_drop("voice_disconnect", payload, VOICE_EVENTS_CHANNEL):
            return
        voice_cid = str(payload.get("channel_id"))
        envelope = {
            "op": "voice_disconnect",
            "channel_id": voice_cid,
            "user_id": str(payload.get("user_id", "")),
        }
        async with manager._lock:
            raw_targets = list(manager._connections)
        targets = await manager._filter_by_view_channel(raw_targets, voice_cid)
        log.info(
            "voice:events disconnect channel=%s user=%s targets=%d/%d",
            envelope["channel_id"],
            envelope["user_id"],
            len(targets),
            len(raw_targets),
        )
        await manager._fan_out(targets, envelope)
        return
    if payload.get("op") == "voice_move":
        if maybe_drop("voice_move", payload, VOICE_EVENTS_CHANNEL):
            return
        voice_cid = str(payload.get("channel_id"))
        envelope = {
            "op": "voice_move",
            "channel_id": voice_cid,
            "user_id": str(payload.get("user_id", "")),
            "target_channel_id": str(payload.get("target_channel_id", "")),
        }
        # Filter on the *source* channel's view-permission — the moved user
        # is in it, so they pass and act on the signal. Other source-channel
        # viewers may see it too; their presence reconciles via the next
        # voice_state snapshot when the user re-joins the destination room.
        async with manager._lock:
            raw_targets = list(manager._connections)
        targets = await manager._filter_by_view_channel(raw_targets, voice_cid)
        log.info(
            "voice:events move channel=%s user=%s target=%s targets=%d/%d",
            envelope["channel_id"],
            envelope["user_id"],
            envelope["target_channel_id"],
            len(targets),
            len(raw_targets),
        )
        await manager._fan_out(targets, envelope)
        return
    if payload.get("op") == "voice_override":
        if maybe_drop("voice_override", payload, VOICE_EVENTS_CHANNEL):
            return
        voice_cid = str(payload.get("channel_id"))
        envelope = {
            "op": "voice_override",
            "channel_id": voice_cid,
            "user_id": str(payload.get("user_id", "")),
            "muted": bool(payload.get("muted", False)),
            "deafened": bool(payload.get("deafened", False)),
        }
        async with manager._lock:
            raw_targets = list(manager._connections)
        targets = await manager._filter_by_view_channel(raw_targets, voice_cid)
        log.info(
            "voice:events override channel=%s user=%s muted=%s deafened=%s targets=%d/%d",
            envelope["channel_id"],
            envelope["user_id"],
            envelope["muted"],
            envelope["deafened"],
            len(targets),
            len(raw_targets),
        )
        await manager._fan_out(targets, envelope)
        return
    voice_cid = str(payload.get("channel_id"))
    user_ids = [str(u) for u in payload.get("user_ids", [])]
    raw_states = payload.get("user_states")
    # voice-signaling publishes without user_states (it owns membership,
    # not mute/deafen) — enrich here so clients always get a complete
    # snapshot. Our own ``_republish`` path includes the field already;
    # trust it then to avoid a second mget.
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
        user_states = await manager.user_voice_states_for(user_ids)
    envelope = {
        "op": "voice_state",
        "channel_id": voice_cid,
        "user_ids": user_ids,
        "streaming_user_ids": [
            str(u) for u in payload.get("streaming_user_ids", [])
        ],
        "camera_user_ids": [
            str(u) for u in payload.get("camera_user_ids", [])
        ],
        "user_states": user_states,
    }
    async with manager._lock:
        raw_targets = list(manager._connections)
    targets = await manager._filter_by_view_channel(raw_targets, voice_cid)
    log.info(
        "voice:events broadcast channel=%s user_ids=%s streaming=%s states=%d targets=%d/%d",
        envelope["channel_id"],
        envelope["user_ids"],
        envelope["streaming_user_ids"],
        len(envelope["user_states"]),
        len(targets),
        len(raw_targets),
    )
    await manager._fan_out(targets, envelope)


@register_channel_handler(WATCH_EVENTS_CHANNEL)
async def handle_watch_events(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    payload = _payload_or_skip(manager, msg, WATCH_EVENTS_CHANNEL)
    if payload is None or "channel_id" not in payload:
        log.warning("watch:events malformed or missing channel_id: %r", payload)
        return
    watch_cid = str(payload.get("channel_id"))
    envelope = {
        "op": "watch_state",
        "channel_id": watch_cid,
        "party_id": str(payload.get("party_id", "")),
        "state": payload.get("state"),
        # Server-clock timestamp so viewers can calibrate their local clock
        # offset and extrapolate playback position against the server clock
        # (the single shared time base) instead of their own skewed Date.now().
        "server_now": now_ms(),
    }
    async with manager._lock:
        raw_targets = list(manager._connections)
    targets = await manager._filter_by_view_channel(raw_targets, watch_cid)
    log.info(
        "watch:events broadcast channel=%s active=%s targets=%d/%d",
        envelope["channel_id"],
        envelope["state"] is not None,
        len(targets),
        len(raw_targets),
    )
    await manager._fan_out(targets, envelope)


@register_channel_handler(STREAM_EVENTS_CHANNEL)
async def handle_stream_events(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    payload = _payload_or_skip(manager, msg, STREAM_EVENTS_CHANNEL)
    if payload is None or "channel_id" not in payload:
        log.warning("stream:events malformed or missing channel_id: %r", payload)
        return
    stream_cid = str(payload.get("channel_id"))
    envelope = {
        "op": "stream_state",
        "channel_id": stream_cid,
        "user_ids": [str(u) for u in payload.get("user_ids", [])],
    }
    async with manager._lock:
        raw_targets = list(manager._connections)
    targets = await manager._filter_by_view_channel(raw_targets, stream_cid)
    log.info(
        "stream:events broadcast channel=%s user_ids=%s targets=%d/%d",
        envelope["channel_id"],
        envelope["user_ids"],
        len(targets),
        len(raw_targets),
    )
    await manager._fan_out(targets, envelope)


@register_channel_handler(USER_EVENTS_CHANNEL)
async def handle_user_events(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    payload = _payload_or_skip(manager, msg, USER_EVENTS_CHANNEL)
    if payload is None:
        log.warning("user:events malformed: %r", payload)
        return
    target_uid_raw = payload.pop("_target_user_id", None)
    if target_uid_raw is None:
        log.warning("user:events missing _target_user_id: %r", payload)
        return
    try:
        target_uid = int(target_uid_raw)
    except (TypeError, ValueError):
        log.warning("user:events bad _target_user_id: %r", target_uid_raw)
        return
    # Schema validation runs AFTER stripping the routing-only
    # ``_target_user_id`` field — the event models don't know about it
    # (it's a listener-side wrapper, not part of the envelope schema).
    op = payload.get("op")
    if op and maybe_drop(op, payload, USER_EVENTS_CHANNEL):
        return
    # Friend/block lifecycle events (Etappe 2) update the per-socket
    # caches BEFORE fan-out so a follow-up mention/presence filter sees
    # the new state without waiting for the round-trip of a re-hydration
    # call.
    manager._apply_friend_lifecycle(target_uid, payload)
    async with manager._lock:
        targets = [
            ws for ws, u in manager._ws_user.items() if u.id == target_uid
        ]
    log.info(
        "user:events broadcast op=%s target_user=%s targets=%d",
        payload.get("op"), target_uid, len(targets),
    )
    await manager._fan_out(targets, payload)


@register_channel_handler("chat:channel:*")
async def handle_chat_channel(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    """Pattern handler for ``chat:channel:<id>`` Redis channels.

    Local subscribers are addressed by the trailing channel id, not the
    full Redis name. View-channel filter still applies; legacy bare
    message dicts get auto-wrapped as ``{"op": "message", "data": ...}``
    for backwards compatibility.
    """
    channel_id = channel.split(":")[-1]
    payload = manager._decode_payload(msg["data"], channel_id)
    if payload is None:
        return
    # Publishers may submit either a bare message dict (legacy,
    # auto-wrapped as ``op: "message"``) or a full envelope already
    # carrying its own ``op`` (used for message_update / message_delete /
    # reaction_add / reaction_remove).
    if isinstance(payload, dict) and "op" in payload:
        envelope = payload
        if maybe_drop(envelope["op"], envelope, f"chat:channel:{channel_id}"):
            return
    else:
        envelope = {"op": "message", "data": payload}
        if maybe_drop("message", envelope, f"chat:channel:{channel_id}"):
            return
    async with manager._lock:
        raw_targets = list(manager._subs.get(channel_id, ()))
    targets = await manager._filter_by_view_channel(raw_targets, channel_id)
    await manager._fan_out(targets, envelope)
