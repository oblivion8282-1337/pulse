"""Pydantic schemas for REST endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_serializer


def _id_str(value: int) -> str:
    return str(value)


def _coerce_id(value: object) -> int:
    """Accept snowflake IDs as int or string.

    JavaScript clients must pass IDs as strings because Number can't
    represent >2^53 without precision loss. We accept both forms so the
    Python tests stay ergonomic.
    """
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"expected int or string id, got {type(value).__name__}")


SnowflakeId = Annotated[int, BeforeValidator(_coerce_id)]


class GuildIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    icon_url: Annotated[str | None, Field(default=None, max_length=512)] = None


class GuildOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    icon_url: str | None
    owner_id: int
    created_at: datetime

    @field_serializer("id", "owner_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class GuildPatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    icon_url: Annotated[str | None, Field(default=None, max_length=512)] = None


class ChannelIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    type: Annotated[int, Field(ge=0, le=1)] = 0
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None
    position: int = 0


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    guild_id: int
    name: str
    type: int
    position: int
    topic: str | None
    created_at: datetime

    @field_serializer("id", "guild_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class ChannelPatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None


class MessageIn(BaseModel):
    content: Annotated[str, Field(min_length=1, max_length=4000)]
    nonce: Annotated[str | None, Field(default=None, max_length=64)] = None
    reply_to_id: SnowflakeId | None = None


class MessageEditIn(BaseModel):
    content: Annotated[str, Field(min_length=1, max_length=4000)]


class ReactionAggregate(BaseModel):
    """One row per (message, emoji); `count` aggregates users, `me` is whether
    the current caller is one of them."""

    emoji: str
    count: int
    me: bool


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    channel_id: int
    author_id: int
    content: str
    nonce: str | None
    reply_to_id: int | None = None
    created_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None
    reactions: list[ReactionAggregate] = []

    @field_serializer("id", "channel_id", "author_id", "reply_to_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class MemberIn(BaseModel):
    user_id: SnowflakeId


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    guild_id: int
    user_id: int
    nickname: str | None
    joined_at: datetime

    @field_serializer("guild_id", "user_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


# ---- Invites ---------------------------------------------------------------

_MAX_INVITE_TTL = 30 * 24 * 3600  # 30 days


class CreateInviteIn(BaseModel):
    expires_in_seconds: Annotated[int | None, Field(default=None, ge=60, le=_MAX_INVITE_TTL)] = None
    max_uses: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    channel_id: SnowflakeId | None = None


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    guild_id: int
    channel_id: int | None
    max_uses: int | None
    uses: int
    expires_at: datetime | None
    created_at: datetime

    @field_serializer("guild_id", "channel_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class InviteGuildOut(BaseModel):
    id: int
    name: str
    icon_url: str | None

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class InvitePreviewOut(BaseModel):
    guild: InviteGuildOut
    channel_id: int | None
    member_count: int

    @field_serializer("channel_id")
    def _ser_channel(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class InviteAcceptOut(BaseModel):
    guild: InviteGuildOut
    channel_id: int | None

    @field_serializer("channel_id")
    def _ser_channel(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None
