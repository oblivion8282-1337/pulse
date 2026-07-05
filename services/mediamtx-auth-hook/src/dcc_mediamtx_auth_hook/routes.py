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
  * ``read`` / ``playback`` on ``channel-<id>`` → 200 iff ``token`` (the
                                             ``?token=`` query MediaMTX forwards) names a Redis
                                             ``stream:token:<…>`` record with scope ``read`` whose
                                             ``channel_id`` + ``user_id`` match the path; else 401.
                                             Read tokens are NOT consumed (multi-use within TTL).
                                             Disable via ``read_token_required=false`` (anonymous).
  * everything else / non-channel paths    → 401.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs

import structlog
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, field_validator
from redis.asyncio import Redis

from dcc_mediamtx_auth_hook.config import get_settings
from dcc_mediamtx_auth_hook.shared import (
    TOKEN_KEY,
    active_key,
    parse_channel_user_path,
)

log = structlog.get_logger(__name__)

router = APIRouter()

_EXCLUDED_ACTIONS = frozenset({"api", "metrics", "pprof"})
_READ_ACTIONS = frozenset({"read", "playback"})


class AuthRequest(BaseModel):
    # MediaMTX sends all of these; treat them all as optional so a slightly
    # different build (extra/missing field) never 422s the auth call.
    # MediaMTX <=1.17 emits JSON `null` for fields it doesn't set (e.g. `id`
    # on WHEP OPTIONS preflights); 1.18+ emits `""`. The _none_to_empty
    # validator normalises both to a string so downstream code never sees None.
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

    @field_validator(
        "user", "password", "token", "ip", "action", "path", "protocol", "id", "query",
        mode="before",
    )
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return "" if v is None else v

    @property
    def credential(self) -> str:
        """The stream-token MediaMTX carried.

        Where it lands depends on the protocol:
          * RTMP/RTMPS publish → the stream key password (``password``).
          * Some builds populate the dedicated ``token`` field.
          * **WHEP/WebRTC reads** (verified against MediaMTX 1.17.1): the
            ``?token=`` URL query is NOT mapped to ``token`` — it arrives only
            in the raw ``query`` string (e.g. ``"token=abc123"``). Parse it out.
        """
        direct = (self.password or self.token or "").strip()
        if direct:
            return direct
        if self.query:
            vals = parse_qs(self.query).get("token")
            if vals:
                return vals[0].strip()
        return ""


def _get_redis(request: Request) -> Redis:
    redis: Redis | None = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable")
    return redis


def _deny(reason: str, **fields: Any) -> HTTPException:
    log.info("auth_denied", reason=reason, **fields)
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail="denied")


async def _peek_token(redis: Redis, token: str) -> dict[str, Any] | None:
    """GET the token record without consuming it.

    Returns the parsed record dict, or None if the token is absent or unparseable.
    Does NOT delete the key — call ``_consume_token_and_mark_active`` after all
    validation passes.
    """
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


# Atomically consume (DEL) the token AND, only if it was still present, write
# the ``stream:active`` publisher record in the SAME round-trip. This closes a
# window where Redis could flap between the DEL and the active-write, leaving a
# consumed token but no active record — the stream would then be invisible to
# WHEP (404) with no error surfaced. Either both happen or neither does.
# KEYS[1] = token key, KEYS[2] = active key.
# ARGV[1] = active payload JSON, ARGV[2] = active TTL seconds.
# Returns 1 if the token was consumed (this request won the single-use race),
# 0 if it was already gone (concurrent consumer) — in which case the active
# record is NOT written and the caller denies.
_LUA_CONSUME_AND_MARK = """
if redis.call('DEL', KEYS[1]) == 0 then
    return 0
end
redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[2]))
return 1
"""


async def _consume_token_and_mark_active(
    redis: Redis, token: str, channel_id: str, user_id: str, slot: str, path: str,
    label: str | None = None,
) -> bool:
    """Atomically consume the token and write the publisher-active record.

    Returns True if the token was still present (this request won the single-use
    race) and the active record was written; False if another concurrent request
    already consumed it (then nothing is written). Callers that get False must
    treat the auth as denied to enforce single-use semantics under concurrent
    retries.

    The active record (``user_id``/``started_at``/``path``) is keyed by
    (channel, user, slot) so a user's two streams don't clobber each other's
    record. It is set with an EX TTL so a re-publish refreshes the self-heal
    window and overwrites ``path`` — media-svc's WHEP-URL lookup then always
    returns that slot's latest publish path (with its per-session nonce).
    ``label`` (copied from the token record) is included when present so the
    poller can surface it in ``stream:channel``/``stream:events`` without a
    second lookup source."""
    settings = get_settings()
    active: dict[str, Any] = {
        "user_id": user_id,
        "started_at": datetime.now(UTC).isoformat(),
        "path": path,
    }
    if isinstance(label, str) and label:
        active["label"] = label
    payload = json.dumps(active, separators=(",", ":"))
    consumed = await redis.eval(  # type: ignore[arg-type]
        _LUA_CONSUME_AND_MARK,
        2,
        TOKEN_KEY.format(token=token),
        active_key(channel_id, user_id, int(slot)),
        payload,
        str(settings.publisher_ttl_seconds),
    )
    return bool(consumed)


