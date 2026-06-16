"""HTTP routes for the voice-signaling service.

Public surface:
  * ``POST /token`` — issue a LiveKit access token for joining a voice
    channel. Membership + per-channel permissions are resolved via
    chat-gateway (voice-signaling does not own the auth DB).
  * ``PUT /channels/{cid}/members/{uid}/voice-override`` — admin
    force-mute / unmute (caller must hold ``MUTE_MEMBERS``).
  * ``POST /channels/{cid}/members/{uid}/voice-disconnect`` — admin
    kick from a voice channel (requires ``MOVE_MEMBERS``).
  * ``POST /internal/evict-from-voice`` — service-to-service eviction
    from chat-gateway (gated by shared secret).

This package was split out of a single ``routes.py`` once it crossed
the §12.1 size cap. The HTTP wrappers (``_chat_gateway_request``,
``_livekit_update_participant``, …) plus ``get_settings`` are
re-exported at the package level so tests can monkeypatch them on
``dcc_voice_signaling.routes.X`` without spinning up real upstream
services. The route handler modules read those names back through
this package (``voice_routes.X``) at call time so the monkeypatches
reach the actual call site.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from redis.asyncio import Redis

from dcc_voice_signaling.config import get_settings as _config_get_settings

# Re-bind ``get_settings`` into this module's namespace. Tests
# (``conftest._isolate_voice_settings``) do
# ``voice_routes.get_settings = _provider`` — every route handler that
# reads ``voice_routes.get_settings`` then picks up the test provider.
get_settings = _config_get_settings


# Redis: ``voice:events`` pub/sub topic chat-gateway already subscribes to.
# Same constant the webhook module uses; duplicated locally to keep the
# import graph flat.
_VOICE_EVENTS_CHANNEL = "voice:events"


def _get_redis(request: Request) -> Redis | None:
    return getattr(request.app.state, "redis", None)


# Helper submodules. These import ``dcc_voice_signaling.routes`` back —
# fine because their references to ``voice_routes.X`` are all inside
# function bodies (executed at call time, not import time).
from dcc_voice_signaling.routes import chat_gateway as _chat_gateway  # noqa: E402
from dcc_voice_signaling.routes import livekit_client as _livekit_client  # noqa: E402
from dcc_voice_signaling.routes import overrides_state as _overrides_state  # noqa: E402

# Re-export helpers so tests + route handlers can reach them as
# ``voice_routes._X``. Keep this list in sync with the modules above —
# the test surface is documented in CLAUDE.md and the test files
# themselves do ``monkeypatch.setattr(voice_routes, "_X", …)``.
_CHAT_GW_CHANNEL_TYPE_VOICE = _chat_gateway._CHAT_GW_CHANNEL_TYPE_VOICE
_PERM_CONNECT = _chat_gateway._PERM_CONNECT
_PERM_SPEAK = _chat_gateway._PERM_SPEAK
_PERM_STREAM = _chat_gateway._PERM_STREAM
_PERM_USE_VIDEO = _chat_gateway._PERM_USE_VIDEO
_PERM_MUTE_MEMBERS = _chat_gateway._PERM_MUTE_MEMBERS
_PERM_DEAFEN_MEMBERS = _chat_gateway._PERM_DEAFEN_MEMBERS
_PERM_MOVE_MEMBERS = _chat_gateway._PERM_MOVE_MEMBERS

_init_http_client = _chat_gateway._init_http_client
_close_http_client = _chat_gateway._close_http_client
_chat_gateway_request = _chat_gateway._chat_gateway_request
_bearer_from_header = _chat_gateway._bearer_from_header
_require_voice_channel_member = _chat_gateway._require_voice_channel_member
_resolve_channel_permissions = _chat_gateway._resolve_channel_permissions
_publish_sources_for = _chat_gateway._publish_sources_for

_room_for_channel = _livekit_client._room_for_channel
_track_source_enum = _livekit_client._track_source_enum
_livekit_remove_participant = _livekit_client._livekit_remove_participant
_livekit_update_participant = _livekit_client._livekit_update_participant

_OVERRIDE_TTL_SECONDS = _overrides_state._OVERRIDE_TTL_SECONDS
_SOURCE_CACHE_TTL_SECONDS = _overrides_state._SOURCE_CACHE_TTL_SECONDS
_override_key = _overrides_state._override_key
_sources_key = _overrides_state._sources_key
_save_user_sources = _overrides_state._save_user_sources
_load_user_sources = _overrides_state._load_user_sources
_load_override = _overrides_state._load_override
_save_override = _overrides_state._save_override
_clear_override = _overrides_state._clear_override
_apply_override = _overrides_state._apply_override


# Route submodules. Imported AFTER the helper re-exports above so their
# call-site references to ``voice_routes.X`` resolve to the names this
# module owns. Order is load-bearing (helpers must already be bound)
# — keep ruff out of it.
# ruff: noqa: E402, I001
from dcc_voice_signaling.routes.token import (
    TokenIn,
    TokenOut,
    router as _token_router,
)
from dcc_voice_signaling.routes.voice_override import (
    VoiceOverrideIn,
    router as _voice_override_router,
)
from dcc_voice_signaling.routes.voice_disconnect import (
    router as _voice_disconnect_router,
)
from dcc_voice_signaling.routes.voice_move import (
    router as _voice_move_router,
)
from dcc_voice_signaling.routes.internal import (
    InternalEvictIn,
    router as _internal_router,
)


router = APIRouter()
router.include_router(_token_router)
router.include_router(_voice_override_router)
router.include_router(_voice_disconnect_router)
router.include_router(_voice_move_router)
router.include_router(_internal_router)


__all__ = [
    "router",
    "get_settings",
    # Pydantic models
    "TokenIn",
    "TokenOut",
    "VoiceOverrideIn",
    "InternalEvictIn",
]
