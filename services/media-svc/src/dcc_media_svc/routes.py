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

from dcc_media_svc.config import get_settings
from dcc_media_svc.security import CurrentUser
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

# Highest per-user stream slot. N=2 (slots 0 and 1) — one user may run two HQ
# streams at once (e.g. two monitors). Bump to widen; the path/key schema and
# auth-hook already generalise to any slot, only this clamp limits it.
_SLOT_MAX = 1

ChannelId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]
UserIdQuery = Annotated[str, Query(min_length=1, max_length=64, pattern=r"^\d+$")]
SlotQuery = Annotated[int, Query(ge=0, le=_SLOT_MAX)]


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # SRT is disabled: UDP has no TLS layer so the stream token would be
    # visible in cleartext in the SRT streamid field.  Use rtmps (the default).
    protocol: Annotated[str, Field(default="rtmp", pattern=r"^rtmp$")] = "rtmp"
    # Which of the caller's stream slots this token publishes. 0 == the default
    # single stream (legacy path/key shape); 1 == a second concurrent stream.
    slot: Annotated[int, Field(default=0, ge=0, le=_SLOT_MAX)] = 0


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
    SRT:  ``srt://host:port?streamid=publish:<path>:pulse:<token>``.
    """
    s = get_settings()
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
        "protocol": payload.protocol,
        "created_at": int(time.time()),
    }
    # Slot 0 omits the field so the token record stays byte-identical to the
    # legacy single-stream shape (the auth-hook reads a missing slot as 0).
    if slot:
        record["slot"] = slot
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
        protocol=payload.protocol,
    )
    return StreamTokenOut(
        token=token,
        mediamtx_path=path,
        push_protocol=payload.protocol,
        push_url=_push_url(path, payload.protocol, token),
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
    cache_key = f"stream:read-cache:{viewer_id}:{channel_id}:{user_id}:{slot}"
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
    return WhepOut(whep_url=f"{base}/{path}/whep?token={read_token}")


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

    for s in targets:
        await redis.set(
            stopping_key(channel_id, uid, s), "1", ex=settings.stop_suppression_s
        )
        await redis.delete(active_key(channel_id, uid, s))

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
