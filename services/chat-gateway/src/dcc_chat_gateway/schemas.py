"""Pydantic schemas for REST endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_serializer


def _id_str(value: int) -> str:
    return str(value)


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


class MessageIn(BaseModel):
    content: Annotated[str, Field(min_length=1, max_length=4000)]
    nonce: Annotated[str | None, Field(default=None, max_length=64)] = None


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    channel_id: int
    author_id: int
    content: str
    nonce: str | None
    created_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None

    @field_serializer("id", "channel_id", "author_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class MemberIn(BaseModel):
    user_id: int


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    guild_id: int
    user_id: int
    nickname: str | None
    joined_at: datetime

    @field_serializer("guild_id", "user_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)
