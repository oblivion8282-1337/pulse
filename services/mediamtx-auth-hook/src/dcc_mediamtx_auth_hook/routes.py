"""The single ``authHTTP`` endpoint MediaMTX calls for every connection.

MediaMTX 1.18 POSTs a JSON body for each authentication request:

    {
      "user": "...", "password": "...", "token": "...",
      "ip": "...", "action": "publish|read|playback|api|metrics|pprof",
      "path": "...", "protocol": "rtsp|rtmp|hls|webrtc|srt",
      "id": "...", "query": "..."
    }

A 20x response accepts; anything else denies. (We always return a bare 200 — the
optional ``expireTime`` JSON some builds accept is not needed here, the token TTL
already bounds the session.)

Policy:
  * ``api`` / ``metrics`` / ``pprof``      → 200 (also excluded via authHTTPExclude; allowed defensively).
  * ``publish`` on ``channel-<id>``        → 200 iff ``password`` (or ``token``) names a Redis
                                             ``stream:token:<…>`` record with scope ``publish`` whose
                                             ``channel_id`` matches the path; else 401.
                                             On success we also write ``stream:active:channel-<id>``
                                             → {user_id, started_at} (TTL self-heal) so media-svc's
                                             poller can attribute the stream.
  * ``read`` / ``playback`` on ``channel-<id>`` → 200 (anonymous read, as today).
        # TODO(T5b/later): require a Pulse member-token here and check channel
        # membership via chat-gateway before allowing reads.
  * everything else / non-channel paths    → 401.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel
from redis.asyncio import Redis

from dcc_mediamtx_auth_hook.config import get_settings
from dcc_mediamtx_auth_hook.shared import (
    ACTIVE_KEY,
    TOKEN_KEY,
    parse_channel_user_path,
)

log = structlog.get_logger(__name__)

router = APIRouter()

_EXCLUDED_ACTIONS = frozenset({"api", "metrics", "pprof"})
_READ_ACTIONS = frozenset({"read", "playback"})


class AuthRequest(BaseModel):
    # MediaMTX sends all of these; treat them all as optional so a slightly
    # different build (extra/missing field) never 422s the auth call.
    user: str = ""
    password: str = ""
    token: str = ""
    ip: str = ""
    action: str = ""
    path: str = ""
    protocol: str = ""
    id: str = ""
    query: str = ""

    model_config = {"extra": "ignore"}

    @property
    def credential(self) -> str:
        """The stream-token MediaMTX carried — RTMP/SRT clients put it in
        ``pass`` (→ ``password``); a ``?token=`` query maps to ``token``."""
        return (self.password or self.token or "").strip()


def _get_redis(request: Request) -> Redis:
    redis: Redis | None = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable")
    return redis


def _deny(reason: str, **fields: Any) -> HTTPException:
    log.info("auth_denied", reason=reason, **fields)
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail="denied")


async def _load_token_record(redis: Redis, token: str) -> dict[str, Any] | None:
    if not token:
        return None
    raw = await redis.get(TOKEN_KEY.format(token=token))
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return None
    return data if isinstance(data, dict) else None


async def _mark_publisher_active(redis: Redis, channel_id: str, user_id: str) -> None:
    settings = get_settings()
    payload = json.dumps(
        {"user_id": user_id, "started_at": datetime.now(UTC).isoformat()},
        separators=(",", ":"),
    )
    # SET EX — a re-publish refreshes the TTL (self-heal window stays bounded).
    await redis.set(
        ACTIVE_KEY.format(channel_id=channel_id, user_id=user_id),
        payload,
        ex=settings.publisher_ttl_seconds,
    )


async def _handle(req: AuthRequest, redis: Redis) -> None:
    action = req.action

    if action in _EXCLUDED_ACTIONS:
        return  # 200

    cu = parse_channel_user_path(req.path)  # (channel_id, user_id) or None

    if action == "publish":
        if cu is None:
            raise _deny("publish_non_channel_path", path=req.path)
        channel_id, path_user_id = cu
        rec = await _load_token_record(redis, req.credential)
        if rec is None:
            raise _deny("publish_unknown_token", path=req.path)
        if rec.get("scope") != "publish":
            raise _deny("publish_wrong_scope", path=req.path, scope=rec.get("scope"))
        if str(rec.get("channel_id")) != channel_id:
            raise _deny(
                "publish_channel_mismatch",
                path=req.path,
                token_channel=rec.get("channel_id"),
            )
        if str(rec.get("user_id") or "") != path_user_id:
            raise _deny(
                "publish_user_mismatch",
                path=req.path,
                token_user=rec.get("user_id"),
            )
        await _mark_publisher_active(redis, channel_id, path_user_id)
        log.info("auth_publish_ok", channel_id=channel_id, user_id=path_user_id, protocol=req.protocol)
        return  # 200

    if action in _READ_ACTIONS:
        if cu is None:
            raise _deny("read_non_channel_path", path=req.path)
        # TODO(later): require a Pulse member-token here and check channel
        # membership via chat-gateway before allowing reads. For now reads are
        # anonymous.
        return  # 200

    raise _deny("unknown_action", action=action, path=req.path)


@router.post("/", status_code=status.HTTP_200_OK)
@router.post("/auth", status_code=status.HTTP_200_OK)
async def authenticate(req: AuthRequest, request: Request) -> Response:
    redis = _get_redis(request)
    await _handle(req, redis)
    return Response(status_code=status.HTTP_200_OK)
