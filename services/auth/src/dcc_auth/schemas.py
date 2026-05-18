"""Pydantic request/response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_serializer

# Username allows letters, digits, underscore, dot, dash; 3..32.
USERNAME_PATTERN = r"^[a-zA-Z0-9_.-]{3,32}$"

# TOTP codes are 6 numeric digits in the RFC 6238 default config that pyotp
# uses. Backup codes are 8 hex chars (uppercase). The schemas accept the
# slightly looser shapes so a user copying with a stray space still validates.
TOTP_CODE_PATTERN = r"^\d{6}$"
BACKUP_CODE_PATTERN = r"^[0-9A-Fa-f]{8}$"


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
    # Account-recovery / 2FA state — the frontend needs both to drive the
    # "verify your email" banner and the "2FA enabled" badge on /me.
    email_verified_at: datetime | None = None
    totp_enabled: bool = False
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


# ---- Account recovery / 2FA ---------------------------------------------


class PasswordForgotIn(BaseModel):
    email_or_username: Annotated[str, Field(min_length=3, max_length=255)]


class PasswordResetIn(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=128)]
    new_password: Annotated[str, Field(min_length=8, max_length=128)]


class EmailVerifyConfirmIn(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=128)]


class TotpSetupOut(BaseModel):
    secret: str
    qr_png_base64: str
    provisioning_uri: str


class TotpVerifySetupIn(BaseModel):
    code: Annotated[str, Field(pattern=TOTP_CODE_PATTERN)]


class TotpVerifySetupOut(BaseModel):
    backup_codes: list[str]


class TotpDisableIn(BaseModel):
    password: Annotated[str, Field(min_length=1, max_length=128)]
    code: Annotated[str | None, Field(default=None, pattern=TOTP_CODE_PATTERN)] = None
    backup_code: Annotated[
        str | None, Field(default=None, pattern=BACKUP_CODE_PATTERN)
    ] = None


class TotpBackupRegenIn(BaseModel):
    password: Annotated[str, Field(min_length=1, max_length=128)]
    code: Annotated[str, Field(pattern=TOTP_CODE_PATTERN)]


class LoginTotpIn(BaseModel):
    mfa_ticket: Annotated[str, Field(min_length=10, max_length=4096)]
    code: Annotated[str | None, Field(default=None, pattern=TOTP_CODE_PATTERN)] = None
    backup_code: Annotated[
        str | None, Field(default=None, pattern=BACKUP_CODE_PATTERN)
    ] = None


class LoginMfaPending(BaseModel):
    """First-step response when the account has 2FA enabled.

    Frontend gates the second step (``POST /login/totp``) on the presence of
    ``requires_totp`` — a regular ``TokensOut`` lacks that field. Using a
    discriminated union in the route signature (``TokensOut | LoginMfaPending``)
    is how the OpenAPI schema makes that contract explicit.
    """

    requires_totp: Literal[True] = True
    mfa_ticket: str
