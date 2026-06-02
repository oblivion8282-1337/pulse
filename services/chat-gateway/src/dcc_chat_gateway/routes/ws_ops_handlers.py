"""Built-in WS op handlers (Plugin-System Schritt 2).

Hosts the handlers for the short, hand-rolled ops that used to live as
``elif`` branches inside ``routes/ws_ops.py``'s op-loop. The longer ``send``
op gets its own module (``ws_op_send.py``). Watch-party ops still delegate
into :mod:`routes.ws_watch` — the registry entry just adapts the signature.

Importing this module side-effects all registrations through
:func:`register_ws_op`. The dispatcher in :mod:`routes.ws_ops` imports it
once at module import time so the registry is populated before any
WebSocket loop runs.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import WebSocketDisconnect

from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions

from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    CHANNEL_TYPE_VOICE,
)
from dcc_chat_gateway.permissions import resolve_permissions
from dcc_chat_gateway.presence_status import (
    STATUS_DND,
    STATUS_INVISIBLE,
    STATUS_ONLINE,
    broadcast_presence_status_changed,
    get_presence_status,
    set_presence_status,
    update_activity,
)
from dcc_chat_gateway.routes import watch_handoff, ws_watch
from dcc_chat_gateway.routes._deps import channel_membership, resolve_channel_for_user
from dcc_chat_gateway.routes.ws_op_send import handle_send
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext, register_ws_op

log = logging.getLogger(__name__)


def _channel_id(value: object) -> int | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


@register_ws_op("subscribe")
async def handle_subscribe(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        await ctx.websocket.send_json(
            {"op": "error", "code": 4003, "msg": "channel_id required"}
        )
        return
    cid = str(cid_int)
    # DM channels go through the same /ws subscribe path as guild channels —
    # resolve_channel_for_user enforces the right access check (guild
    # membership vs DM membership). For guild channels we additionally
    # require VIEW_CHANNEL — otherwise subscribe would succeed but the
    # broadcast filter would drop every message later, producing a
    # confusing silent-channel UX.
    async with SessionLocal() as session:
        resolved = await resolve_channel_for_user(session, cid_int, ctx.user.id)
        if resolved is None:
            await ctx.websocket.send_json(
                {"op": "error", "code": 4004, "msg": "channel not accessible"}
            )
            return
        kind, ch = resolved
        # Text-channel subscribes get the VIEW_CHANNEL gate so silent-channel
        # UX doesn't bite the user. Voice channels subscribe via this same
        # path (for stream_chat_message fan-out) and must NOT be gated —
        # denying VIEW on a voice channel still lets you join the voice room
        # (the CONNECT bit is the real voice-join gate). Live filter at
        # fan-out time catches any remaining mismatch.
        if kind == "guild" and ch.type == CHANNEL_TYPE_TEXT:
            perms = await resolve_permissions(session, ctx.user, ch.guild_id, cid_int)
            if not has_permission(perms, Permissions.VIEW_CHANNEL):
                await ctx.websocket.send_json(
                    {"op": "error", "code": 4012, "msg": "channel not accessible"}
                )
                return
    await ctx.manager.subscribe(ctx.websocket, cid)
    # Voice channels are subscribed (for stream_chat_message fanout) but
    # never enter the local ``subscribed`` map, so the send fast-path can't
    # post regular messages to them — the slow path rejects them via the
    # same CHANNEL_TYPE_TEXT check.
    if kind == "guild" and ch.type != CHANNEL_TYPE_TEXT:
        return
    ctx.subscribed[cid] = ch.guild_id if kind == "guild" else None


@register_ws_op("unsubscribe")
async def handle_unsubscribe(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        return
    cid = str(cid_int)
    await ctx.manager.unsubscribe(ctx.websocket, cid)
    ctx.subscribed.pop(cid, None)


@register_ws_op("voice_self_state")
async def handle_voice_self_state(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    cid_raw = msg.get("channel_id")
    cid_int: int | None = None
    if cid_raw is not None:
        cid_int = _channel_id(cid_raw)
        if cid_int is None:
            await ctx.websocket.send_json(
                {"op": "error", "code": 4011, "msg": "invalid channel_id"}
            )
            return
    mic_muted = bool(msg.get("mic_muted"))
    deafened = bool(msg.get("deafened"))
    cid_str: str | None = None
    if cid_int is not None:
        # Validate membership only when a channel id is given. We require
        # the channel to be a voice channel — text channels have no voice
        # state.
        async with SessionLocal() as session:
            channel = await channel_membership(session, cid_int, ctx.user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await ctx.websocket.send_json(
                {"op": "error", "code": 4004, "msg": "channel not accessible"}
            )
            return
        cid_str = str(cid_int)
    ctx.current_voice_channel = cid_str
    try:
        await ctx.manager.set_user_voice_state(
            str(ctx.user.id), mic_muted, deafened, cid_str
        )
    except Exception:  # noqa: BLE001
        log.exception("voice_self_state write failed for user=%s", ctx.user.id)


@register_ws_op("watch_start")
async def handle_watch_start(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_start(
        ctx.websocket,
        ctx.user,
        msg,
        session_factory=SessionLocal,
        hosted_parties=ctx.hosted_parties,
        watched_parties=ctx.watched_parties,
    )


@register_ws_op("watch_join")
async def handle_watch_join(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_join(
        ctx.websocket,
        ctx.user,
        msg,
        session_factory=SessionLocal,
        watched_parties=ctx.watched_parties,
    )


@register_ws_op("watch_leave")
async def handle_watch_leave(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_leave(
        ctx.websocket, ctx.user, msg, watched_parties=ctx.watched_parties
    )


@register_ws_op("watch_handoff")
async def handle_watch_handoff(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await watch_handoff.handle_handoff(ctx.websocket, ctx.user, msg)


@register_ws_op("watch_stop")
async def handle_watch_stop(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_stop(
        ctx.websocket, ctx.user, msg, hosted_parties=ctx.hosted_parties
    )


@register_ws_op("watch_control")
async def handle_watch_control(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_control(ctx.websocket, ctx.user, msg)


@register_ws_op("watch_heartbeat")
async def handle_watch_heartbeat(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_heartbeat(ctx.websocket, ctx.user, msg)


@register_ws_op("ping")
async def handle_ping(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Keepalive ping → immediate ``pong`` reply.

    The browser WebSocket API can neither send protocol-level pings nor
    surface a half-open connection (a silently-dropped TCP socket never
    fires ``close``). So the client sends ``{"op": "ping"}`` on an interval
    and force-closes + reconnects when no ``pong`` returns within its
    timeout. This reply is the only thing the server owes — no DB, no Redis,
    no side effects, so it stays cheap enough to run on every open socket.
    """
    await ctx.websocket.send_json({"op": "pong"})


