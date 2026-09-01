"""Chat-channel + cross-channel notification events.

These envelopes carry their own ``op`` and are published either on
``chat:channel:<id>`` (per-channel; rebroadcast verbatim by the listener)
or on ``user:events`` (direct-delivery to one specific user).

Wire-format note: snowflake IDs are always strings. Frontend reads these
as plain JSON; nothing here parses the IDs into ints, so client-side
``BigInt`` math stays viable.
"""

from __future__ import annotations

from typing import Any, Literal

from dcc_shared.events._base import _EventBase


# ---- Per-channel (chat:channel:<id>) ---------------------------------------


class MessageEvent(_EventBase):
    """``op="message"`` — a freshly posted chat message.

    The ``data`` payload is the full ``MessageOut`` wire shape (see
    ``message_helpers.serialize_message``). We keep it as a free-form
    dict here: ``MessageOut`` lives in chat-gateway (with attachment +
    reaction sub-shapes), and pulling it into shared would invert the
    dependency. The listener's `_listen` legacy auto-wrap path (bare
    payload → ``{"op": "message", "data": payload}``) only triggers when
    publishers DON'T construct this envelope — once migrated they
    always emit the full op envelope.
    """

    op: Literal["message"] = "message"
    data: dict[str, Any]


class MessageUpdateEvent(_EventBase):
    op: Literal["message_update"] = "message_update"
    data: dict[str, Any]


class MessageDeleteData(_EventBase):
    id: str
    channel_id: str


class MessageDeleteEvent(_EventBase):
    op: Literal["message_delete"] = "message_delete"
    data: MessageDeleteData


class ReactionData(_EventBase):
    message_id: str
    channel_id: str
    user_id: str
    emoji: str


class ReactionAddEvent(_EventBase):
    op: Literal["reaction_add"] = "reaction_add"
    data: ReactionData


class ReactionRemoveEvent(_EventBase):
    op: Literal["reaction_remove"] = "reaction_remove"
    data: ReactionData


class PinUpdateData(_EventBase):
    message_id: str
    channel_id: str
    pinned: bool


class PinUpdateEvent(_EventBase):
    """``op="pin_update"`` — eine Kanalnachricht wurde angepinnt/gelöst.
    An alle Kanal-Abonnenten, damit niemand reloaden muss. Gelöschte
    Nachrichten verlieren ihren Pin serverseitig; der Client räumt seine
    Pin-Liste bereits im ``message_delete``-Handler auf."""

    op: Literal["pin_update"] = "pin_update"
    data: PinUpdateData


class StreamChatMessagePayload(_EventBase):
    id: str
    author_id: str
    content: str
    created_at: str


class StreamChatMessageEvent(_EventBase):
    """``op="stream_chat_message"`` — chat message inside an HQ-stream's
    sidebar chat. Fanned out via the per-channel chat pubsub (so the
    existing VIEW_CHANNEL filter applies)."""

    op: Literal["stream_chat_message"] = "stream_chat_message"
    channel_id: str
    streamer_id: str
    message: StreamChatMessagePayload


class WatchChatMessageEvent(_EventBase):
    """``op="watch_chat_message"`` — chat message in a watch-party
    sidebar chat. Fanned out on the same per-channel pubsub for the
    voice channel hosting the party. ``party_id`` routes it to the right
    one of the channel's possibly several concurrent parties."""

    op: Literal["watch_chat_message"] = "watch_chat_message"
    channel_id: str
    party_id: str
    message: StreamChatMessagePayload


class WatchChatReactionData(_EventBase):
    message_id: str
    channel_id: str
    party_id: str
    user_id: str
    emoji: str
    added: bool


class WatchChatReactionEvent(_EventBase):
    """``op="watch_chat_reaction"`` — a single user toggled an emoji
    reaction on a watch-party chat message. Ephemeral (Redis-backed,
    no DB). Fanned out on the same per-channel pubsub as the messages.

    Per-user delta (``user_id`` + ``added``) mirrors the normal chat's
    ``reaction_add``/``reaction_remove``: each client folds it into the
    message's aggregate and derives ``me`` from its own user id."""

    op: Literal["watch_chat_reaction"] = "watch_chat_reaction"
    data: WatchChatReactionData


# ---- Cross-channel notifications (user:events / guild:events) --------------


class ChannelBumpEvent(_EventBase):
    """``op="channel_bump"`` — minimal "channel had activity" ping.

    Published on guild:events so clients NOT subscribed to the
    originating channel can flag it unread in the sidebar. Payload is
    intentionally body-less (no content) — VIEW_CHANNEL filtering
    happens in the listener.
    """

    op: Literal["channel_bump"] = "channel_bump"
    guild_id: str
    channel_id: str
    message_id: str
    author_id: str


class DmBumpEvent(_EventBase):
    """DM equivalent of ``channel_bump``. ``user_a_id``/``user_b_id``
    let each receiving client decide locally whether it's a member —
    no server-side per-user routing in Phase 1."""

    op: Literal["dm_bump"] = "dm_bump"
    channel_id: str
    user_a_id: str
    user_b_id: str
    message_id: str
    author_id: str


class TypingEvent(_EventBase):
    """``op="typing"`` — ephemeral "user is typing" ping on a channel.

    No persistence, no body. Broadcast to the channel's subscribers
    (VIEW_CHANNEL-filtered in the listener); each client keeps the sender
    "typing" for a short TTL and ignores its own echo."""

    op: Literal["typing"] = "typing"
    channel_id: str
    user_id: str


class MentionAddedData(_EventBase):
    channel_id: str
    message_id: str
    guild_id: str | None = None


class MentionAddedEvent(_EventBase):
    """``op="mention_added"`` — direct-delivery to each mentioned user
    via user:events. Drives the unread/mention counter even when the
    target has the channel closed (cross-channel ping)."""

    op: Literal["mention_added"] = "mention_added"
    data: MentionAddedData
