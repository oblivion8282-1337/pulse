"""Voice-presence + admin-override events.

Two shapes on ``voice:events``:

1. *Bare snapshot* (no ``op``) — voice-signaling publishes the channel's
   full current member set. The chat-gateway listener detects "no op /
   has ``user_ids``" and wraps as ``op="voice_state"`` before fan-out,
   enriching with per-user mute/deafen state from Redis. Modelled here
   as ``VoiceStateSnapshot`` — for *publisher* use; the outbound WS
   envelope shape (with ``op`` + enriched user_states) is documented
   in the listener.

2. *Op envelopes* — voice-signaling publishes admin actions
   (``voice_disconnect``, ``voice_override``) with an explicit ``op``
   the listener recognises and forwards verbatim.
"""

from __future__ import annotations

from typing import Literal

from dcc_shared.events._base import _EventBase


class VoiceStateSnapshot(_EventBase):
    """Bare snapshot published by voice-signaling on participant join/leave.

    No ``op`` field — the listener tags it as ``voice_state`` and adds
    enriched ``user_states`` (per-user mic_muted/deafened) from Redis
    before fan-out. ``streaming_user_ids`` enumerates which members are
    currently browser-screen-sharing (the LiveKit ``track_published``
    side, not the HQ-stream one). ``camera_user_ids`` enumerates members
    publishing a webcam track — tracked server-side so out-of-channel
    members get the "cam on" indicator too (mirrors screen-share), not
    just clients connected to the LiveKit room.
    """

    channel_id: str
    user_ids: list[str]
    streaming_user_ids: list[str] = []
    camera_user_ids: list[str] = []


class VoiceDisconnectEvent(_EventBase):
    """Admin disconnected ``user_id`` from a voice channel."""

    op: Literal["voice_disconnect"] = "voice_disconnect"
    channel_id: str
    user_id: str


class VoiceMoveEvent(_EventBase):
    """Admin relocated ``user_id`` from ``channel_id`` (source) to
    ``target_channel_id`` (destination) within the same guild.

    There is no server-side "move between rooms" — each voice channel is
    its own LiveKit room. This event is the *signal*: the target's own
    client picks it up and reconnects to the destination room with a
    freshly-minted token (CONNECT permission for the destination is
    enforced at that token-issue). Cooperative, like the soft-deafen
    path — a client that ignores it simply stays put."""

    op: Literal["voice_move"] = "voice_move"
    channel_id: str
    user_id: str
    target_channel_id: str


class VoiceOverrideEvent(_EventBase):
    """Admin force-mute / force-deafen toggle. The current values are
    the *resulting* state after the toggle, not a diff."""

    op: Literal["voice_override"] = "voice_override"
    channel_id: str
    user_id: str
    muted: bool
    deafened: bool


class VoicePullEvent(_EventBase):
    """A channel manager "pulled" ``user_id`` into the private voice
    channel ``channel_id``. Delivered direct-to-user via ``user:events``
    (NOT ``voice:events``) because the target cannot VIEW_CHANNEL the
    private channel yet, so the view-channel filter would drop it.

    Cooperative, like ``voice_move``: the target's own client picks it
    up and connects. A freshly-minted VIEW_CHANNEL|CONNECT user-overwrite
    (tracked in ``channel_voice_pulls``) admits them; it is revoked again
    when they leave the channel."""

    op: Literal["voice_pull"] = "voice_pull"
    user_id: str
    channel_id: str
    channel_name: str
    guild_id: str
    pulled_by: str
