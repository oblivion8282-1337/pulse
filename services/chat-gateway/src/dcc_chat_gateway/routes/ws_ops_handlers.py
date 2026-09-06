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

import json
import logging
import time
from typing import Any

from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions

from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    CHANNEL_TYPE_VOICE,
)
from dcc_chat_gateway.permissions import resolve_permissions
from dcc_chat_gateway.pubsub_channels import HIST_REPLAY_MAX_CHANNELS
from dcc_chat_gateway.presence_status import (
    STATUS_DND,
    STATUS_INVISIBLE,
    STATUS_ONLINE,
    broadcast_presence_status_changed,
    get_presence_status,
    set_presence_status,
    update_activity,
)
from dcc_chat_gateway.routes import (
    watch_handoff,
    ws_device_handlers,
    ws_remote_handlers,
    ws_remote_input,
    ws_remote_reconnect,
    ws_remote_teardown,
    ws_token_renewal,
    ws_typing,
    ws_watch,
    ws_watch_queue,
)
from dcc_chat_gateway.routes._deps import (
    channel_membership,
    parse_snowflake_int as _channel_id,
    resolve_channel_for_user,
)
from dcc_chat_gateway.routes.ws_gruppen_abo import gruppen_abo_versuchen
from dcc_chat_gateway.routes.ws_op_send import handle_send
from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext, register_ws_op

log = logging.getLogger(__name__)

#: Sekunden-Deckel für ``hist_replay`` — dieselbe Begründung wie bei
#: ``resync`` (Redis-Reads + potentiell großer Rahmen; legitimer Takt ist
#: ein Reconnect, nicht ein Strom).
_HIST_REPLAY_THROTTLE_S = 5.0


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
            # Private Gruppe (Etappe G)? Der Resolver kennt sie bewusst nicht
            # — warum, und warum diese eine Stelle trotzdem nachfragt, steht
            # in ``ws_gruppen_abo.py``.
            if await gruppen_abo_versuchen(ctx, session, cid_int):
                return
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


