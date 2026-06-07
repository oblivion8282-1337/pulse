"""SQLAlchemy models for the chat-gateway.

Split into one file per domain group to keep each below the 350-line
soft cap (PLAN.md §12.1). Importers can keep using
``from dcc_chat_gateway.models import X`` — every model is re-exported
here.
"""

from dcc_chat_gateway.models.admin import AdminAuditLog, ChatSettings
from dcc_chat_gateway.models.moderation import CachedUserProfile, ModAuditLog, Report
from dcc_chat_gateway.models.channels import (
    CHANNEL_TYPE_TEXT,
    CHANNEL_TYPE_VOICE,
    Channel,
    DirectMessageChannel,
)
from dcc_chat_gateway.models.community_invites import CommunityInvite
from dcc_chat_gateway.models.friendships import (
    FriendRequest,
    Friendship,
    UserBlock,
    UserPrivacy,
)
from dcc_chat_gateway.models.guilds import Guild, GuildBan, GuildInvite, GuildMember
from dcc_chat_gateway.models.membership import InstanceJoinInvite, InstanceMember
from dcc_chat_gateway.models.messages import (
    MENTION_EVERYONE_TARGET_ID,
    MENTION_TYPE_EVERYONE,
    MENTION_TYPE_ROLE,
    MENTION_TYPE_USER,
    Message,
    MessageAttachment,
    MessageMention,
    MessageReaction,
)
from dcc_chat_gateway.models.notifications import WebPushSubscription
from dcc_chat_gateway.models.plugin_activation import (
    GuildPlugin,
    GuildPluginState,
    InstancePluginAllowlist,
)
from dcc_chat_gateway.models.roles import MemberRole, PermissionOverwrite, Role
from dcc_chat_gateway.models.sounds import GuildSoundOverride
from dcc_chat_gateway.models.user_preferences import UserPreference

__all__ = [
    "CachedUserProfile",
    "ModAuditLog",
    "Report",
    "CHANNEL_TYPE_TEXT",
    "CHANNEL_TYPE_VOICE",
    "CommunityInvite",
    "MENTION_EVERYONE_TARGET_ID",
    "MENTION_TYPE_EVERYONE",
    "MENTION_TYPE_ROLE",
    "MENTION_TYPE_USER",
    "AdminAuditLog",
    "Channel",
    "ChatSettings",
    "DirectMessageChannel",
    "FriendRequest",
    "Friendship",
    "Guild",
    "GuildBan",
    "GuildInvite",
    "GuildMember",
    "GuildPlugin",
    "GuildPluginState",
    "GuildSoundOverride",
    "InstanceJoinInvite",
    "InstanceMember",
    "InstancePluginAllowlist",
    "MemberRole",
    "Message",
    "MessageAttachment",
    "MessageMention",
    "MessageReaction",
    "PermissionOverwrite",
    "Role",
    "UserBlock",
    "UserPreference",
    "UserPrivacy",
    "WebPushSubscription",
]
