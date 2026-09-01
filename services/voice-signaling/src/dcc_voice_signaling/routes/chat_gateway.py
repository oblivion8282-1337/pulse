"""Chat-gateway client + per-channel permission resolution.

voice-signaling can't import chat-gateway's models or dcc-shared's
permission bitfield without circular dev-dep graphs, so the bits +
voice-channel type discriminator are pinned here. Drift is caught by
``test_bit_constants_match_shared`` in this service's test suite."""

from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException, status

from dcc_voice_signaling import routes as voice_routes

log = logging.getLogger(__name__)

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
_PERM_MUTE_MEMBERS = 1 << 34
_PERM_DEAFEN_MEMBERS = 1 << 35
_PERM_MOVE_MEMBERS = 1 << 36

# Shared HTTP client for chat-gateway calls, initialized in app lifespan.
# Reusing a single client avoids connection setup/teardown overhead on
# every request and enables connection pooling + http/2.
_http_client: httpx.AsyncClient | None = None


async def _init_http_client() -> None:
    """Initialize the shared HTTP client. Called from app lifespan startup."""
    global _http_client
    settings = voice_routes.get_settings()
    # NB: no http2=True — it requires the optional `h2` package which is not a
    # declared dependency (present transitively in dev, absent in the prod
    # image → ImportError at startup). HTTP/1.1 with connection pooling is fine
    # for internal service-to-service calls.
    _http_client = httpx.AsyncClient(timeout=settings.chat_gateway_timeout_s)


async def _close_http_client() -> None:
    """Close the shared HTTP client. Called from app lifespan teardown."""
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


async def _chat_gateway_request(
    method: str, path: str, *, bearer: str
) -> httpx.Response:
    """Call chat-gateway, forwarding the user's bearer token. Tests
    monkeypatch this function."""
    global _http_client
    settings = voice_routes.get_settings()
    base = settings.chat_gateway_url
    if base is None:
        raise RuntimeError("chat_gateway_url is not configured")
    url = base.rstrip("/") + path
    if _http_client is None:
        raise RuntimeError("HTTP client not initialized")
    return await _http_client.request(
        method, url, headers={"Authorization": f"Bearer {bearer}"}
    )


