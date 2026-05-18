"""SQLAlchemy models for the chat-gateway.

Split into one file per domain group to keep each below the 350-line
soft cap (PLAN.md §12.1). Importers can keep using
``from dcc_chat_gateway.models import X`` — every model is re-exported
here.
"""

from dcc_chat_gateway.models.admin import AdminAuditLog, ChatSettings
from dcc_chat_gateway.models.channels import (
    CHANNEL_TYPE_TEXT,
    CHANNEL_TYPE_VOICE,
    Channel,
    DirectMessageChannel,
)
from dcc_chat_gateway.models.guilds import Guild, GuildBan, GuildInvite, GuildMember
from dcc_chat_gateway.models.messages import (
    Message,
    MessageAttachment,
    MessageReaction,
)
from dcc_chat_gateway.models.roles import MemberRole, PermissionOverwrite, Role

__all__ = [
    "CHANNEL_TYPE_TEXT",
    "CHANNEL_TYPE_VOICE",
    "AdminAuditLog",
    "Channel",
    "ChatSettings",
    "DirectMessageChannel",
    "Guild",
    "GuildBan",
    "GuildInvite",
    "GuildMember",
    "MemberRole",
    "Message",
    "MessageAttachment",
    "MessageReaction",
    "PermissionOverwrite",
    "Role",
]
