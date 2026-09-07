"""Event-Schema-Registry für Pulse Redis Pub/Sub-Events.

Single source of truth for every WebSocket envelope that flows over a
Redis pub/sub channel. Publishers (REST routes, ws ops, voice-signaling,
media-svc) construct one of the ``*Event`` / ``*Snapshot`` models;
subscribers (chat-gateway's listener) validate the incoming dict against
this registry.

# Channel → ops map (the "where can which op show up" inventory)

* ``chat:channel:<id>`` (per-channel pubsub; listener auto-wraps bare
  message dicts as ``op="message"``):
    - ``message``, ``message_update``, ``message_delete``
    - ``reaction_add``, ``reaction_remove``
    - ``stream_chat_message``, ``watch_chat_message``
    - ``watch_chat_reaction``
    - ``postfach_neu`` (verschluesseltes Postfach, Etappe D — inhaltsloser
      Weckruf, traegt Kanal + Anzahl, nie einen Umschlag)

* ``user:events`` (direct-delivery to one user — wrapper adds
  ``_target_user_id`` for routing, stripped by listener):
    - ``mention_added``
    - ``friend_request_received`` / ``friend_request_accepted``
      / ``friend_request_declined`` / ``friend_request_cancelled``
    - ``friend_removed``
    - ``user_blocked`` / ``user_unblocked``
    - ``presence_status_changed`` (sender's own sockets, real status)
    - ``voice_pull`` (target user brought into a voice channel — switch
      or summon; delivered direct because the target may lack VIEW_CHANNEL)
    - ``channel_revealed`` / ``channel_hidden`` (voice-pull grant
      added/revoked — channel appears/leaves that one user's list)
    - ``guild_membership_revoked`` (you were banned/kicked — carries the
      guild name + private ban reason so the client can tell you)
    - ``guild_ban_lifted`` (your ban was lifted — carries a one-click
      rejoin invite)

* ``guild:events`` (wide broadcast; listener filters by guild membership):
    - ``channel_created`` / ``channel_updated`` / ``channel_deleted``
    - ``channel_permissions_updated``
    - ``guild_updated`` / ``guild_deleted``
    - ``guild_member_added`` / ``guild_member_updated`` /
      ``guild_member_removed``
    - ``guild_ban_added`` / ``guild_ban_removed``
    - ``role_created`` / ``role_updated`` / ``role_deleted``
    - ``member_roles_updated``
    - ``permissions_updated``
    - ``guild_sound_updated``
    - ``guild_plugins_changed``
    - ``channel_bump`` / ``dm_bump``
    - ``presence_update``
    - ``presence_status_changed`` (everyone else, masked; carries
      ``_sender_user_id`` for listener filtering)

* ``voice:events`` (mixed: bare snapshot AND op envelopes):
    - bare snapshot ``VoiceStateSnapshot`` — listener tags as ``voice_state``
    - ``voice_disconnect``, ``voice_override`` — listener forwards verbatim

* ``stream:events`` (always bare; listener tags as ``stream_state``):
    - bare snapshot ``StreamStateSnapshot``

* ``watch:events`` (always bare; listener tags as ``watch_state``):
    - bare snapshot ``WatchStateSnapshot``

The registry below holds *only* op-discriminated envelopes. Bare-snapshot
shapes are exported for type hints but live outside ``EVENT_REGISTRY`` —
they don't carry the discriminator the registry keys on.
"""

from __future__ import annotations

