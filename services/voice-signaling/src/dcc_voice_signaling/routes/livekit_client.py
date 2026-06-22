"""LiveKit room-service helpers used by the voice-signaling routes.

Kept at module level so the route handlers can call them through the
``dcc_voice_signaling.routes`` namespace (see ``__init__.py``). Tests
monkeypatch ``voice_routes._livekit_update_participant`` /
``voice_routes._livekit_remove_participant`` instead of poking LiveKit
itself.
"""

from __future__ import annotations

import logging

from livekit import api as lk

from dcc_voice_signaling import routes as voice_routes

log = logging.getLogger(__name__)


def _room_for_channel(channel_id: str) -> str:
    # Plain "channel-<snowflake>" so it's recognisable in LiveKit logs.
    return f"channel-{channel_id}"


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


async def _livekit_remove_participant(
    channel_id: str, user_id: str, *, api_client: lk.LiveKitAPI | None = None
) -> None:
    """Best-effort: kick the (channel, user) out of their LiveKit room.

    Same swallow-on-failure pattern as ``_livekit_update_participant`` —
    if the participant isn't connected we still want the route to
    succeed (the WS event still fires so the client can drop voice
    state). Module-level so tests can monkeypatch.

    If ``api_client`` is not provided, a temporary client is created (for
    backward compatibility with tests). Production routes should pass the
    singleton from ``request.app.state.livekit_api`` to reuse the connection
    pool."""
    if api_client is None:
        settings = voice_routes.get_settings()
        if not settings.livekit_api_key or not settings.livekit_api_secret:
            return
        # Server-seitige Calls bevorzugen die interne livekit_api_url (wie der
        # Singleton in app.py): die öffentliche livekit_url geht über den
        # Reverse-Proxy → 502 genau während eines Deploys (CLAUDE.md-Gotcha).
        api_url = settings.livekit_api_url or settings.livekit_url
        host = api_url.replace("wss://", "https://").replace("ws://", "http://")
        api_client = lk.LiveKitAPI(
            host, api_key=settings.livekit_api_key, api_secret=settings.livekit_api_secret
        )
        # Temporary client created here; we own cleanup.
        should_close = True
    else:
        should_close = False

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
        if should_close:
            try:
                await api_client.aclose()
            except Exception:  # noqa: BLE001
                pass


async def _livekit_update_participant(
    channel_id: str,
    user_id: str,
    *,
    can_publish: bool,
    sources: list[str],
    api_client: lk.LiveKitAPI | None = None,
) -> None:
    """Best-effort live LiveKit permission update for the (channel, user)
    pair. Swallows errors (participant offline, LiveKit unreachable):
    the Redis override is still authoritative for the next reconnect.

    Module-level so tests can monkeypatch without needing a real
    LiveKit instance — same pattern as ``_chat_gateway_request``.

    If ``api_client`` is not provided, a temporary client is created (for
    backward compatibility with tests). Production routes should pass the
    singleton from ``request.app.state.livekit_api`` to reuse the connection
    pool."""
    if api_client is None:
        settings = voice_routes.get_settings()
        if not settings.livekit_api_key or not settings.livekit_api_secret:
            return
        # LiveKitAPI wants the HTTP variant; ws:// → http:// is enough for
        # the room-service endpoints we use.
        # Server-seitige Calls bevorzugen die interne livekit_api_url (wie der
        # Singleton in app.py): die öffentliche livekit_url geht über den
        # Reverse-Proxy → 502 genau während eines Deploys (CLAUDE.md-Gotcha).
        api_url = settings.livekit_api_url or settings.livekit_url
        host = api_url.replace("wss://", "https://").replace("ws://", "http://")
        api_client = lk.LiveKitAPI(
            host, api_key=settings.livekit_api_key, api_secret=settings.livekit_api_secret
        )
        # Temporary client created here; we own cleanup.
        should_close = True
    else:
        should_close = False

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
        if should_close:
            try:
                await api_client.aclose()
            except Exception:  # noqa: BLE001
                pass
