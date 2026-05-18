"""HTTP routes for the voice-signaling service.

This is a Phase E (Voice-Backend-Skelett) — only `POST /token`. No
Redis state, no webhook receiver. The Frontend client will use the
returned `token` + `ws_url` to dial LiveKit directly via the
livekit-client SDK.

Membership is enforced by calling chat-gateway's ``GET /channels/{id}``
with the caller's Pulse access token (chat-gateway is the only service
that knows guild/channel membership). The HTTP wrapper lives at module
level so tests can monkeypatch it; the actual issue-logic stays small.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException, status
from livekit import api as lk
from pydantic import BaseModel, ConfigDict, Field

from dcc_voice_signaling.config import get_settings
from dcc_voice_signaling.security import CurrentUser

log = logging.getLogger(__name__)

router = APIRouter()

# Channel.type discriminator in chat-gateway (mirrors models.CHANNEL_TYPE_VOICE).
# Duplicated here because voice-signaling can't import chat-gateway's models.
_CHAT_GW_CHANNEL_TYPE_VOICE = 1

# Permission bits we care about for the LiveKit publish-source gate.
# Mirror of dcc_shared.permissions.Permissions; duplicated because
# voice-signaling can't pull dcc-shared without making the dependency
# graph circular in dev (chat-gateway imports dcc-shared, dcc-shared
# is the canonical source). Pinning these here is the cheapest way to
# keep voice-signaling decoupled — drift is caught by
# ``test_bit_constants_match_shared`` in this service's test suite.
_PERM_CONNECT = 1 << 30
_PERM_SPEAK = 1 << 31
_PERM_STREAM = 1 << 32
_PERM_USE_VIDEO = 1 << 33


class TokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: Annotated[str, Field(min_length=1, max_length=64)]
    # 1 = voice. The frontend may send `kind: 'voice' | 'screen'` later;
    # for the skeleton we only emit voice grants.
    kind: Annotated[str, Field(default="voice", pattern=r"^(voice|screen)$")] = "voice"


class TokenOut(BaseModel):
    token: str
    ws_url: str
    room: str


def _room_for_channel(channel_id: str) -> str:
    # Plain "channel-<snowflake>" so it's recognisable in LiveKit logs.
    return f"channel-{channel_id}"


async def _chat_gateway_request(
    method: str, path: str, *, bearer: str
) -> httpx.Response:
    """Call chat-gateway, forwarding the user's bearer token. Tests
    monkeypatch this function."""
    settings = get_settings()
    base = settings.chat_gateway_url
    if base is None:
        raise RuntimeError("chat_gateway_url is not configured")
    url = base.rstrip("/") + path
    async with httpx.AsyncClient(timeout=settings.chat_gateway_timeout_s) as http:
        return await http.request(
            method, url, headers={"Authorization": f"Bearer {bearer}"}
        )


def _bearer_from_header(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    return authorization.split(" ", 1)[1].strip()


_membership_warning_emitted = False


async def _require_voice_channel_member(channel_id: str, bearer: str) -> None:
    """Ensure the caller is a member of `channel_id`'s guild and that the
    channel is a voice channel. No-op in dev/test setups where
    ``chat_gateway_url`` is unset (a one-shot warning is logged)."""
    global _membership_warning_emitted
    settings = get_settings()
    if settings.chat_gateway_url is None:
        if not _membership_warning_emitted:
            log.warning(
                "chat_gateway_url unset — voice tokens are issued without a "
                "channel-membership check. Set CHAT_GATEWAY_URL in production."
            )
            _membership_warning_emitted = True
        return
    try:
        resp = await _chat_gateway_request(
            "GET", f"/channels/{channel_id}", bearer=bearer
        )
    except httpx.HTTPError as exc:
        log.warning("chat-gateway membership check failed: %s", exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
        ) from exc
    if resp.status_code == 404:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    if resp.status_code == 403:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="not a member of this channel"
        )
    if resp.status_code >= 400:
        # chat-gateway is an upstream; map anything we didn't explicitly handle
        # (500s, 429s, 401s when chat-gateway itself rejects the bearer, …) to
        # 502 so we don't leak its internal status to the client.
        log.warning(
            "chat-gateway membership check returned unexpected status %s",
            resp.status_code,
        )
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
        )
    try:
        channel_type = int(resp.json().get("type", -1))
    except (ValueError, TypeError, AttributeError):
        # ``resp.json()`` can raise on a non-JSON body too; treat that the same
        # way as a missing/invalid type field.
        channel_type = -1
    if channel_type != _CHAT_GW_CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="channel is not a voice channel",
        )


async def _resolve_channel_permissions(channel_id: str, bearer: str) -> int:
    """Ask chat-gateway for the caller's resolved channel-level bitfield.

    Returns ``0`` on any non-200 — voice-signaling treats unknown
    permissions as "no publish" (subscribe-only). Membership has
    already been verified via ``_require_voice_channel_member`` by the
    time this runs, so a 403 here would mean a race (member kicked
    between the two calls) — bailing to 0 is the safe answer."""
    settings = get_settings()
    if settings.chat_gateway_url is None:
        # No chat-gateway configured (test/dev fallback) — assume full
        # publish, matching the pre-gate behaviour. The
        # ``_require_voice_channel_member`` warning already fired.
        return _PERM_CONNECT | _PERM_SPEAK | _PERM_USE_VIDEO | _PERM_STREAM
    try:
        resp = await _chat_gateway_request(
            "GET", f"/channels/{channel_id}/permissions/me", bearer=bearer
        )
    except httpx.HTTPError as exc:
        log.warning("chat-gateway permission lookup failed: %s", exc)
        return 0
    if resp.status_code != 200:
        log.warning(
            "chat-gateway permission lookup returned %s for channel %s",
            resp.status_code,
            channel_id,
        )
        return 0
    try:
        return int(resp.json().get("permissions", "0"))
    except (ValueError, TypeError, AttributeError):
        return 0


def _publish_sources_for(perms: int) -> tuple[bool, list[str]]:
    """Translate Pulse permission bits to LiveKit publish-source strings.
    Returns ``(can_publish, sources)`` — the first is true iff at least
    one source is allowed.

    Source strings match LiveKit's ``TrackSource`` enum names lower-
    cased (``microphone`` / ``camera`` / ``screen_share``)."""
    sources: list[str] = []
    if perms & _PERM_SPEAK:
        sources.append("microphone")
    if perms & _PERM_USE_VIDEO:
        sources.append("camera")
    if perms & _PERM_STREAM:
        # Browser screenshare publishes Track.Source.ScreenShare in
        # LiveKit; the HQ GSR push goes through MediaMTX and bypasses
        # the LiveKit grant entirely. The STREAM bit gates the
        # ScreenShare track here so browser-screenshare permission
        # matches the HQ-stream permission semantically.
        sources.append("screen_share")
        sources.append("screen_share_audio")
    return bool(sources), sources


@router.post("/token", response_model=TokenOut)
async def issue_token(
    payload: TokenIn,
    user: CurrentUser,
    authorization: Annotated[str | None, Header()] = None,
) -> TokenOut:
    settings = get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit not configured",
        )

    bearer = _bearer_from_header(authorization)
    await _require_voice_channel_member(payload.channel_id, bearer)
    perms = await _resolve_channel_permissions(payload.channel_id, bearer)
    # CONNECT is the join gate. A member who has been deny-CONNECT'd on the
    # channel must not get *any* token — issuing a subscribe-only token here
    # would still let them sit in the room and consume bandwidth. Refuse
    # entirely instead.
    if not (perms & _PERM_CONNECT):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="cannot connect to this voice channel",
        )
    can_publish, sources = _publish_sources_for(perms)

    room = _room_for_channel(payload.channel_id)
    grants = lk.VideoGrants(
        room_join=True,
        room=room,
        can_publish=can_publish,
        can_publish_sources=sources if sources else None,
        can_subscribe=True,
        can_publish_data=True,
    )
    identity = f"user-{user.id}"
    builder = (
        lk.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(user.username or identity)
        .with_grants(grants)
        .with_ttl(timedelta(seconds=settings.livekit_token_ttl_seconds))
    )
    token = builder.to_jwt()
    return TokenOut(token=token, ws_url=settings.livekit_url, room=room)