from dcc_shared.events._base import _EventBase
from dcc_shared.events.applications import ApplicationDecidedEvent
from dcc_shared.events.chat import (
    ChannelBumpEvent,
    DmBumpEvent,
    MentionAddedData,
    MentionAddedEvent,
    MessageDeleteData,
    MessageDeleteEvent,
    MessageEvent,
    MessageUpdateEvent,
    PinUpdateData,
    PinUpdateEvent,
    PostfachNeuEvent,
    ReactionAddEvent,
    ReactionData,
    ReactionRemoveEvent,
    StreamChatMessageEvent,
    StreamChatMessagePayload,
    StreamReactionData,
    StreamReactionEvent,
    TypingEvent,
    WatchChatMessageEvent,
    WatchChatReactionData,
    WatchChatReactionEvent,
)
from dcc_shared.events.community import CommunityInviteReceivedEvent
from dcc_shared.events.friends import (
    FriendRemovedEvent,
    FriendRequestAcceptedEvent,
    FriendRequestCancelledEvent,
    FriendRequestDeclinedEvent,
    FriendRequestReceivedEvent,
    UserBlockedEvent,
    UserUnblockedEvent,
)
from dcc_shared.events.guild import (
    ChannelCreatedEvent,
    ChannelDeletedEvent,
    ChannelHiddenEvent,
    ChannelPermissionsUpdatedEvent,
    ChannelRevealedEvent,
    ChannelUpdatedEvent,
    ComplaintNewEvent,
    DropboxEntryCreatedEvent,
    DropboxEntryDeletedEvent,
    DropboxEntryPurgedEvent,
    DropboxEntryRestoredEvent,
    DropboxEntryUpdatedEvent,
    DropboxQuotaUpdatedEvent,
    GuildBanAddedEvent,
    GuildBanLiftedEvent,
    GuildBanRemovedEvent,
    GuildDeletedEvent,
    GuildMemberAddedEvent,
    GuildMemberRemovedEvent,
    GuildMembershipRevokedEvent,
    GuildMemberUpdatedEvent,
    DeviceChangedEvent,
    DeviceStateEvent,
    GuildPluginsChangedEvent,
    GuildSoundUpdatedEvent,
    GuildUpdatedEvent,
    MemberRolesUpdatedEvent,
    PermissionsUpdatedEvent,
    ReportNewEvent,
    RoleCreatedEvent,
    RoleDeletedEvent,
    RoleUpdatedEvent,
)
from dcc_shared.events.presence import (
    PresenceStatusChangedEvent,
    PresenceStatusData,
    PresenceUpdateEvent,
)
from dcc_shared.events.stream import StreamDescriptor, StreamStateSnapshot, WatchStateSnapshot
from dcc_shared.events.voice import (
    VoiceDisconnectEvent,
    VoiceOverrideEvent,
    VoicePullEvent,
    VoiceStateSnapshot,
)

# Master registry — op-code → model class. Used by the listener to
# validate every inbound envelope before fan-out. Bare-snapshot shapes
# (VoiceStateSnapshot, StreamStateSnapshot, WatchStateSnapshot) are
# NOT in here — they don't carry an ``op`` discriminator.
EVENT_REGISTRY: dict[str, type[_EventBase]] = {
    # ---- chat-channel envelopes
    "message": MessageEvent,
    "message_update": MessageUpdateEvent,
    "message_delete": MessageDeleteEvent,
    "reaction_add": ReactionAddEvent,
    "reaction_remove": ReactionRemoveEvent,
    "stream_chat_message": StreamChatMessageEvent,
    "stream_reaction": StreamReactionEvent,
    "watch_chat_message": WatchChatMessageEvent,
    "watch_chat_reaction": WatchChatReactionEvent,
    # ---- channel-bump / dm-bump (cross-channel notification)
    "channel_bump": ChannelBumpEvent,
    "dm_bump": DmBumpEvent,
    # ---- ephemeral typing indicator
    "typing": TypingEvent,
    # ---- pinned messages (chat-channel)
    "pin_update": PinUpdateEvent,
    # ---- Postfach-Weckruf (Etappe D, E2E-DM)
    "postfach_neu": PostfachNeuEvent,
    # ---- direct-delivery (user:events)
    "mention_added": MentionAddedEvent,
    "application_decided": ApplicationDecidedEvent,
    "friend_request_received": FriendRequestReceivedEvent,
    "friend_request_accepted": FriendRequestAcceptedEvent,
    "friend_request_declined": FriendRequestDeclinedEvent,
    "friend_request_cancelled": FriendRequestCancelledEvent,
    "friend_removed": FriendRemovedEvent,
    "user_blocked": UserBlockedEvent,
    "user_unblocked": UserUnblockedEvent,
    # ---- community-invite broker (B-lite, cloud-only)
    "community_invite_received": CommunityInviteReceivedEvent,
    # ---- guild lifecycle
    "channel_created": ChannelCreatedEvent,
    "channel_updated": ChannelUpdatedEvent,
    "channel_deleted": ChannelDeletedEvent,
    "channel_revealed": ChannelRevealedEvent,
    "channel_hidden": ChannelHiddenEvent,
    "channel_permissions_updated": ChannelPermissionsUpdatedEvent,
    "guild_updated": GuildUpdatedEvent,
    "guild_deleted": GuildDeletedEvent,
    "guild_member_added": GuildMemberAddedEvent,
    "guild_member_updated": GuildMemberUpdatedEvent,
    "guild_member_removed": GuildMemberRemovedEvent,
    "guild_ban_added": GuildBanAddedEvent,
    "guild_ban_removed": GuildBanRemovedEvent,
    "role_created": RoleCreatedEvent,
    "role_updated": RoleUpdatedEvent,
    "role_deleted": RoleDeletedEvent,
    "member_roles_updated": MemberRolesUpdatedEvent,
    "permissions_updated": PermissionsUpdatedEvent,
    "guild_sound_updated": GuildSoundUpdatedEvent,
    "guild_plugins_changed": GuildPluginsChangedEvent,
    "device_changed": DeviceChangedEvent,
    "device_state": DeviceStateEvent,
    "report_new": ReportNewEvent,
    "guild_membership_revoked": GuildMembershipRevokedEvent,
    "guild_ban_lifted": GuildBanLiftedEvent,
    "complaint_new": ComplaintNewEvent,
    "dropbox_entry_created": DropboxEntryCreatedEvent,
    "dropbox_entry_updated": DropboxEntryUpdatedEvent,
    "dropbox_entry_deleted": DropboxEntryDeletedEvent,
    "dropbox_entry_restored": DropboxEntryRestoredEvent,
    "dropbox_entry_purged": DropboxEntryPurgedEvent,
    "dropbox_quota_updated": DropboxQuotaUpdatedEvent,
    # ---- presence
    "presence_update": PresenceUpdateEvent,
    "presence_status_changed": PresenceStatusChangedEvent,
    # ---- voice (admin overrides; the voice_state snapshot is bare)
    "voice_disconnect": VoiceDisconnectEvent,
    "voice_override": VoiceOverrideEvent,
    "voice_pull": VoicePullEvent,
}


