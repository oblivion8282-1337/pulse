"""HTTP routes for the voice-signaling service.

Routes:
  * ``POST /token`` — issue a LiveKit access token for joining a voice
    channel. Membership + per-channel permissions are resolved via
    chat-gateway (voice-signaling does not own the auth DB).
  * ``PUT /channels/{cid}/members/{uid}/voice-override`` — admin
    force-mute / unmute (caller must hold ``MUTE_MEMBERS``). Persists
    the override in Redis so re-issued tokens stay muted on reconnect
    and pushes a ``voice_override`` event on ``voice:events`` so
    listening clients update immediately.

The HTTP wrappers (``_chat_gateway_request``, ``_livekit_update_participant``)
live at module level so tests can monkeypatch them without spinning up
real upstream services.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException, Request, status
from livekit import api as lk
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

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
_PERM_MUTE_MEMBERS = 1 << 34
_PERM_DEAFEN_MEMBERS = 1 << 35
_PERM_MOVE_MEMBERS = 1 << 36

# Redis: ``voice:events`` pub/sub topic chat-gateway already subscribes to.
# Same constant the webhook module uses; duplicated locally to keep the
# import graph flat.
_VOICE_EVENTS_CHANNEL = "voice:events"

# Override TTL — 24h covers a normal moderator action window. The
# override is cleared by an explicit unmute; the TTL is only the
# safety net so a forgotten mute doesn't outlive a server restart.
_OVERRIDE_TTL_SECONDS = 24 * 3600

# Source-cache TTL — long enough to outlive a typical voice session
# (incl. typical disconnects + reconnects), short enough that a stale
# entry from a removed permission auto-expires before causing harm.
_SOURCE_CACHE_TTL_SECONDS = 6 * 3600


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


def _override_key(channel_id: str, user_id: str) -> str:
    return f"voice:override:channel-{channel_id}:user-{user_id}"


def _sources_key(channel_id: str, user_id: str) -> str:
    return f"voice:user_sources:channel-{channel_id}:user-{user_id}"


async def _save_user_sources(
    redis: Redis | None, channel_id: str, user_id: str, sources: list[str]
) -> None:
    """Cache the resolved publish-sources at token-issue time so a
    later unmute can restore them without granting more than the
    user's actual token permitted. Best-effort — Redis offline just
    means the unmute falls back to a conservative grant."""
    if redis is None:
        return
    try:
        await redis.set(
            _sources_key(channel_id, user_id),
            json.dumps(sources),
            ex=_SOURCE_CACHE_TTL_SECONDS,
        )
    except Exception:  # noqa: BLE001
        log.warning("voice source-cache write failed", exc_info=True)


async def _load_user_sources(
    redis: Redis | None, channel_id: str, user_id: str
) -> list[str] | None:
    """Return the cached publish-sources for the user, or None if
    missing. Caller decides the conservative fallback (mic-only vs
    none) when None."""
    if redis is None:
        return None
    try:
        raw = await redis.get(_sources_key(channel_id, user_id))
    except Exception:  # noqa: BLE001
        return None
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        parsed = json.loads(raw)
        return [str(s) for s in parsed] if isinstance(parsed, list) else None
    except json.JSONDecodeError:
        return None


async def _load_override(redis: Redis | None, channel_id: str, user_id: str) -> dict:
    """Return the current override state for (channel, user) or ``{}``.

    Shape: ``{"muted": True}`` when force-muted by an admin. Missing /
    Redis-unavailable returns ``{}``, treated as "no override"."""
    if redis is None:
        return {}
    try:
        raw = await redis.get(_override_key(channel_id, user_id))
    except Exception:  # noqa: BLE001 — Redis offline; degrade to no-override
        log.warning("voice override read failed", exc_info=True)
        return {}
    if raw is None:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


async def _save_override(
    redis: Redis, channel_id: str, user_id: str, state: dict
) -> None:
    await redis.set(
        _override_key(channel_id, user_id),
        json.dumps(state),
        ex=_OVERRIDE_TTL_SECONDS,
    )


async def _clear_override(redis: Redis, channel_id: str, user_id: str) -> None:
    await redis.delete(_override_key(channel_id, user_id))


def _apply_override(sources: list[str], can_publish: bool, override: dict) -> tuple[bool, list[str]]:
    """Strip override-blocked sources from the publish-list.

    Force-mute removes ``microphone`` (the only source ``MUTE_MEMBERS``
    governs). Camera + screen are independently gated by USE_VIDEO /
    STREAM and out of scope for a "mute". If removing microphone leaves
    no sources, can_publish is set False so LiveKit doesn't grant a
    bare publish-no-sources token."""
    if not override.get("muted"):
        return can_publish, sources
    filtered = [s for s in sources if s != "microphone"]
    return bool(filtered), filtered


async def _livekit_remove_participant(channel_id: str, user_id: str) -> None:
    """Best-effort: kick the (channel, user) out of their LiveKit room.

    Same swallow-on-failure pattern as ``_livekit_update_participant`` —
    if the participant isn't connected we still want the route to
    succeed (the WS event still fires so the client can drop voice
    state). Module-level so tests can monkeypatch."""
    settings = get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        return
    host = settings.livekit_url.replace("wss://", "https://").replace(
        "ws://", "http://"
    )
    api_client = lk.LiveKitAPI(
        host, api_key=settings.livekit_api_key, api_secret=settings.livekit_api_secret
    )
    try:
        await api_client.room.remove_participant(
            lk.RoomParticipantIdentity(
                room=_room_for_channel(channel_id),
                identity=f"user-{user_id}",
            )
        )
    except Exception:  # noqa: BLE001 — participant offline / server down
        log.warning(
            "livekit remove_participant failed for channel=%s user=%s",
            channel_id,
            user_id,
            exc_info=True,
        )
    finally:
        try:
            await api_client.aclose()
        except Exception:  # noqa: BLE001
            pass


async def _livekit_update_participant(
    channel_id: str, user_id: str, *, can_publish: bool, sources: list[str]
) -> None:
    """Best-effort live LiveKit permission update for the (channel, user)
    pair. Swallows errors (participant offline, LiveKit unreachable):
    the Redis override is still authoritative for the next reconnect.

    Module-level so tests can monkeypatch without needing a real
    LiveKit instance — same pattern as ``_chat_gateway_request``."""
    settings = get_settings()
    if not settings.livekit_api_key or not settings.livekit_api_secret:
        return
    # LiveKitAPI wants the HTTP variant; ws:// → http:// is enough for
    # the room-service endpoints we use.
    host = settings.livekit_url.replace("wss://", "https://").replace(
        "ws://", "http://"
    )
    api_client = lk.LiveKitAPI(
        host, api_key=settings.livekit_api_key, api_secret=settings.livekit_api_secret
    )
    try:
        await api_client.room.update_participant(
            lk.UpdateParticipantRequest(
                room=_room_for_channel(channel_id),
                identity=f"user-{user_id}",
                permission=lk.ParticipantPermission(
                    can_subscribe=True,
                    can_publish=can_publish,
                    can_publish_data=True,
                    can_publish_sources=[_track_source_enum(s) for s in sources]
                    if sources
                    else [],
                ),
            )
        )
    except Exception:  # noqa: BLE001 — participant offline / server down
        # WARNING (not INFO): if LiveKit is wedged the mute won't be
        # live-applied to currently-publishing tracks; the override is
        # in Redis and will take effect on the user's next reconnect,
        # but admins should see this in logs. Participant-not-found
        # (user offline) lands here too — harmless but noisy in dev;
        # consider a separate exception filter if it gets annoying.
        log.warning(
            "livekit update_participant failed for channel=%s user=%s — override is persisted, will apply on reconnect",
            channel_id,
            user_id,
            exc_info=True,
        )
    finally:
        try:
            await api_client.aclose()
        except Exception:  # noqa: BLE001
            pass


def _track_source_enum(source: str) -> int:
    """Map our source string to LiveKit's ``TrackSource`` enum value.

    Strings come from ``_publish_sources_for``; the enum int is what the
    proto wire format expects. Falls back to ``UNKNOWN`` (0) for unknown
    strings — those shouldn't reach here but the default keeps us safe."""
    return {
        "microphone": lk.TrackSource.MICROPHONE,
        "camera": lk.TrackSource.CAMERA,
        "screen_share": lk.TrackSource.SCREEN_SHARE,
        "screen_share_audio": lk.TrackSource.SCREEN_SHARE_AUDIO,
    }.get(source, lk.TrackSource.UNKNOWN)