def _bearer_from_header(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    return authorization.split(" ", 1)[1].strip()


_membership_warning_emitted = False


async def _require_voice_channel_member(channel_id: str, bearer: str) -> int:
    """Ensure the caller is a member of `channel_id`'s guild and that the
    channel is a voice channel. Returns the channel's ``user_limit``
    (0 = unbegrenzt) so the token route can enforce it. No-op in dev/test
    setups where ``chat_gateway_url`` is unset (a one-shot warning is
    logged) → returns 0 (kein Limit)."""
    global _membership_warning_emitted
    settings = voice_routes.get_settings()
    if settings.chat_gateway_url is None:
        if not _membership_warning_emitted:
            log.warning(
                "chat_gateway_url unset — voice tokens are issued without a "
                "channel-membership check. Set CHAT_GATEWAY_URL in production."
            )
            _membership_warning_emitted = True
        return 0
    try:
        resp = await voice_routes._chat_gateway_request(
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
        body = resp.json()
        channel_type = int(body.get("type", -1))
    except (ValueError, TypeError, AttributeError):
        # ``resp.json()`` can raise on a non-JSON body too; treat that the same
        # way as a missing/invalid type field.
        channel_type = -1
        body = {}
    if channel_type != _CHAT_GW_CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="channel is not a voice channel",
        )
    try:
        return max(0, int(body.get("user_limit", 0)))
    except (ValueError, TypeError):
        return 0


async def _resolve_channel_permissions(channel_id: str, bearer: str) -> int:
    """Ask chat-gateway for the caller's resolved channel-level bitfield.

    Returns ``0`` on any non-200 — voice-signaling treats unknown
    permissions as "no publish" (subscribe-only). Membership has
    already been verified via ``_require_voice_channel_member`` by the
    time this runs, so a 403 here would mean a race (member kicked
    between the two calls) — bailing to 0 is the safe answer."""
    settings = voice_routes.get_settings()
    if settings.chat_gateway_url is None:
        # No chat-gateway configured (test/dev fallback) — assume full
        # publish, matching the pre-gate behaviour. The
        # ``_require_voice_channel_member`` warning already fired.
        return _PERM_CONNECT | _PERM_SPEAK | _PERM_USE_VIDEO | _PERM_STREAM
    try:
        resp = await voice_routes._chat_gateway_request(
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


async def _require_target_in_guild(channel_id: str, user_id: str, bearer: str) -> None:
    """Ensure the target ``user_id`` is a member of ``channel_id``'s guild —
    shared by the admin endpoints (voice-override / voice-disconnect) so an
    admin can't operate on users outside their guild. No-op when
    ``chat_gateway_url`` is unset (dev/test)."""
    settings = voice_routes.get_settings()
    if settings.chat_gateway_url is None:
        return
    try:
        channel_resp = await voice_routes._chat_gateway_request(
            "GET", f"/channels/{channel_id}", bearer=bearer
        )
        # Fail closed: a non-200 (transient 502, rolling restart) must not
        # silently skip the cross-guild + target-membership checks below.
        if channel_resp.status_code != 200:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
            )
        guild_id = channel_resp.json().get("guild_id")
        if guild_id:
            # Verify the target user is a member of this guild.
            member_resp = await voice_routes._chat_gateway_request(
                "GET", f"/guilds/{guild_id}/members/{user_id}", bearer=bearer
            )
            if member_resp.status_code == 404:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND,
                    detail="user is not a member of this guild",
                )
            if member_resp.status_code >= 400:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    detail="membership check unavailable",
                )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail="membership check unavailable"
        ) from exc


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
        # LiveKit; the HQ push goes through MediaMTX and bypasses
        # the LiveKit grant entirely. The STREAM bit gates the
        # ScreenShare track here so browser-screenshare permission
        # matches the HQ-stream permission semantically.
        sources.append("screen_share")
        sources.append("screen_share_audio")
    return bool(sources), sources


# Voice-pull leave marker — written by chat-gateway's pull endpoint; its
# presence here means "this user was pulled into this channel, so tell
# chat-gateway to revoke the temporary grant on leave". Synchron halten
# mit chat-gateway voice_pull_cleanup._MARKER_KEY.
_VOICE_PULL_MARKER = "voice_pull:channel-{channel_id}:user-{user_id}"


async def _maybe_revoke_voice_pull(redis, channel_id: str, user_id: str) -> None:
    """On ``participant_left``: if the user was voice-pulled into the
    channel (Redis marker exists), tell chat-gateway to revoke the grant.

    Cheap marker-EXISTS first so a normal (no-pull) leave costs one Redis
    round-trip and no HTTP. Fire-and-forget — a lost/failed call is caught
    by chat-gateway's voice-pull reaper backstop, so the webhook itself
    never fails on this."""
    global _http_client
    settings = voice_routes.get_settings()
    if not settings.chat_gateway_url or not settings.internal_service_secret:
        return  # nothing to call, or nothing to authenticate with
    try:
        if not await redis.exists(_VOICE_PULL_MARKER.format(channel_id=channel_id, user_id=user_id)):
            return
    except Exception:  # noqa: BLE001 — Redis best-effort; reaper is the backstop
        return
    if _http_client is None:
        return
    url = settings.chat_gateway_url.rstrip("/") + "/internal/voice-pull-revoke"
    try:
        resp = await _http_client.post(
            url,
            json={"channel_id": int(channel_id), "user_id": int(user_id)},
            headers={"X-Pulse-Internal-Secret": settings.internal_service_secret},
        )
        if resp.status_code >= 400:
            log.warning(
                "voice-pull revoke returned %s (cid=%s uid=%s)",
                resp.status_code,
                channel_id,
                user_id,
            )
    except httpx.HTTPError as exc:
        log.warning("voice-pull revoke call failed (cid=%s uid=%s): %s", channel_id, user_id, exc)
