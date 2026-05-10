"""Pydantic request/response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_serializer

# Username allows letters, digits, underscore, dot, dash; 3..32.
USERNAME_PATTERN = r"^[a-zA-Z0-9_.-]{3,32}$"


class RegisterIn(BaseModel):
    username: Annotated[str, Field(pattern=USERNAME_PATTERN)]
    email: EmailStr
    password: Annotated[str, Field(min_length=8, max_length=128)]
    display_name: Annotated[str | None, Field(default=None, max_length=64)] = None


class LoginIn(BaseModel):
    email_or_username: Annotated[str, Field(min_length=3, max_length=255)]
    password: Annotated[str, Field(min_length=1, max_length=128)]


class RefreshIn(BaseModel):
    refresh_token: str


class TokensOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: EmailStr
    display_name: str | None = None
    avatar_url: str | None = None
    created_at: datetime

    @field_serializer("id")
    def _id_to_str(self, value: int) -> str:
        # Snowflake IDs are 64-bit; emit as string to avoid JS precision loss.
        return str(value)


class MessageOut(BaseModel):
    detail: str