async def _handle(req: AuthRequest, redis: Redis) -> None:
    action = req.action

    if action in _EXCLUDED_ACTIONS:
        return  # 200

    cu = parse_channel_user_path(req.path)  # (channel_id, user_id, slot, nonce) or None

    if action == "publish":
        if cu is None:
            raise _deny("publish_non_channel_path", path=req.path)
        channel_id, path_user_id, path_slot, path_nonce = cu
        # Step 1 — GET the token record without consuming it so that validation
        # failures (wrong scope/channel/user/nonce) leave the token intact and
        # the publisher can retry with the same token after fixing the request.
        rec = await _peek_token(redis, req.credential)
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
        if str(rec.get("nonce") or "") != path_nonce:
            raise _deny(
                "publish_nonce_mismatch",
                path=req.path,
                token_nonce=rec.get("nonce"),
            )
        # The slot binds the token to one of the user's stream paths. A legacy
        # token (no ``slot`` field) and a legacy path (no ``-s<slot>`` segment)
        # both resolve to "0", so single-stream publishes match as before; a
        # slot-1 token may not publish on the slot-0 path or vice versa.
        if str(rec.get("slot") or 0) != path_slot:
            raise _deny(
                "publish_slot_mismatch",
                path=req.path,
                token_slot=rec.get("slot"),
            )
        # Step 2 — all checks passed; atomically consume the token AND write the
        # publisher-active record in one round-trip, so a Redis flap can't leave
        # a consumed token without an active record (which would 404 on WHEP).
        # A False return means a concurrent request already consumed the token
        # (single-use) → deny, with nothing written. ``label`` is copied from the
        # token record into the active record (None/empty → omitted).
        label_val = rec.get("label")
        label = label_val if isinstance(label_val, str) and label_val else None
        if not await _consume_token_and_mark_active(
            redis, req.credential, channel_id, path_user_id, path_slot, req.path, label
        ):
            raise _deny("publish_token_already_consumed", path=req.path)
        log.info(
            "auth_publish_ok",
            channel_id=channel_id,
            user_id=path_user_id,
            slot=path_slot,
            protocol=req.protocol,
        )
        return  # 200

    if action in _READ_ACTIONS:
        if cu is None:
            raise _deny("read_non_channel_path", path=req.path)
        # Reads are authorised per (channel, user) — a viewer cleared for the
        # publisher may read any of that publisher's slots — so slot/nonce here
        # are informational only.
        channel_id, path_user_id, _path_slot, _path_nonce = cu
        if not get_settings().read_token_required:
            return  # 200 — anonymous reads (fallback / self-host)
        # Read tokens are validated but NOT consumed: a WHEP handshake triggers
        # multiple auth calls (OPTIONS preflight + POST) and clients re-auth on
        # reconnect, so single-use would break playback. The TTL bounds them.
        rec = await _peek_token(redis, req.credential)
        if rec is None:
            raise _deny("read_unknown_token", path=req.path)
        if rec.get("scope") != "read":
            raise _deny("read_wrong_scope", path=req.path, scope=rec.get("scope"))
        if str(rec.get("channel_id")) != channel_id:
            raise _deny(
                "read_channel_mismatch", path=req.path, token_channel=rec.get("channel_id")
            )
        if str(rec.get("user_id") or "") != path_user_id:
            raise _deny(
                "read_user_mismatch", path=req.path, token_user=rec.get("user_id")
            )
        return  # 200

    raise _deny("unknown_action", action=action, path=req.path)


@router.post("/", status_code=status.HTTP_200_OK)
@router.post("/auth", status_code=status.HTTP_200_OK)
async def authenticate(req: AuthRequest, request: Request) -> Response:
    redis = _get_redis(request)
    await _handle(req, redis)
    return Response(status_code=status.HTTP_200_OK)