@register_ws_op("hist_replay")
async def handle_hist_replay(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """WS-Lückenfill (Centrifugo-Blaupause): Der Client meldet pro Kanal
    den zuletzt gesehenen Ereignis-Cursor ``(hist, seq)``; der Server
    spielt die seither veröffentlichten Ereignisse als ``replay``-Rahmen
    nach. Reihenfolge am Socket: subscribe → (ready) → hist_replay —
    deshalb ist jeder Kanal hier über den regulären subscribe-Pfad gegen
    Zugriff geprüft. Drei Decken, damit kein Kanal stumm durchs Netz fällt
    und nichts ungeprüft fließt:

    * **Rechte-Neuprüfung** über denselben Filter wie der Live-Fanout
      (``_filter_by_view_channel``): ein unterwegs entzogenes VIEW_CHANNEL,
      ein Kick oder eine Kanal-Löschung würde zwar die Subscription nicht
      zwangsräumen — aber das Replay liest hier nichts mehr, genauso wenig
      wie der Live-Weg noch liefert.
    * Kanäle OHNE gültige Subscription (fehlgeschlagene Re-Subscribes,
      Cursor über den 100er-Slice hinaus) bekommen einen LEEREN
      ``complete:false``-Rahmen — der Client fällt dafür in seinen
      REST-Lückenfill, statt still eine Lücke zu behalten.
    * Throttle wie ``resync``: ein Replay kostet Redis-Reads + einen
      potentiellegroßen Frame, der legitime Takt ist ein Reconnect.
    """
    cursors = msg.get("cursors")
    if not isinstance(cursors, dict) or not cursors:
        return
    now = time.monotonic()
    if now - ctx.last_hist_replay < _HIST_REPLAY_THROTTLE_S:
        return  # backstop: ignore rapid repeats (legit cadence is reconnects)
    ctx.last_hist_replay = now
    items = list(cursors.items())
    for i, (cid_raw, cur) in enumerate(items):
        cid = str(cid_raw)
        if i >= HIST_REPLAY_MAX_CHANNELS:
            await ctx.websocket.send_json(_replay_frame(cid, [], False))
            continue
        if cid not in ctx.subscribed or not isinstance(cur, dict):
            # Nur für Kanäle, für die ein Cursor-Versuch erkennbar ist,
            # gibt's den Fallback-Rahmen — Mist-Typen schweigen (Client-Fehler).
            if isinstance(cur, dict):
                await ctx.websocket.send_json(_replay_frame(cid, [], False))
            continue
        last_id = cur.get("hist")
        last_seq = cur.get("seq")
        if not isinstance(last_id, str) or not last_id:
            await ctx.websocket.send_json(_replay_frame(cid, [], False))
            continue
        if not isinstance(last_seq, int) or isinstance(last_seq, bool):
            await ctx.websocket.send_json(_replay_frame(cid, [], False))
            continue
        # Live-Parität: ohne aktuelles Leserecht kein Replay — auch wenn die
        # (nie zwangsgeräumte) Subscription das Kanal noch kennt.
        if not await ctx.manager._filter_by_view_channel([ctx.websocket], cid):
            continue
        events, complete = await ctx.manager.read_channel_history(
            cid, last_id, last_seq
        )
        await ctx.websocket.send_json(_replay_frame(cid, events, complete))


def _replay_frame(
    cid: str, events: list[dict[str, Any]], complete: bool
) -> dict[str, Any]:
    return {
        "op": "replay",
        "channel_id": cid,
        "complete": complete,
        "events": events,
    }


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
        # state — and the CONNECT bit: without it the user could write
        # themselves into the Redis voice presence of a channel they can't
        # actually join (LiveKit token issue checks CONNECT separately).
        # CONNECT implies VIEW_CHANNEL via the resolver's revoke-all
        # invariant, so hidden channels are covered too. Same error as the
        # membership fail so a hidden channel's existence isn't confirmed.
        async with SessionLocal() as session:
            channel = await channel_membership(session, cid_int, ctx.user.id)
            connect_ok = False
            if channel is not None and channel.type == CHANNEL_TYPE_VOICE:
                perms = await resolve_permissions(
                    session, ctx.user, channel.guild_id, cid_int
                )
                connect_ok = has_permission(perms, Permissions.CONNECT)
        if not connect_ok:
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
    await watch_handoff.handle_handoff(
        ctx.websocket, ctx.user, msg, session_factory=SessionLocal
    )


@register_ws_op("watch_stop")
async def handle_watch_stop(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_stop(
        ctx.websocket, ctx.user, msg,
        hosted_parties=ctx.hosted_parties,
        watched_parties=ctx.watched_parties,
    )


@register_ws_op("watch_control")
async def handle_watch_control(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_control(ctx.websocket, ctx.user, msg)


@register_ws_op("watch_source_change")
async def handle_watch_source_change(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_source_change(
        ctx.websocket, ctx.user, msg, session_factory=SessionLocal
    )


@register_ws_op("watch_heartbeat")
async def handle_watch_heartbeat(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_heartbeat(ctx.websocket, ctx.user, msg)


@register_ws_op("watch_queue_add")
async def handle_watch_queue_add(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch_queue.handle_queue_add(
        ctx.websocket, ctx.user, msg, session_factory=SessionLocal
    )


@register_ws_op("watch_queue_remove")
async def handle_watch_queue_remove(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch_queue.handle_queue_remove(ctx.websocket, ctx.user, msg)


@register_ws_op("watch_queue_move")
async def handle_watch_queue_move(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch_queue.handle_queue_move(ctx.websocket, ctx.user, msg)


@register_ws_op("watch_queue_advance")
async def handle_watch_queue_advance(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch_queue.handle_queue_advance(ctx.websocket, ctx.user, msg)


@register_ws_op("remote_request")
async def handle_remote_request(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # Bekommt den ganzen Kontext: die Mindestpause zwischen zwei Anfragen ist
    # verbindungsgebundener Zustand und lebt auf ``ctx``.
    await ws_remote_handlers.handle_request(ctx, msg, session_factory=SessionLocal)


@register_ws_op("remote_respond")
async def handle_remote_respond(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_remote_handlers.handle_respond(ctx.websocket, ctx.user, msg)


@register_ws_op("remote_signal")
async def handle_remote_signal(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # Wie ``remote_input``: der Sekunden-Deckel haengt am Verbindungskontext.
    await ws_remote_handlers.handle_signal(ctx, msg)


@register_ws_op("remote_input")
async def handle_remote_input(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # Bekommt als einziger ``remote_*``-Op den ganzen Kontext: der Deckel je
    # Sekunde ist verbindungsgebundener Zustand und lebt auf ``ctx``.
    await ws_remote_input.handle_input(ctx, msg)


@register_ws_op("remote_end")
async def handle_remote_end(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_remote_teardown.handle_end(ctx.websocket, ctx.user, msg)


@register_ws_op("remote_reclaim")
async def handle_remote_reclaim(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # Der abgerissene Peer ist zurueck: der Sitzung den neuen Socket geben,
    # solange ihre Gnadenfrist noch laeuft (`remote_reconnect_registry.py`) UND
    # seine Rechte noch stehen (frische DB-Pruefung, wie bei `remote_request`).
    await ws_remote_reconnect.handle_reclaim(
        ctx.websocket, ctx.user, msg, session_factory=SessionLocal
    )


@register_ws_op("device_announce")
async def handle_device_announce(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # „Dieser Rechner ist das Geraet X." Der Server kann das nicht erraten —
    # er sieht Verbindungen von Nutzern, nicht von Rechnern (s.
    # ``ws_device_handlers``).
    await ws_device_handlers.handle_announce(ctx, msg)


@register_ws_op("device_streams")
async def handle_device_streams(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # „Ich sende gerade auf diesen Plaetzen." Der Gateway kann es nicht
    # ableiten: der Strom laeuft unter dem Konto des Besitzers und traegt keine
    # Geraete-Kennung (s. ``ws_device_handlers.handle_streams``).
    await ws_device_handlers.handle_streams(ctx, msg)


@register_ws_op("device_withdraw")
async def handle_device_withdraw(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_device_handlers.handle_withdraw(ctx, msg)


@register_ws_op("device_wake")
async def handle_device_wake(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    # „Fang bitte an zu uebertragen." Getrennt von ``remote_request``, damit
    # eine Sitzungszusage nicht an einer Encoder-Initialisierung haengt
    # (Begruendung in ``ws_device_handlers.handle_wake``).
    await ws_device_handlers.handle_wake(ctx, msg)


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


# A ``resync`` rebuilds the whole ready frame (guilds/roles/overwrites DB reads
# plus parallel Redis/S3 lookups), so it's far heavier than the legit client
# cadence (one per active-server switch). Throttle per connection so a tight
# loop can't exhaust the DB connection pool. Freed on disconnect (lives on ctx).
_RESYNC_THROTTLE_S = 5.0


@register_ws_op("resync")
async def handle_resync(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    """Re-send a fresh ``ready`` snapshot on this socket.

    The client requests this when it switches the active server back to an
    already-open connection: its cached ``ready`` is the snapshot from connect
    time, so live voice/stream/watch changes since then (e.g. the user joining
    a voice channel) are missing from the replay. Rebuilding the frame from
    current Redis/DB state restores the truth. ``broadcast_online=False`` — the
    socket already exists, so this is not a fresh presence transition.
    """
    now = time.monotonic()
    if now - ctx.last_resync < _RESYNC_THROTTLE_S:
        return  # backstop: ignore rapid repeats (the legit cadence is far slower)
    ctx.last_resync = now

    # Lazy import: ws_ready imports from this module's siblings at module load;
    # keep the dependency at call time to avoid an import-time cycle.
    from dcc_chat_gateway.routes.ws_ready import build_and_send_ready_frame

    await build_and_send_ready_frame(
        ctx.websocket, ctx.user, ctx.manager, ctx.redis, broadcast_online=False
    )


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
        if current_status not in (STATUS_ONLINE, STATUS_DND, STATUS_INVISIBLE):
            # Was idle → return to online
            await set_presence_status(ctx.redis, ctx.user.id, STATUS_ONLINE)
            await broadcast_presence_status_changed(
                ctx.manager, ctx.redis, ctx.user.id, STATUS_ONLINE
            )
    except Exception:  # noqa: BLE001
        log.exception("activity op failed for user=%s", ctx.user.id)
    # No reply — lightweight, fire-and-forget.


# ``typing`` op is registered in routes.ws_typing (Groessen-Policy split,
# same pattern as ``send``/watch/device/remote below). Re-register here so
# importing this module wires every built-in op in one shot.
register_ws_op("typing", ws_typing.handle_typing)


# ``send`` op is registered in routes.ws_op_send. Re-register here so
# importing this module wires every built-in op in one shot.
register_ws_op("send", handle_send)


# ``token_refresh`` liegt in routes.ws_token_renewal (eigenes Modul, weil dort
# auch der Wecker wohnt, den der Op verschiebt). Gleiches Muster wie oben.
register_ws_op("token_refresh", ws_token_renewal.handle_token_refresh)


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
        REDIS_CLOUD_JWKS_KEY,
        REDIS_JWKS_KEY,
    )
    from dcc_chat_gateway.user_profile_cache import (
        ProfileStatementInvalid,
        ProfileStatementReplay,
        upsert_profile_statement,
    )

    statement_jwt: str | None = msg.get("jwt") or msg.get("statement")
    if not statement_jwt or not isinstance(statement_jwt, str):
        return  # no-op — client sent frame without JWT

    # Fetch the Cloud JWKS from Redis (fail-open when cache is cold). The
    # statement is Cloud-signed, so on a Self-Host we must verify against the
    # CLOUD JWKS (``auth:cloud_jwks:cached``, warmed by jwks_poller) — NOT the
    # local auth-svc JWKS (``auth:jwks:cached``), whose key differs. On Cloud the
    # two are identical. Mirrors credential_validator._get_jwks_keys (cert-login).
    from dcc_chat_gateway.config import get_settings

    settings = get_settings()
    jwks_key = (
        REDIS_CLOUD_JWKS_KEY
        if settings.pulse_instance_mode == "self-host"
        else REDIS_JWKS_KEY
    )
    try:
        raw_jwks = await ctx.redis.get(jwks_key)
    except Exception:  # noqa: BLE001
        log.warning("profile_statement: redis unavailable, skipping")
        return

    if not raw_jwks:
        log.debug("profile_statement: JWKS cache cold, skipping")
        return

    if isinstance(raw_jwks, bytes):
        raw_jwks = raw_jwks.decode()

    try:
        cloud_jwks = json.loads(raw_jwks)
    except Exception:  # noqa: BLE001
        log.warning("profile_statement: could not parse JWKS JSON")
        return

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
        # A bad/unverifiable profile statement is a NON-critical, optional cache
        # update — log + skip, never disconnect. (Previously raised 4047, which
        # turned any verification failure into a reconnect→re-push→disconnect
        # loop and made the instance unusable, e.g. on a transient JWKS mismatch.)
        log.warning("profile_statement: invalid for user=%s: %s", ctx.user.id, exc)
    except Exception:  # noqa: BLE001
        log.exception("profile_statement: unexpected error for user=%s", ctx.user.id)
