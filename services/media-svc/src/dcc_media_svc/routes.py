"""HTTP routes for media-svc.

Endpoints:
  * ``POST /channels/{channel_id}/stream-token`` — issue a short-lived publish
    token (called by chat-gateway after it has checked the user's channel
    membership; the Pulse access token it forwards is verified here and the
    `sub` becomes the token's user_id). The push URL targets a fresh path
    ``channel-<cid>-<uid>-<nonce>`` (nonce = 8 hex per issue, see ``streamkeys``).
  * ``GET /channels/{channel_id}/stream`` — current set of HQ streamers in the
    channel (``{channel_id, user_ids: [...], since?}``).
  * ``GET /channels/{channel_id}/whep?user_id=<uid>`` — the WHEP playback URL
    for that user's *current* stream (reads ``stream:active:*`` to find the
    live path with its nonce). 404 if the user isn't streaming.
"""

from __future__ import annotations

import json
import secrets
import time
from time import monotonic
from typing import Annotated

import structlog
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from dcc_media_svc.config import get_settings
from dcc_media_svc.security import CurrentUser
from dcc_media_svc.streamkeys import (
    ACTIVE_KEY,
    CHANNEL_STATE_KEY,
    TOKEN_KEY,
    path_for_channel_user,
)

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# In-process per-user rate limiter for stream-token issuance.
# Prevents a single user from flooding Redis with token keys.
# Per-process only — for multi-worker deployments this should move to Redis.
# Uses bucketing by 60-second windows to avoid O(N) full-dict scans.
# {user_id: (window_start_monotonic, count)}
# ---------------------------------------------------------------------------
_TOKEN_RATE_LIMIT = 10   # max tokens per user per window
_TOKEN_RATE_WINDOW = 60.0  # seconds
# Two buckets: current and previous window. Old entries are discarded.
_token_rate_buckets_current: dict[int, int] = {}
_token_rate_buckets_previous: dict[int, int] = {}
_token_rate_window_boundary = 0.0


def _check_token_rate(user_id: int) -> bool:
    """Return True if the call is allowed, False if over budget.

    Uses a two-bucket windowing scheme: current and previous windows.
    On window boundary, the current bucket becomes previous and a new
    current bucket is created. No full-dict scanning needed.
    """
    global _token_rate_window_boundary, _token_rate_buckets_current, _token_rate_buckets_previous
    now = monotonic()
    current_window = int(now / _TOKEN_RATE_WINDOW)
    window_boundary = current_window * _TOKEN_RATE_WINDOW

    # If we've moved to a new window, rotate the buckets.
    if window_boundary != _token_rate_window_boundary:
        _token_rate_window_boundary = window_boundary
        _token_rate_buckets_previous = _token_rate_buckets_current
        _token_rate_buckets_current = {}

    # Count tokens in current window only. Entries in the previous window
    # are from the *previous* 60-second slot and are stale for a new request.
    count = _token_rate_buckets_current.get(user_id, 0)
    if count >= _TOKEN_RATE_LIMIT:
        return False
    _token_rate_buckets_current[user_id] = count + 1
    return True

router = APIRouter()

ChannelId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]
UserIdQuery = Annotated[str, Query(min_length=1, max_length=64, pattern=r"^\d+$")]


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # SRT is disabled: UDP has no TLS layer so the stream token would be
    # visible in cleartext in the SRT streamid field.  Use rtmps (the default).
    protocol: Annotated[str, Field(default="rtmp", pattern=r"^rtmp$")] = "rtmp"


class StreamTokenOut(BaseModel):
    token: str
    mediamtx_path: str
    push_protocol: str
    push_url: str
    expires_in_s: int


class StreamStateOut(BaseModel):
    channel_id: str
    user_ids: list[str] = []
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
    path = path_for_channel_user(channel_id, user_id, nonce)
    record = {
        "channel_id": channel_id,
        "user_id": user_id,
        "nonce": nonce,
        "scope": "publish",
        "protocol": payload.protocol,
        "created_at": int(time.time()),
    }
    await redis.set(
        TOKEN_KEY.format(token=token),
        json.dumps(record, separators=(",", ":")),
        ex=settings.token_ttl_s,
    )
    log.info("stream_token_issued", channel_id=channel_id, user_id=user.id, protocol=payload.protocol)
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
    return StreamStateOut(channel_id=channel_id, user_ids=uids, since=data.get("since"))


@router.get("/channels/{channel_id}/whep", response_model=WhepOut)
async def get_whep_url(channel_id: ChannelId, user_id: UserIdQuery, request: Request) -> WhepOut:
    """WHEP URL for ``user_id``'s live stream in ``channel_id``.

    The MediaMTX path now carries a per-publish nonce, so we can't compute it
    from (cid, uid) alone — we read ``stream:active:channel-<cid>-<uid>`` which
    the auth-hook updates on every successful publish-auth. 404 if there's no
    live publisher for that user; the WhepPlayer treats that the same as a
    publisher-not-up situation and keeps retrying.
    """
    redis = _get_redis(request)
    raw = await redis.get(ACTIVE_KEY.format(channel_id=channel_id, user_id=user_id))
    if raw is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    path = data.get("path") if isinstance(data, dict) else None
    if not isinstance(path, str) or not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no active stream for this user")
    base = get_settings().mediamtx_public_base.rstrip("/")
    return WhepOut(whep_url=f"{base}/{path}/whep")
