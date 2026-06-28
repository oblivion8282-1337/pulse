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

import logging
import time

from fastapi import APIRouter, HTTPException, Query, WebSocket

from dcc_chat_gateway import __version__
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.credential_validator import CertClaims, resolve_user_identifier
from dcc_chat_gateway.routes.cert_login import _safe_int_eq
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
    # Accept first so the reject paths below can send real WebSocket close
    # frames with their numeric codes (4001/4003/4046). Starlette translates a
    # close()-before-accept() into an HTTP 403, which drops the close code and
    # leaves the client unable to tell the reject reasons apart.
    await websocket.accept()

    try:
        payload = await decode_token(token)
        user_id = int(payload["sub"])
        settings = get_settings()
        # Identische Identifier-Logik wie cert_login (Pairwise-Sub auf
        # Self-Host, raw user_id auf Cloud) — sonst landet der WS-User
        # unter einer anderen user_identifier als der Session-Token-User
        # und findet seine lokalen Guilds/Memberships nicht.
        # Pydantic CertClaims ist verlangt (resolve_user_identifier liest
        # ``.user_id`` / ``.pairwise_seed`` als Attribute, nicht als dict-keys).
        try:
            cert_claims = CertClaims(**payload)
        except Exception:
            # Defensive: Token ohne Cert-Felder (z.B. abgelaufener Session-Token
            # mit anderer Form) — fallback auf die alte Logik via
            # ``payload["pairwise_sub"]`` wenn vorhanden, sonst ``user_id``.
            cert_claims = None
        if cert_claims is not None:
            identifier = resolve_user_identifier(
                cert_claims,
                instance_mode=settings.pulse_instance_mode,
                instance_id=settings.pulse_instance_id,
            )
        else:
            # Fallback: nutze die rohen payload-Felder (alte Logik).
            identifier = (
                str(payload.get("pairwise_sub") or user_id)
                if settings.pulse_instance_mode == "self-host"
                else str(user_id)
            )
        is_self_host = settings.pulse_instance_mode == "self-host"
        # Admin-Flag: cert-claim (Cloud) ODER owner-self-host-match. Vorher
        # nur cert-claim → Self-Host-Owner kam mit is_admin=False rein, obwohl
        # cert_login den Session-Token korrekt auf admin=True setzt. Folge:
        # ready-frame zeigte is_admin=False, + Community war gegatet.
        is_owner_admin = (
            is_self_host
            and bool(settings.pulse_instance_owner_id)
            and _safe_int_eq(user_id, settings.pulse_instance_owner_id)
        )
        is_admin = bool(payload.get("admin", False)) or is_owner_admin
        user = AuthenticatedUser(
            id=user_id,
            username=payload.get("username", ""),
            is_admin=is_admin,
            payload=payload,
            user_identifier=identifier,
            is_self_host=is_self_host,
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

    # Reject already-expired tokens before `ready` — avoids sending `ready`
    # followed immediately by a 4001 close (inconsistent client state).
    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and float(exp) < time.time():
        await websocket.close(code=4001, reason="token expired")
        return

    # JWKS cold-start gate: refuse WS connections while the token validator
    # has not yet fetched its JWKS (auth-svc unreachable at startup).
    # Default True so tests that never set jwks_ready still pass.
    if not getattr(websocket.app.state, "jwks_ready", True):
        await websocket.close(code=4046, reason="jwks not ready")
        return

    # Hello-frame: sent immediately after accept, before ready.
    # Phase-4 frontend checks server_version against its MIN_SERVER_VERSION
    # build constant. Backend never validates the client version here.
    await websocket.send_json({
        "op": "hello",
        "server_version": __version__,
        "capabilities": [],
    })

    app = websocket.app
    manager = app.state.connection_manager
    accepted, is_first_socket = await manager.register(websocket, user)
    if not accepted:
        # Connection cap reached — close before the client has done any work.
        await websocket.close(code=4009, reason="too many connections")
        return
    redis = websocket.app.state.redis
    # Guard: if build_and_send_ready_frame raises before run_session_op_loop
    # is entered, the socket stays in the manager's dicts indefinitely.
    # run_session_op_loop already calls remove_socket in its own finally;
    # we only need to cover the case where we never reach it.
    entered_loop = False
    try:
        await build_and_send_ready_frame(
            websocket, user, manager, redis, is_first_socket=is_first_socket
        )
        entered_loop = True
        await run_session_op_loop(websocket, user, manager, redis, exp)
    finally:
        if not entered_loop:
            await manager.remove_socket(websocket)
