"""HTTP routes for media-svc.

Endpoints:
  * ``POST /channels/{channel_id}/stream-token`` — issue a short-lived publish
    token (called by chat-gateway after it has checked the user's channel
    membership; the Pulse access token it forwards is verified here and the
    `sub` becomes the token's user_id). The push URL targets a fresh path
    ``channel-<cid>-<uid>-<nonce>`` (nonce = 32 hex per issue, see ``streamkeys``).
  * ``GET /channels/{channel_id}/stream`` — current set of HQ streamers in the
    channel (``{channel_id, user_ids: [...], since?}``).
  * ``GET /channels/{channel_id}/whep?user_id=<uid>`` — the WHEP playback URL
    for that user's *current* stream (reads ``stream:active:*`` to find the
    live path with its nonce). 404 if the user isn't streaming.

All routes require a valid bearer (Cloud RS256 or Self-Host session token) —
chat-gateway forwards the caller's token after its own membership/permission
checks. The whep route used to be anonymous; a self-host Caddy exposing
``/api/media/*`` then leaked stream URLs to anyone, bypassing VIEW_CHANNEL.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import UTC, datetime
from time import monotonic
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from dcc_shared.events import StreamDescriptor
from dcc_shared.streaming import SLOT_MAX

from dcc_media_svc.config import get_settings
from dcc_media_svc.security import CurrentUser
from dcc_shared.streaming import read_cache_key
from dcc_media_svc.streamkeys import (
    CHANNEL_STATE_KEY,
    STREAM_EVENTS_CHANNEL,
    TOKEN_KEY,
    active_key,
    path_for_channel_user,
    stopping_key,
    streams_from_state,
)


async def _publish_stream_event(
    redis: Redis,
    channel_id: str,
    user_ids: list[str],
    streams: list[dict[str, Any]] | None = None,
) -> None:
    """Publish the channel's *full* current streamer set on ``stream:events``
    (same shape the poller emits) so chat-gateway re-broadcasts it at once.

    ``streams`` (the additive ``[{user_id, slot}]`` list) is only put on the
    wire when non-empty, so single-stream channels keep the legacy
    ``{channel_id, user_ids}`` shape byte-for-byte."""
    from dcc_shared.events import StreamStateSnapshot

    snap = StreamStateSnapshot(channel_id=channel_id, user_ids=user_ids, streams=streams or [])
    # `label` omission when unset is handled by the StreamDescriptor
    # `@model_serializer` — see poller.py for the same comment.
    data = snap.model_dump(mode="json")
    if not snap.streams:
        data.pop("streams", None)
    await redis.publish(STREAM_EVENTS_CHANNEL, json.dumps(data, separators=(",", ":")))


log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# In-process per-user rate limiter for stream-token issuance.
# Prevents a single user from flooding Redis with token keys.
# Per-process only — for multi-worker deployments this should move to Redis.
# Uses a sliding-window-counter (two fixed buckets: current + previous) to
# avoid O(N) full-dict scans while still approximating a true sliding window.
# ---------------------------------------------------------------------------
_TOKEN_RATE_LIMIT = 10   # max tokens per user per window
_TOKEN_RATE_WINDOW = 60.0  # seconds
# Two buckets: current and previous window. Old entries are discarded.
_token_rate_buckets_current: dict[int, int] = {}
_token_rate_buckets_previous: dict[int, int] = {}
_token_rate_window_boundary = 0.0


def _check_token_rate(user_id: int) -> bool:
    """Return True if the call is allowed, False if over budget.

    Sliding-window-counter: the request's effective count is the current
    window's tally plus the previous window's tally weighted by the fraction
    of the previous window that still overlaps the trailing 60 s
    (``current + previous * (1 - elapsed/window)``). As the current window
    fills, the previous window's contribution decays linearly to zero. This
    closes the fixed-window boundary doubling (where a user could spend the
    full budget at the end of one window and again at the start of the next).
    """
    global _token_rate_window_boundary, _token_rate_buckets_current, _token_rate_buckets_previous
    now = monotonic()
    current_window = int(now / _TOKEN_RATE_WINDOW)
    window_boundary = current_window * _TOKEN_RATE_WINDOW

    # If we've moved to a new window, rotate the buckets.
    if window_boundary != _token_rate_window_boundary:
        # A multi-window jump (idle user) leaves the old "previous" bucket
        # fully stale → drop it rather than carry forward an ancient tally.
        if window_boundary - _token_rate_window_boundary > _TOKEN_RATE_WINDOW:
            _token_rate_buckets_previous = {}
        else:
            _token_rate_buckets_previous = _token_rate_buckets_current
        _token_rate_window_boundary = window_boundary
        _token_rate_buckets_current = {}

    elapsed = now - window_boundary
    prev_weight = 1.0 - (elapsed / _TOKEN_RATE_WINDOW)
    current = _token_rate_buckets_current.get(user_id, 0)
    previous = _token_rate_buckets_previous.get(user_id, 0)
    weighted = current + previous * prev_weight
    if weighted >= _TOKEN_RATE_LIMIT:
        return False
    _token_rate_buckets_current[user_id] = current + 1
    return True

router = APIRouter()

# Highest per-user stream slot. Slots 0.._SLOT_MAX — one user may run that many
# HQ streams at once (e.g. one per monitor). The path/key schema, auth-hook and
# poller already generalise to any slot; only this clamp limits it. Shared with
# chat-gateway via ``dcc_shared.streaming``, which carries the reasoning.
_SLOT_MAX = SLOT_MAX

ChannelId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]
UserIdQuery = Annotated[str, Query(min_length=1, max_length=64, pattern=r"^\d+$")]
SlotQuery = Annotated[int, Query(ge=0, le=_SLOT_MAX)]


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The client's protocol WISH. Until 2026-08-02 this was pattern-locked to
    # "rtmp" and ignored; it is now honoured, but only UPWARDS (see the
    # resolution in ``issue_stream_token``). Kept next to the old comment about
    # instances mint WHIP URLs). SRT stays disabled: UDP has no TLS layer so the
    # stream token would be visible in cleartext in the SRT streamid field.
    protocol: Annotated[str, Field(default="rtmp", pattern=r"^(rtmp|whip)$")] = "rtmp"
    # Which of the caller's stream slots this token publishes. 0 == the default
    # single stream (legacy path/key shape); 1 == a second concurrent stream.
    slot: Annotated[int, Field(default=0, ge=0, le=_SLOT_MAX)] = 0
    # Optional human-readable label (e.g. ``"Monitor 1"``, ``"Chrome"``) the
    # streamer's client resolves from the chosen capture source. Surfaces in the
    # viewer's stream picker so someone running several streams can tell them
    # apart. Stripped + bounded here; empty/``None`` → omitted from the token
    # record so the legacy single-stream shape stays byte-identical.
    label: Annotated[str | None, Field(default=None, max_length=80)] = None
    # Sendet der Streamer mit 10 bit Farbtiefe? Fährt denselben Weg wie
    # ``label`` (Token-Record → auth-hook → ``stream:active``) und wird dem
    # Zuschauer in der WHEP-Antwort gemeldet: nur der native Player kann mehr
    # als 8 bit darstellen, und ohne diesen Hinweis wüsste der Zuschauer die
    # Tiefe erst NACH dem Dekodieren — also erst, nachdem er sich für einen
    # Wiedergabeweg entschieden hat. Fehlt das Feld (ältere Clients), gilt
    # 8 bit.
    ten_bit: bool = False
    # **Kann der Sidecar dieses Streamers Eingaben einspielen?** Reist genau wie
    # ``ten_bit`` mit bis zum Zuschauer — dort entscheidet sich, ob der Knopf
    # „Fernsteuerung anfragen" ueberhaupt erscheint. Der Wert kommt aus der
    # Fähigkeitsmeldung des Sidecars (``health.gsr.remote_input``), nicht aus
    # dem Betriebssystem des Streamers: massgeblich ist, was das Programm kann,
    # das die Frames am Ende einspielen muesste. Fehlt das Feld (Linux-Sidecar,
    # aeltere Clients), gilt ``False`` — fail-closed.
    remote_input: bool = False


class StreamTokenOut(BaseModel):
    token: str
    mediamtx_path: str
    push_protocol: str
    push_url: str
    expires_in_s: int


class StreamStateOut(BaseModel):
    channel_id: str
    user_ids: list[str] = []
    # Additive per-slot descriptors. Only populated once a user runs slot ≥ 1;
    # single-stream channels leave it empty and clients fall back to user_ids.
    streams: list[StreamDescriptor] = []
    since: str | None = None


class WhepOut(BaseModel):
    whep_url: str
    # Sendet dieser Stream mit 10 bit? Aus dem ``stream:active``-Record. Der
    # Zuschauer entscheidet daran, ob er den nativen Player nimmt (nur der
    # kann mehr als 8 bit ausgeben) oder das ``<video>``-Element.
    ten_bit: bool = False
    # Siehe ``StreamTokenIn.remote_input``. Aus dem ``stream:active``-Record.
    remote_input: bool = False


def _get_redis(request: Request) -> Redis:
    redis: Redis | None = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable")
    return redis


def _push_url(path: str, protocol: str, token: str) -> str:
    """Full push URL incl. the stream-token, ready for the GSR sidecar.

    RTMP: ``rtmps://host:port/<path>?user=pulse&pass=<token>`` —
          over TLS so the token isn't on the wire in cleartext; MediaMTX maps
          the query ``user``/``pass`` onto the authHTTP body.
    WHIP: ``{mediamtx_public_base}/<path>/whip?token=<token>`` — WebRTC ingest,
          mirrors the WHEP playback URL shape; the auth-hook reads the token
          from the query exactly like it does for WHEP reads.
    SRT:  ``srt://host:port?streamid=publish:<path>:pulse:<token>``.
    """
    s = get_settings()
    if protocol == "whip":
        return f"{s.mediamtx_public_base}/{path}/whip?token={token}"
    if protocol == "srt":
        return (
            f"srt://{s.mediamtx_ingest_host}:{s.mediamtx_srt_port}"
            f"?streamid=publish:{path}:pulse:{token}"
        )
    return (
        f"rtmps://{s.mediamtx_ingest_host}:{s.mediamtx_rtmps_port}"
        f"/{path}?user=pulse&pass={token}"
    )


@router.post("/channels/{channel_id}/stream-token", response_model=StreamTokenOut)
async def issue_stream_token(
    channel_id: ChannelId,
    payload: StreamTokenIn,
    user: CurrentUser,
    request: Request,
) -> StreamTokenOut:
    if not _check_token_rate(user.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="stream token rate limit exceeded")
    settings = get_settings()
    redis = _get_redis(request)
    user_id = str(user.id)
    # Push-Weg: der Server erzwingt, der Client darf zusaetzlich wuenschen —
    # aber nur NACH OBEN, also Richtung WHIP.
    #
    # Der Zwang bleibt, wozu er da ist: app-gehostete Instanzen setzen
    # MEDIAMTX_PUSH_PROTOCOL=whip, damit Gaeste ueber die NAT-durchstossende
    # WebRTC-Schicht publishen statt ueber TCP 1936, den sie hinter dem NAT des
    # Hosts gar nicht erreichen. Der Instanz-OWNER streamt auf die eigene
    # Maschine und behaelt den bewaehrten RTMPS-Weg.
    #
    # Der Wunsch kam 2026-08-02 dazu, fuer Intra-Refresh: dieser Betriebsart
    # fehlt ueber RTMPS der RTCP-Rueckkanal, und ohne ihn bekommt ein
    # beitretender Zuschauer nie sein erstes Vollbild — er saehe gar nichts.
    # Die Betriebsart entscheidet den Transport also mit.
    #
    # **Seit dem 2026-08-07 auch der CODEC**, und darauf ist beim Lesen der
    # Zahlen zu achten: der Client wuenscht WHIP jetzt bei JEDEM H.264-Stream,
    # auch bei abgewaehltem Intra-Refresh (`web/.../settings.svelte.ts::
    # pushProtokoll`). Grund ist `h264_amf`, das die Auffrischung wegen
    # `usage=ultralowlatency` ungefragt mitfaehrt — der Strom hat dann kaum
    # Vollbilder, obwohl niemand welche abbestellt hat. In der Produktion am
    # 2026-08-07 belegt: 0 dekodierte Bilder ueber RTMPS gegen 2681 ueber WHIP,
    # derselbe Kanal, dieselben Minuten. Der RTMPS-Anteil faellt dadurch stark;
    # das ist die Ursache, kein Messfehler.
    #
    # Warum der Wunsch die Owner-Ausnahme schlaegt: die Ausnahme ist eine
    # Bequemlichkeit (der bewaehrte Weg, wo er ohnehin funktioniert), keine
    # Sicherheitsgrenze. Bliebe sie staerker, koennte ausgerechnet der Betreiber
    # einer Instanz Intra-Refresh auf ihr nie benutzen.
    #
    # Und warum nur nach oben: ein Client, der RTMPS wuenscht, wo der Server
    # WHIP erzwingt, wuerde sich damit den Weg abschneiden, der auf dieser
    # Instanz ueberhaupt funktioniert.
    wunsch_whip = payload.protocol == "whip"
    protocol = settings.mediamtx_push_protocol
    if user_id == settings.pulse_instance_owner_id and not wunsch_whip:
        protocol = "rtmp"
    if wunsch_whip:
        protocol = "whip"
    token = secrets.token_urlsafe(32)
    # Fresh nonce per token → fresh MediaMTX path per publish (see
    # ``streamkeys.py`` for why). 32 hex = 128 bits = offline path-guessing
    # infeasible even for a well-resourced attacker.
    nonce = secrets.token_hex(16)
    slot = payload.slot
    path = path_for_channel_user(channel_id, user_id, nonce, slot=slot)
    record = {
        "channel_id": channel_id,
        "user_id": user_id,
        "nonce": nonce,
        "scope": "publish",
        "protocol": protocol,
        "created_at": int(time.time()),
    }
    # Slot 0 omits the field so the token record stays byte-identical to the
    # legacy single-stream shape (the auth-hook reads a missing slot as 0).
    if slot:
        record["slot"] = slot
    # Label rides the token record → the auth-hook copies it into
    # ``stream:active`` on publish-auth → the poller surfaces it in
    # ``stream:channel``/``stream:events``. Omitted when empty (legacy shape).
    label = (payload.label or "").strip()
    if label:
        record["label"] = label
    # Wie ``label``: nur bei True mitschreiben, damit der Record im Normalfall
    # byte-identisch zur alten Form bleibt.
    if payload.ten_bit:
        record["ten_bit"] = True
    if payload.remote_input:
        record["remote_input"] = True
    await redis.set(
        TOKEN_KEY.format(token=token),
        json.dumps(record, separators=(",", ":")),
        ex=settings.token_ttl_s,
    )
    # A new publish intent cancels any pending explicit-stop suppression for this
    # (channel, user, slot) — otherwise a quick stop→restart would stay invisible
    # until the tombstone's TTL lapsed (the poller would keep skipping the slot).
    await redis.delete(stopping_key(channel_id, user_id, slot))
    log.info(
        "stream_token_issued",
        channel_id=channel_id,
        user_id=user.id,
        slot=slot,
        protocol=protocol,
    )
    return StreamTokenOut(
        token=token,
        mediamtx_path=path,
        push_protocol=protocol,
        push_url=_push_url(path, protocol, token),
        expires_in_s=settings.token_ttl_s,
    )


@router.get("/channels/{channel_id}/stream", response_model=StreamStateOut)
async def get_stream_state(
    channel_id: ChannelId,
    user: CurrentUser,
    request: Request,
) -> StreamStateOut:
    redis = _get_redis(request)
    raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=channel_id))
    if raw is None:
        return StreamStateOut(channel_id=channel_id)
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return StreamStateOut(channel_id=channel_id)
    if not isinstance(data, dict):
        return StreamStateOut(channel_id=channel_id)
    uids = [str(u) for u in (data.get("user_ids") or []) if u]
    streams = [StreamDescriptor(**d) for d in streams_from_state(data)]
    return StreamStateOut(
        channel_id=channel_id, user_ids=uids, streams=streams, since=data.get("since")
    )


@router.get("/channels/{channel_id}/whep", response_model=WhepOut)
async def get_whep_url(
    channel_id: ChannelId,
    user_id: UserIdQuery,
    user: CurrentUser,
    request: Request,
    slot: SlotQuery = 0,
) -> WhepOut:
    """WHEP URL for ``user_id``'s live stream in ``channel_id``.

    The MediaMTX path now carries a per-publish nonce, so we can't compute it
    from (cid, uid) alone — we read ``stream:active:channel-<cid>-<uid>`` which
    the auth-hook updates on every successful publish-auth. 404 if there's no
    live publisher for that user; the WhepPlayer treats that the same as a
    publisher-not-up situation and keeps retrying.

    ``user`` (the verified bearer) is required even though the VIEW_CHANNEL
    check lives in chat-gateway: without it, a deployment that exposes
    media-svc directly (the self-host Caddy used to) hands the nonce'd WHEP
    URL to unauthenticated callers.
    """
    redis = _get_redis(request)
    raw = await redis.get(active_key(channel_id, user_id, slot))
    if raw is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    path = data.get("path") if isinstance(data, dict) else None
    if not isinstance(path, str) or not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    s = get_settings()

    # Deterministic read-token per (viewer, channel, publisher): reuse an
    # existing valid token instead of minting a fresh key on every WHEP request.
    # A viewer in a reconnect loop would otherwise accumulate O(reconnects) live
    # Redis keys (each 1 h TTL) with no benefit — the token carries the same
    # scope regardless.  We cache the token string itself under a lookup key
    # keyed to the triplet; the cache entry carries the same TTL as the token so
    # the two expire together.  On cache miss we mint once and write both keys in
    # a single pipeline.
    #
    # Security: read tokens are not single-use secrets — the auth-hook accepts
    # them for the lifetime of the TTL and does not consume them (WHEP does an
    # OPTIONS preflight + POST + periodic reconnects, all requiring the same
    # token).  Reusing an existing token is therefore functionally identical to
    # minting a new one; both are channel+publisher-bound (not viewer-bound) by
    # design, so sharing them across reconnects from the same viewer is safe.
    viewer_id = str(user.id)
    # Form in `dcc_shared.streaming` — chat-gateway loescht diese Schluessel
    # beim Bann, und zwei Fassungen davon waeren eine stille Fehlerquelle.
    cache_key = read_cache_key(viewer_id, channel_id, user_id, slot)
    cached = await redis.get(cache_key)
    if cached is not None:
        read_token = cached.decode() if isinstance(cached, bytes) else cached
    else:
        # Mint a candidate token and race to claim the cache slot atomarisch via
        # SET NX.  Only the winner writes the stream:token key — losers read the
        # winner's token from the cache and return it, so no orphaned token keys
        # accumulate from concurrent WHEP requests by the same viewer.
        candidate = secrets.token_urlsafe(32)
        read_record = {
            "channel_id": channel_id,
            "user_id": user_id,
            "scope": "read",
            "protocol": "webrtc",
            "created_at": int(time.time()),
        }
        won = await redis.set(cache_key, candidate, ex=s.read_token_ttl_s, nx=True)
        if won:
            # This request is the winner — register the token so the auth-hook
            # can validate it.  The candidate is already in the cache; no other
            # concurrent request will mint a second stream:token key.
            await redis.set(
                TOKEN_KEY.format(token=candidate),
                json.dumps(read_record, separators=(",", ":")),
                ex=s.read_token_ttl_s,
            )
            read_token = candidate
        else:
            # Another concurrent request beat us to the cache slot.  Read the
            # winner's token — our candidate is discarded without ever being
            # written to stream:token:*, leaving no orphaned key.
            winner = await redis.get(cache_key)
            read_token = (winner.decode() if isinstance(winner, bytes) else winner) or candidate
    base = s.mediamtx_public_base.rstrip("/")
    return WhepOut(
        whep_url=f"{base}/{path}/whep?token={read_token}",
        ten_bit=data.get("ten_bit") is True,
        remote_input=data.get("remote_input") is True,
    )


@router.delete("/channels/{channel_id}/stream", status_code=status.HTTP_204_NO_CONTENT)
async def stop_stream(
    channel_id: ChannelId,
    user: CurrentUser,
    request: Request,
    slot: Annotated[int | None, Query(ge=0, le=_SLOT_MAX)] = None,
) -> Response:
    """Explicit stop of the *caller's own* HQ stream(s) in ``channel_id``.

    ``slot`` omitted → stop *all* of the caller's slots (the normal "stop
    streaming" click); ``slot=N`` → stop only that one stream, leaving the
    caller's other slot live.

    The media plane (WebRTC) stalls the instant the GSR sidecar stops pushing,
    but presence is otherwise derived by polling MediaMTX every few seconds —
    and MediaMTX keeps the path "ready" until its own publisher-disconnect
    detection fires (~readTimeout). So without this, the "live" badge lingers
    ~10-16s after the user clicked stop. This clears it immediately:

      1. set a short ``stream:stopping`` tombstone so the poller won't re-add the
         user from a MediaMTX path that hasn't dropped yet (see poller),
      2. drop the user's ``stream:active`` record,
      3. recompute the channel's streamer set without them and publish the
         updated ``stream:events`` now.

    The user is identified by the verified bearer, so a caller can only stop
    their own stream. The poller stays the backstop for crash/network-drop
    (no clean stop) cases."""
    settings = get_settings()
    redis = _get_redis(request)
    uid = str(user.id)
    targets = [slot] if slot is not None else list(range(_SLOT_MAX + 1))

    # Gepipelined statt einzeln: schon vier Slots waren acht sequentielle
    # Round-Trips für einen einzigen Stop-Klick. Dasselbe Muster begründet der
    # Poller für sich schon ("reduces O(N) sequential round-trips to O(1)").
    #
    # Ohne ``slot`` geht das über ALLE Slots bis ``_SLOT_MAX``, nicht nur über
    # die laufenden — welche Pfade MediaMTX noch führt, weiß hier niemand, und
    # genau dagegen ist der Grabstein gedacht. Bei einer Obergrenze von 99 sind
    # das rund hundert Schreibvorgänge je Stop-Klick, die meisten für Slots, die
    # nie existiert haben; sie verfallen nach ``stop_suppression_s`` von selbst.
    # In Kauf genommen, weil der Klick selten ist und alles in EINEM Round-Trip
    # geht. Die Löschungen gehen als ein ``DEL k1 k2 …``; das ``SET`` kann das
    # wegen der Ablaufzeit je Schlüssel nicht.
    pipe = redis.pipeline()
    for s in targets:
        pipe.set(stopping_key(channel_id, uid, s), "1", ex=settings.stop_suppression_s)
    pipe.delete(*(active_key(channel_id, uid, s) for s in targets))
    await pipe.execute()

    raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=channel_id))
    remaining_uids: list[str] = []
    remaining_streams: list[dict[str, Any]] = []
    since: str | None = None
    if raw is not None:
        try:
            data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except (ValueError, TypeError, AttributeError):
            data = None
        if isinstance(data, dict):
            since = data.get("since")
            old_streams = streams_from_state(data)
            if old_streams:
                # Slot-aware state: drop the targeted (uid, slot) descriptors and
                # recompute the user set from what survives.
                remaining_streams = [
                    d
                    for d in old_streams
                    if not (d["user_id"] == uid and (slot is None or d["slot"] == slot))
                ]
                remaining_uids = sorted({d["user_id"] for d in remaining_streams})
            else:
                # Legacy single-stream state: no per-slot info, so any stop drops
                # the whole user (matches the pre-slot behaviour).
                remaining_uids = sorted(
                    str(u) for u in (data.get("user_ids") or []) if u and str(u) != uid
                )

    # ``streams`` is only meaningful while some user still runs slot ≥ 1; once
    # everyone is back to a single stream we drop it and the legacy shape returns.
    multi = any(d["slot"] >= 1 for d in remaining_streams)
    publish_streams = remaining_streams if multi else None
    if remaining_uids:
        new_state: dict[str, Any] = {
            "user_ids": remaining_uids,
            "since": since or datetime.now(UTC).isoformat(),
        }
        if multi:
            new_state["streams"] = remaining_streams
        await redis.set(
            CHANNEL_STATE_KEY.format(channel_id=channel_id),
            json.dumps(new_state, separators=(",", ":")),
            ex=settings.channel_state_ttl_s,
        )
    else:
        await redis.delete(CHANNEL_STATE_KEY.format(channel_id=channel_id))

    await _publish_stream_event(redis, channel_id, remaining_uids, streams=publish_streams)
    log.info(
        "stream_stopped",
        channel_id=channel_id,
        user_id=user.id,
        slot=slot,
        remaining=len(remaining_uids),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
