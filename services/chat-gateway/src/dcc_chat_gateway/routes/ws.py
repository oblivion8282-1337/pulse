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
from dcc_chat_gateway.client_ip import ws_client_ip
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.faehigkeiten import SERVER_FAEHIGKEITEN
from dcc_chat_gateway.routes.ws_ops import run_session_op_loop
from dcc_chat_gateway.routes.ws_ready import build_and_send_ready_frame
from dcc_chat_gateway.security import AuthenticatedUser, decode_token
from dcc_chat_gateway.suspend_poller import read_state as read_suspend_state

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

# ---------------------------------------------------------------------------
# Schliesscodes des WS-Eintritts.
#
# Ein Schliesscode ist die EINZIGE Information, die der Klient auswertet — den
# ``reason``-Text liest ``_mapCloseCode`` in
# ``web/src/lib/ws/gateway-connection.ts`` nirgends. Zwei Bedeutungen auf
# denselben Code zu legen heisst deshalb: der Klient kann sie nicht trennen.
# Genau das war bis 2026-08-17 der Fall — Instanz-Sperre und unbestaetigte
# E-Mail teilten sich 4003, das der Klient seinerseits als „CORS blockiert"
# fuehrte (ein Code, den serverseitig nie jemand gesendet hat). Der Nutzer las
# eine falsche Diagnose, und der Klient stellte das selbsttaetige
# Wiederverbinden dauerhaft ein.
#
# Die beiden Faelle haben jetzt eigene Codes in einem bis dahin voellig freien
# Block (407x). **4003 wurde bewusst NICHT umgedeutet**: waehrend eines
# Ausrollens treffen alte und neue Seite aufeinander, und ein Code, der seine
# Bedeutung wechselt, ist in genau diesem Fenster nicht unterscheidbar von
# seiner alten Lesart. Ein neuer Code faellt bei einem alten Klienten dagegen
# in dessen ``default``-Zweig — „Verbindung weg, spaeter erneut versuchen",
# also das harmlose Verhalten.
#
# Die Gegenstuecke stehen in ``web/src/lib/api/constants.ts`` (``WS_CLOSE``)
# und muessen synchron bleiben. Belegte Schliesscodes des Gateways:
# 4001 (Token), 4009 (zu viele Verbindungen), 4046 (JWKS kalt),
# 4070/4071 (hier). Fehler-FRAMES sind ein anderer Kanal und duerfen sich mit
# Schliesscodes ueberschneiden (4001–4017, 4040–4044, 4050–4061, 4290) — sie
# laufen nie durch ``_mapCloseCode``.
WS_CLOSE_INSTANCE_SUSPENDED = 4070
WS_CLOSE_EMAIL_UNVERIFIED = 4071


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    # Accept first so the reject paths below can send real WebSocket close
    # frames with their numeric codes (4001/4009/4046/4070/4071). Starlette
    # translates a close()-before-accept() into an HTTP 403, which drops the
    # close code and leaves the client unable to tell the reject reasons apart.
    await websocket.accept()

    # Ist DIESE Instanz gesperrt oder geloescht, endet hier auch jede BESTEHENDE
    # Verbindung. Der Cert-Login blockt schon neue Sitzungen, aber ein bereits
    # offener Socket lebt sonst weiter, bis der Client von sich aus neu
    # verbindet. Zustand aus Redis, gefuellt vom Sperr-Poller; ohne Redis gilt
    # "nicht gesperrt" (fail-open, s. suspend_poller.py).
    if await read_suspend_state(getattr(websocket.app.state, "redis", None)):
        # Eigener Code: die Sperre ist umkehrbar, der Klient soll also weiter
        # (langsam) neu waehlen und die Aufhebung von selbst finden.
        await websocket.close(
            code=WS_CLOSE_INSTANCE_SUSPENDED, reason="instance suspended"
        )
        return

    try:
        payload = await decode_token(token)
        user_id = int(payload["sub"])
        settings = get_settings()
        # Die Kennung steht im Token. Auf einem Self-Host setzt sie
        # ``_decode_self_host_session_token`` aus dem Sitzungs-Token
        # (``pairwise_sub``), in der Cloud ist es die Nutzer-ID selbst.
        #
        # Hier stand bis zum 2026-08-28 ein Nachbau der Cert-Rechnung
        # (``CertClaims`` + ``resolve_user_identifier``) mit genau diesem
        # Rueckfall darunter. Mit dem Gerätezertifikat ist der Vorderweg
        # entfallen — was blieb, war ohnehin der Rueckfall.
        identifier = (
            str(payload.get("pairwise_sub") or user_id)
            if settings.pulse_instance_mode == "self-host"
            else str(user_id)
        )
        is_self_host = settings.pulse_instance_mode == "self-host"
        # Admin kommt AUSSCHLIESSLICH aus dem ``admin``-Claim, den cert_login
        # beim Ausstellen des Session-Tokens setzt (Vergleich Cert-User gegen
        # PULSE_INSTANCE_OWNER_ID). Hier gab es dieselbe Rechnung ein zweites
        # Mal — sie konnte aber nie zutreffen: auf einem Self-Host ist
        # ``payload["sub"]`` die SYNTHETISCHE ID
        # (``synthesize_self_host_user_id`` ueber den pairwise-Identifier,
        # s. security._decode_self_host_session_token), nicht die rohe
        # Cloud-User-ID, gegen die verglichen wurde. Die rohe ID steht an
        # dieser Stelle gar nicht mehr zur Verfuegung, der Zweig war also tot
        # und sein Kommentar irrefuehrend (entfernt 2026-07-27).
        #
        # Praktische Folge, die man kennen muss: faellt der ``admin``-Claim
        # aus, gibt es hier KEIN Auffangnetz — die Ursache ist dann immer im
        # Cert-Login zu suchen, nicht hier.
        is_admin = bool(payload.get("admin", False))
        is_owner = not is_self_host and bool(payload.get("owner", False))
        user = AuthenticatedUser(
            id=user_id,
            username=payload.get("username", ""),
            is_admin=is_admin,
            is_owner=is_owner,
            payload=payload,
            user_identifier=identifier,
            is_self_host=is_self_host,
        )
    except (HTTPException, KeyError, ValueError):
        await websocket.close(code=4001, reason="unauthorized")
        return

    # Email-verification gate: a token carrying ``email_blocked`` belongs to
    # an unverified account on an SMTP-configured deployment. Eigener Code
    # (4071), damit der Klient auf den „E-Mail bestaetigen"-Schirm leiten kann
    # statt es fuer einen gewoehnlichen Auth-Fehler zu halten. Hier hilft kein
    # Wiederholen: es braucht eine Handlung des Nutzers.
    if payload.get("email_blocked"):
        await websocket.close(
            code=WS_CLOSE_EMAIL_UNVERIFIED, reason="email not verified"
        )
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
    # ``capabilities`` sagt dem Klienten, welche Wege dieser Server kennt —
    # ``token_refresh`` erneuert das Token am offenen Socket, statt ihn beim
    # Ablauf zu schliessen (s. ``ws_token_renewal.py``). Ein neuer Klient an
    # einem alten Server sieht den Eintrag nicht und faellt wortlos auf den
    # Reconnect-Weg zurueck; ein alter Klient ignoriert ihn ohnehin.
    await websocket.send_json({
        "op": "hello",
        "server_version": __version__,
        # ``server-ticket``: dieser Server kann ``POST /session``. Es gibt
        # keinen zweiten Anmeldeweg mehr — die Angabe dient der Diagnose
        # (``selfhost_probe_anmeldeweg``) und kuenftigen Klienten, nicht einer
        # Wahl zur Laufzeit. Quelle: ``faehigkeiten.py``.
        "capabilities": list(SERVER_FAEHIGKEITEN),
    })

    app = websocket.app
    manager = app.state.connection_manager
    # Resolve the real client IP (XFF behind Caddy) for the per-IP connection
    # cap — without this every prod connection shares Caddy's address and the
    # cap would block legitimate users collectively.
    accepted, is_first_socket = await manager.register(
        websocket, user, client_ip=ws_client_ip(websocket)
    )
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