@register_ws_op("activity")
async def handle_activity(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Etappe-3 client heartbeat / mouse-move / key-press.

    Updates the presence:activity ZSET and, if the user's current status is
    ``idle``, flips it back to ``online`` and broadcasts. ``dnd`` and
    ``invisible`` are manual overrides — not overwritten.
    """
    try:
        await update_activity(ctx.redis, ctx.user.id)
        current_status = await get_presence_status(ctx.redis, ctx.user.id)
        if current_status == STATUS_ONLINE:
            pass  # already online, nothing to broadcast
        elif current_status not in (STATUS_DND, STATUS_INVISIBLE):
            # Was idle → return to online
            await set_presence_status(ctx.redis, ctx.user.id, STATUS_ONLINE)
            await broadcast_presence_status_changed(
                ctx.manager, ctx.redis, ctx.user.id, STATUS_ONLINE
            )
    except Exception:  # noqa: BLE001
        log.exception("activity op failed for user=%s", ctx.user.id)
    # No reply — lightweight, fire-and-forget.


# ``send`` op is registered in routes.ws_op_send. Re-register here so
# importing this module wires every built-in op in one shot.
register_ws_op("send", handle_send)


@register_ws_op("profile_statement")
async def handle_profile_statement(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Accept a Cloud-signed profile statement from the client and cache it.

    The client may send this op at any point after the connection is accepted
    (typically right after receiving the ``ready`` frame).  It is silently
    ignored when JWKS are unavailable or the statement is a replay; only hard
    validation failures (bad signature, wrong purpose, expired) close the
    connection with 4047.

    A missing or empty ``jwt`` field is treated as a no-op — the client may
    send the frame speculatively and include the JWT once it has one.
    """
    from dcc_chat_gateway.credential_validator import (
        REDIS_JWKS_KEY,
        _build_pubkey_from_jwks,
    )
    from dcc_chat_gateway.user_profile_cache import (
        ProfileStatementInvalid,
        ProfileStatementReplay,
        upsert_profile_statement,
    )

    statement_jwt: str | None = msg.get("jwt") or msg.get("statement")
    if not statement_jwt or not isinstance(statement_jwt, str):
        return  # no-op — client sent frame without JWT

    # Fetch JWKS from Redis cache (fail-open when cache is cold).
    try:
        raw_jwks = await ctx.redis.get(REDIS_JWKS_KEY)
    except Exception:  # noqa: BLE001
        log.warning("profile_statement: redis unavailable, skipping")
        return

    if not raw_jwks:
        log.debug("profile_statement: JWKS cache cold, skipping")
        return

    if isinstance(raw_jwks, bytes):
        raw_jwks = raw_jwks.decode()

    import json as _json

    try:
        cloud_jwks = _json.loads(raw_jwks)
    except Exception:  # noqa: BLE001
        log.warning("profile_statement: could not parse JWKS JSON")
        return

    from dcc_chat_gateway.config import get_settings

    settings = get_settings()
    try:
        async with SessionLocal() as session:
            # instance_mode from config (NOT hardcoded): self-host keys the
            # cached profile by the pairwise-sub. pairwise_seed is read from the
            # statement's own claim inside upsert (the Cloud embeds it).
            await upsert_profile_statement(
                session,
                statement_jwt,
                cloud_jwks=cloud_jwks,
                instance_mode=settings.pulse_instance_mode,
                instance_id=str(settings.pulse_instance_id),
            )
            await session.commit()
    except ProfileStatementReplay:
        log.debug("profile_statement: replay for user=%s, ignoring", ctx.user.id)
    except ProfileStatementInvalid as exc:
        log.warning("profile_statement: invalid for user=%s: %s", ctx.user.id, exc)
        try:
            await ctx.websocket.close(code=4047, reason="invalid profile statement")
        except Exception:  # noqa: BLE001
            pass
        # Signal the op-loop to stop cleanly. Without this raise the loop
        # would call receive_text() on the already-closed socket, which may
        # raise RuntimeError (not caught by the loop's WebSocketDisconnect
        # handler) instead of a graceful disconnect.
        raise WebSocketDisconnect(code=4047)
    except Exception:  # noqa: BLE001
        log.exception("profile_statement: unexpected error for user=%s", ctx.user.id)
