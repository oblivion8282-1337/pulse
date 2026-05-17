"""Pydantic request/response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

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
    refresh_token: Annotated[str, Field(max_length=4096)]


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
    is_admin: bool = False
    disabled: bool = False
    created_at: datetime

    @field_serializer("id")
    def _id_to_str(self, value: int) -> str:
        # Snowflake IDs are 64-bit; emit as string to avoid JS precision loss.
        return str(value)


class UserSummary(BaseModel):
    """Public user info without email — safe to return to any authenticated caller."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str | None = None
    avatar_url: str | None = None

    @field_serializer("id")
    def _id_to_str(self, value: int) -> str:
        return str(value)


class MessageOut(BaseModel):
    detail: str


# ---- Admin --------------------------------------------------------------

RegistrationMode = Literal["open", "invite_only", "closed"]


class UserAdminOut(BaseModel):
    """Full user record for the admin panel — includes email, is_admin, disabled."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: EmailStr
    display_name: str | None = None
    avatar_url: str | None = None
    is_admin: bool
    disabled: bool
    created_at: datetime

    @field_serializer("id")
    def _id_to_str(self, value: int) -> str:
        return str(value)


class UserAdminPatch(BaseModel):
    """Partial-update for admin user actions. Either field omitted = no change."""

    is_admin: bool | None = None
    disabled: bool | None = None


class AuthSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    registration_mode: RegistrationMode


class AuthSettingsPatch(BaseModel):
    registration_mode: RegistrationMode


class AdminStatsOut(BaseModel):
    """Auth-svc slice of the admin Übersicht-Tab. chat-gateway emits its own
    counts under its ``/admin/stats``; the UI merges them."""

    user_count: int
    admin_count: int
    disabled_count: int


class AdminAuditLogEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    actor_id: int
    action: str
    target_id: int | None
    payload: dict
    created_at: datetime

    @field_serializer("id", "actor_id", "target_id")
    def _ids_to_str(self, value: int | None) -> str | None:
        return str(value) if value is not None else None