__all__ = [
    "EVENT_REGISTRY",
    "_EventBase",
    # community-invite broker
    "CommunityInviteReceivedEvent",
    # chat
    "ChannelBumpEvent",
    "DmBumpEvent",
    "MentionAddedData",
    "MentionAddedEvent",
    "MessageDeleteData",
    "MessageDeleteEvent",
    "MessageEvent",
    "MessageUpdateEvent",
    "PinUpdateData",
    "PinUpdateEvent",
    "PostfachNeuEvent",
    "ReactionAddEvent",
    "ReactionData",
    "ReactionRemoveEvent",
    "StreamChatMessageEvent",
    "StreamChatMessagePayload",
    "TypingEvent",
    "WatchChatMessageEvent",
    "WatchChatReactionData",
    "WatchChatReactionEvent",
    "StreamReactionData",
    "StreamReactionEvent",
    # friends
    "ApplicationDecidedEvent",
    "FriendRemovedEvent",
    "FriendRequestAcceptedEvent",
    "FriendRequestCancelledEvent",
    "FriendRequestDeclinedEvent",
    "FriendRequestReceivedEvent",
    "UserBlockedEvent",
    "UserUnblockedEvent",
    # guild
    "ChannelCreatedEvent",
    "ChannelDeletedEvent",
    "ChannelHiddenEvent",
    "ChannelPermissionsUpdatedEvent",
    "ChannelRevealedEvent",
    "ChannelUpdatedEvent",
    "DropboxEntryCreatedEvent",
    "DropboxEntryDeletedEvent",
    "DropboxEntryPurgedEvent",
    "DropboxEntryRestoredEvent",
    "DropboxEntryUpdatedEvent",
    "DropboxQuotaUpdatedEvent",
    "GuildBanAddedEvent",
    "GuildBanRemovedEvent",
    "GuildDeletedEvent",
    "GuildMemberAddedEvent",
    "GuildMemberRemovedEvent",
    "GuildMemberUpdatedEvent",
    "DeviceChangedEvent",
    "DeviceStateEvent",
    "GuildPluginsChangedEvent",
    "GuildSoundUpdatedEvent",
    "GuildUpdatedEvent",
    "MemberRolesUpdatedEvent",
    "PermissionsUpdatedEvent",
    "ComplaintNewEvent",
    "GuildBanLiftedEvent",
    "GuildMembershipRevokedEvent",
    "ReportNewEvent",
    "RoleCreatedEvent",
    "RoleDeletedEvent",
    "RoleUpdatedEvent",
    # presence
    "PresenceStatusChangedEvent",
    "PresenceStatusData",
    "PresenceUpdateEvent",
    # stream + watch (bare snapshots)
    "StreamDescriptor",
    "StreamStateSnapshot",
    "WatchStateSnapshot",
    # voice
    "VoiceDisconnectEvent",
    "VoiceOverrideEvent",
    "VoicePullEvent",
    "VoiceStateSnapshot",
]
