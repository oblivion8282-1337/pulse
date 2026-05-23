"""WebSocket endpoint: subscribe / unsubscribe / send fan-out.

Server→client ops, in addition to the chat ops in PLAN.md §5.2:
  - ``{"op": "voice_state", "channel_id": "<id>", "user_ids": ["<id>", ...]}``
    — pushed whenever a voice channel's membership changes (relayed from the
    voice-signaling service over Redis ``voice:events``). Clients filter by
    their own guild membership. The ``ready`` payload additionally carries
    ``voice_states: [{"channel_id": ..., "user_ids": [...]}, ...]`` with the
    current state of every voice channel in the user's guilds.
  - ``{"op": "stream_state", "channel_id": "<id>", "user_id": "<id>"|null,
    "active": true|false}`` — pushed whenever a channel's HQ stream starts or
    stops (relayed from media-svc over Redis ``stream:events``; T5b). Mirrors
    the voice_state mechanism. The ``ready`` payload additionally carries
    ``stream_states: [{"channel_id": ..., "user_id": ...}, ...]`` listing every
    channel in the user's guilds that currently has an active HQ stream.

Client→server ops, in addition to ``subscribe``/``unsubscribe``/``send``:
  - ``{"op": "voice_self_state", "channel_id": "<id>"|null,
       "mic_muted": bool, "deafened": bool}`` — the user reports their own
    mute/deafen state to the gateway. ``channel_id`` is the voice channel they
    are currently in (or ``null`` to clear state on disconnect). The gateway
    persists the state in Redis and republishes the channel's voice snapshot
    so other clients re-render their member list. Both flags off + a channel
    id deletes the Redis key (absence == default-off).
  - ``{"op": "watch_start", "channel_id": "<id>", "source_url": "<url>"}`` —
    start a synchronised watch party in a voice channel. URL is validated via
    ``watch_source.parse_source``; caller becomes host. Rejected if a party is
    already active.
  - ``{"op": "watch_stop", "channel_id": "<id>"}`` — host-only; deletes state.
  - ``{"op": "watch_control", "channel_id": "<id>", "action":
       "play"|"pause"|"seek", "position": <seconds>}`` — host-only; updates
    state + broadcasts ``watch_state``.
  - ``{"op": "watch_heartbeat", "channel_id": "<id>", "position": <seconds>}``
    — host-only; updates ``position`` + ``updated_at`` so viewers can correct
    drift. Debounced server-side to ≤1 write / 2s.

The ``ready`` payload additionally carries
``watch_states: [{"channel_id": ..., "state": {...}}, ...]`` for every voice
channel in the user's guilds that has an active watch party. Server pushes
``{"op": "watch_state", "channel_id": ..., "state": {...}|null}`` whenever
state changes (null = party ended).
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException, Query, WebSocket

from dcc_chat_gateway.routes.ws_ops import run_session_op_loop
from dcc_chat_gateway.routes.ws_ready import build_and_send_ready_frame
from dcc_chat_gateway.security import AuthenticatedUser, decode_token

log = logging.getLogger(__name__)

router = APIRouter()

# Largest text frame we are willing to buffer from a client. uvicorn should
# additionally be deployed with `--ws-max-size` for defense in depth — this
# check is the application-level backstop against a memory-DoS via huge frames.
_MAX_WS_FRAME_BYTES = 16 * 1024

# A single oversized frame is more likely a client bug (a long paste, a runaway
# loop) than an attack — answer with an error frame and keep the session. Only
# repeated abuse closes it.
_MAX_OVERSIZE_FRAMES = 5

# nonce column is VARCHAR(64); trim defensively so a long client nonce can't
# trigger a Postgres StringDataRightTruncation.
_MAX_NONCE_LEN = 64


async def _close_when_token_expires(websocket: WebSocket, exp: float) -> None:
    """Close the socket with 4001 once the access token's `exp` passes, so a
    WS connection never outlives the credential that authorised it. Cancelled
    by the endpoint on disconnect."""
    delay = exp - time.time()
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        await websocket.close(code=4001, reason="token expired")
    except Exception:  # noqa: BLE001 — already closed
        pass


def _channel_id(value: object) -> int | None:
    """Parse a client-supplied channel id to int, or None if malformed."""
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    # Authenticate before accepting subprotocols.
    try:
        payload = await decode_token(token)
        user_id = int(payload["sub"])
        user = AuthenticatedUser(
            id=user_id,
            username=payload.get("username", ""),
            is_admin=bool(payload.get("admin", False)),
            payload=payload,
        )
    except (HTTPException, KeyError, ValueError):
        await websocket.close(code=4001, reason="unauthorized")
        return

    # Email-verification gate: a token carrying ``email_blocked`` belongs to
    # an unverified account on an SMTP-configured deployment. Distinct close
    # code (4003) so the client can route to the "verify your email" screen
    # instead of treating it as a generic auth failure.
    if payload.get("email_blocked"):
        await websocket.close(code=4003, reason="email not verified")
        return

    # Reject already-expired tokens before accepting — avoids sending `ready`
    # followed immediately by a 4001 close (inconsistent client state).
    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and float(exp) < time.time():
        await websocket.close(code=4001, reason="token expired")
        return

    await websocket.accept()
    app = websocket.app
    manager = app.state.connection_manager
    if not await manager.register(websocket, user):
        # Connection cap reached — close before the client has done any work.
        await websocket.close(code=4009, reason="too many connections")
        return
    redis = websocket.app.state.redis
    await build_and_send_ready_frame(websocket, user, manager, redis)
    await run_session_op_loop(websocket, user, manager, redis, exp)
