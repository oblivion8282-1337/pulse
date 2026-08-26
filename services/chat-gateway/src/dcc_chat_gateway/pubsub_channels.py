"""Redis pub/sub channel names + key templates used by chat-gateway.

Kept in its own module so the fan-out / listener / cache layers can import
the same names without pulling in :class:`ConnectionManager`. Re-exported
from :mod:`pubsub` for backward compatibility with existing callers
(``from dcc_chat_gateway.pubsub import GUILD_EVENTS_CHANNEL`` still works).
"""

from __future__ import annotations

CHANNEL_KEY = "chat:channel:{channel_id}"
CHANNEL_PATTERN = "chat:channel:*"

# Voice-presence events published by the voice-signaling service. Payload:
# {"channel_id": "<id>", "user_ids": ["<id>", ...]} — the *full* current
# member set of that voice channel. We rebroadcast it to every connected
# WebSocket as {"op": "voice_state", ...}; clients filter by their guilds.
VOICE_EVENTS_CHANNEL = "voice:events"

# Guild-lifecycle events (channel created/updated/deleted, member added).
# Published by the REST routes; each payload is a complete envelope with its
# own `op` field which we forward verbatim to *every* connected WebSocket
# (clients filter by their guild membership). These must NOT travel on
# `chat:channel:<id>` — that channel carries only chat `message` payloads,
# which `_listen` wraps as `{"op": "message", ...}`.
GUILD_EVENTS_CHANNEL = "guild:events"

# Per-channel HQ-stream state changes published by media-svc (T5a/T5b).
# Payload: {"channel_id": "<id>", "active": true|false, "user_id": "<id>"|null}
# — one event per state change. We rebroadcast as {"op": "stream_state", ...}
# to every connected WebSocket; clients filter by their guilds. The mirror of
# the voice-presence mechanism, just for the MediaMTX HQ stream.
STREAM_EVENTS_CHANNEL = "stream:events"

# Public per-channel stream state, written by the media-svc poller. We read
# these keys directly from Redis when building the `ready` payload / the
# `GET /guilds/{id}/stream-state` re-sync response — the same way voice
# presence is read straight off `voice:room:*`. (media-svc has no guild→channel
# map; chat-gateway does, so it does the per-channel lookup.)
STREAM_CHANNEL_STATE_KEY = "stream:channel:{channel_id}"

# Per-user self-reported voice state (mic_muted / deafened). Written by the
# WS `voice_self_state` op (chat-gateway owns this key — voice-signaling never
# touches it). Absent key == both flags false. TTL matches voice-presence's
# 6h self-heal window; cleared explicitly on disconnect.
VOICE_USER_STATE_KEY = "voice:user_state:{user_id}"
VOICE_USER_STATE_TTL_SECONDS = 6 * 3600

# Per-user direct-delivery events (currently: `mention_added`). The payload
# carries an explicit ``target_user_id`` and the listener fans it out only
# to *that* user's sockets, regardless of channel subscription. Used so a
# client with the channel closed can still bump its mention counter for
# cross-channel notifications — they'd otherwise miss the `message` envelope
# entirely. Cross-instance via Redis so a multi-replica deploy still routes
# correctly when the recipient is connected to a different gateway pod.
USER_EVENTS_CHANNEL = "user:events"

# Cloud-Admin-Benachrichtigungen (aktuell: neue Self-Host- und
# App-Hosting-Anträge). **auth-svc** publiziert hier, chat-gateway fächert an
# alle Sockets mit ``is_admin`` auf. Ohne diesen Kanal erfuhr ein Admin von
# einem neuen Antrag erst beim nächsten 60-Sekunden-Poll seines Clients — oder
# gar nicht, wenn kein Admin-Fenster offen war.
#
# Der Payload trägt **keine Antragsdaten**, nur „es gibt Neues": der Client
# holt die Liste danach über seinen regulären, cookie-authentifizierten
# Admin-Endpoint. So kann ein (fälschlich) mitlesender Nicht-Admin-Socket
# nichts erfahren, was er nicht ohnehin dürfte.
ADMIN_EVENTS_CHANNEL = "admin:events"