def _get_redis(request: Request) -> Redis | None:
    return getattr(request.app.state, "redis", None)


@router.post("/token", response_model=TokenOut)
async def issue_token(
    payload: TokenIn,
    user: CurrentUser,
    request: Request,
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

    # Force-mute overrides are persistent in Redis so a kicked-and-re-joined
    # user stays muted on reconnect. Cleared by an explicit unmute call from
    # an admin.
    redis = _get_redis(request)
    # Cache the resolved sources BEFORE the override is applied, so a
    # later unmute knows what to restore (without granting strictly
    # more than the user's token actually permitted). Skipping the
    # write when Redis is offline degrades cleanly: the unmute path
    # falls back to a microphone-only restore.
    await _save_user_sources(redis, payload.channel_id, str(user.id), sources)
    override = await _load_override(redis, payload.channel_id, str(user.id))
    can_publish, sources = _apply_override(sources, can_publish, override)

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


class VoiceOverrideIn(BaseModel):
    """Partial override patch — at least one of ``mute`` / ``deafen``
    must be set. Each field is checked against its own permission bit
    (``MUTE_MEMBERS`` / ``DEAFEN_MEMBERS``) so callers with only one of
    the two can still operate. ``None`` means "don't touch that flag"."""

    model_config = ConfigDict(extra="forbid")
    mute: bool | None = None
    deafen: bool | None = None


@router.put("/channels/{channel_id}/members/{user_id}/voice-override")
async def set_voice_override(
    channel_id: str,
    user_id: str,
    payload: VoiceOverrideIn,
    caller: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    """Force-mute / -deafen / clear-overrides for a participant.

    Each field is independently permission-gated:
      * ``mute``   → requires ``MUTE_MEMBERS``    — drives LiveKit publish
                     grant (microphone is removed/restored from publish
                     sources at next reconnect; live LiveKit call is
                     best-effort for current connection).
      * ``deafen`` → requires ``DEAFEN_MEMBERS`` — purely client-side.
                     The receiving client mutes its own playback and
                     refuses to undeafen until the override is cleared.

    Writes the merged override to Redis so it survives reconnect, and
    publishes the full state on ``voice:events`` for chat-gateway to
    broadcast as ``voice_override``.
    """
    if payload.mute is None and payload.deafen is None:
        raise HTTPException(400, detail="at least one of 'mute' / 'deafen' must be set")
    if user_id == str(caller.id):
        raise HTTPException(400, detail="cannot apply voice overrides to yourself")
    bearer = _bearer_from_header(authorization)
    # Same membership + voice-channel check as token-issue. Acts as an
    # implicit existence check for the channel.
    await _require_voice_channel_member(channel_id, bearer)
    perms = await _resolve_channel_permissions(channel_id, bearer)
    if payload.mute is not None and not (perms & _PERM_MUTE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: MUTE_MEMBERS"
        )
    if payload.deafen is not None and not (perms & _PERM_DEAFEN_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: DEAFEN_MEMBERS"
        )

    redis = _get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable"
        )

    # Merge: read current → apply patch → write back. Lets a caller
    # toggle mute without disturbing an existing deafen, and vice-versa.
    current = await _load_override(redis, channel_id, user_id)
    next_state: dict[str, bool] = {
        "muted": bool(current.get("muted")),
        "deafened": bool(current.get("deafened")),
    }
    if payload.mute is not None:
        next_state["muted"] = bool(payload.mute)
    if payload.deafen is not None:
        next_state["deafened"] = bool(payload.deafen)

    if not next_state["muted"] and not next_state["deafened"]:
        await _clear_override(redis, channel_id, user_id)
    else:
        await _save_override(redis, channel_id, user_id, next_state)

    # Live LiveKit update is only meaningful for the mute side — the
    # deafen enforcement is client-only (LiveKit doesn't gate inbound
    # subscriptions by participant permission). Skip the LiveKit call
    # if mute wasn't part of this patch.
    if payload.mute is not None:
        cached_sources = await _load_user_sources(redis, channel_id, user_id)
        if next_state["muted"]:
            # Strip "microphone" from the user's cached sources; keep
            # the rest (camera, screen_share) intact so a non-mic
            # publish isn't collateral damage.
            base = cached_sources if cached_sources is not None else [
                "camera",
                "screen_share",
                "screen_share_audio",
            ]
            new_sources = [s for s in base if s != "microphone"]
        else:
            # Restore exactly what the user was permitted to publish at
            # their last token-issue. Missing cache (e.g. Redis flush
            # during the mute) → conservative microphone-only fallback;
            # the user's real grants take effect at their next reconnect.
            new_sources = (
                list(cached_sources)
                if cached_sources is not None
                else ["microphone"]
            )
        await _livekit_update_participant(
            channel_id,
            user_id,
            can_publish=bool(new_sources),
            sources=new_sources,
        )

    await redis.publish(
        _VOICE_EVENTS_CHANNEL,
        json.dumps(
            {
                "op": "voice_override",
                "channel_id": channel_id,
                "user_id": user_id,
                "muted": next_state["muted"],
                "deafened": next_state["deafened"],
            }
        ),
    )
    return {"muted": next_state["muted"], "deafened": next_state["deafened"]}


class InternalEvictIn(BaseModel):
    """Service-to-service eviction request from chat-gateway. Fired on
    kick + ban so voice-signaling can clean up the LiveKit session and
    any persisted voice-overrides for every voice channel in the guild."""

    model_config = ConfigDict(extra="forbid")
    channel_ids: list[Annotated[str, Field(min_length=1, max_length=64)]]
    user_id: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^\d+$")]


@router.post("/internal/evict-from-voice", status_code=204)
async def internal_evict_from_voice(
    payload: InternalEvictIn,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Service-to-service: bulk LiveKit-remove + override-clear for
    every channel in ``channel_ids`` for ``user_id``. No user-bearer
    permission check — gated by a shared secret. Empty secret in
    config DISABLES the endpoint entirely (production deployments must
    set ``internal_service_secret``)."""
    settings = get_settings()
    expected = settings.internal_service_secret
    if not expected:
        # Fail-closed when not configured: a misconfigured deploy can't
        # accidentally expose a no-auth eviction path.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if x_pulse_internal_secret != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="bad service token")

    redis = _get_redis(request)
    for cid in payload.channel_ids:
        # Best-effort LiveKit remove (silent on offline target) — same
        # swallow path as the admin disconnect endpoint.
        await _livekit_remove_participant(cid, payload.user_id)
        if redis is not None:
            await _clear_override(redis, cid, payload.user_id)


@router.post("/channels/{channel_id}/members/{user_id}/voice-disconnect")
async def disconnect_from_voice(
    channel_id: str,
    user_id: str,
    caller: CurrentUser,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    """Force a participant out of a voice channel. Requires
    ``MOVE_MEMBERS`` (Discord uses the same bit for moving + kicking
    from voice — Pulse-v1 only supports the kick variant; "move to
    another channel" can land later).

    Implementation:
      * LiveKit ``remove_participant`` (best-effort — silent if the
        target isn't currently connected);
      * also clear any active voice-override for the (channel, user)
        pair so the target isn't still locked when they re-join;
      * publish ``voice_disconnect`` on ``voice:events`` so the
        target's own client can drop its local voice state without
        waiting for the LiveKit ParticipantLeft webhook.
    """
    if user_id == str(caller.id):
        raise HTTPException(400, detail="cannot disconnect yourself via the admin endpoint")
    bearer = _bearer_from_header(authorization)
    await _require_voice_channel_member(channel_id, bearer)
    perms = await _resolve_channel_permissions(channel_id, bearer)
    if not (perms & _PERM_MOVE_MEMBERS):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="missing permission: MOVE_MEMBERS"
        )

    redis = _get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable"
        )

    await _livekit_remove_participant(channel_id, user_id)
    await _clear_override(redis, channel_id, user_id)

    await redis.publish(
        _VOICE_EVENTS_CHANNEL,
        json.dumps(
            {
                "op": "voice_disconnect",
                "channel_id": channel_id,
                "user_id": user_id,
            }
        ),
    )
    return {"disconnected": True}
