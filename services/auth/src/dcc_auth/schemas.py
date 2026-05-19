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


SmtpProvider = Literal["brevo", "mailgun", "resend", "gmail", "custom"]


class SmtpSettingsOut(BaseModel):
    """Admin-facing view of the SMTP config singleton.

    ``has_password`` reflects only "is a password stored?" — the plaintext
    or ciphertext is never sent over the wire. The admin re-types the
    password to change it; sending an empty/null password on PATCH means
    "leave the existing password alone", so the UI can pre-fill all other
    fields without clobbering the secret on every save.
    """

    model_config = ConfigDict(from_attributes=True)

    provider: SmtpProvider
    host: str | None
    port: int
    username: str | None
    from_email: str | None
    use_ssl: bool
    configured: bool
    has_password: bool


class SmtpSettingsPatch(BaseModel):
    """Partial-update payload for ``PATCH /admin/smtp``.

    Mirrors the columns 1:1 plus a separate ``password`` plaintext-field.
    Omitting ``password`` (or sending null) preserves the existing
    ciphertext. Sending an empty string explicitly clears it.
    """

    provider: SmtpProvider
    host: Annotated[str | None, Field(default=None, max_length=255)] = None
    port: Annotated[int, Field(ge=1, le=65535)] = 587
    username: Annotated[str | None, Field(default=None, max_length=255)] = None
    password: Annotated[str | None, Field(default=None, max_length=1024)] = None
    from_email: Annotated[EmailStr | None, Field(default=None)] = None
    use_ssl: bool = False


class SmtpTestIn(BaseModel):
    """Body for ``POST /admin/smtp/test``: send a one-shot test mail.

    The full config can be passed inline so the admin can hit "Test" before
    the first Save (no DB row yet). When ``provider`` etc. are omitted, the
    saved row is used.
    """

    to: EmailStr
    provider: SmtpProvider | None = None
    host: Annotated[str | None, Field(default=None, max_length=255)] = None
    port: Annotated[int | None, Field(default=None, ge=1, le=65535)] = None
    username: Annotated[str | None, Field(default=None, max_length=255)] = None
    password: Annotated[str | None, Field(default=None, max_length=1024)] = None
    from_email: Annotated[EmailStr | None, Field(default=None)] = None
    use_ssl: bool | None = None


class SmtpTestOut(BaseModel):
    """Result of a test-mail send. ``ok=false`` carries an admin-readable
    error string (sanitised; no plaintext-secret echo)."""

    ok: bool
    error: str | None = None


class AdminStatsOut(BaseModel):
    """Auth-svc slice of the admin Übersicht-Tab. chat-gateway emits its own
    counts under its ``/admin/stats``; the UI merges them."""

    user_count: int
    admin_count: int
    disabled_count: int


class BackupStatusOut(BaseModel):
    """Read-only status of the restic backup sidecar.

    Reads the marker file at ``backup_marker_path`` (written by
    ``infra/prod/backup/backup.sh::mark_ok`` on every successful run, and
    touched by its entrypoint on container start). The endpoint never
    *triggers* backups — that's deliberately CLI-only; see
    ``infra/prod/backup/restore.md``.

    * ``configured=False`` — the volume isn't mounted, i.e. backup sidecar
      not deployed (dev environments, fresh self-hosters before setup).
    * ``configured=True``, ``last_backup_at=None`` — volume mounted but
      no run has succeeded yet (within ``start_period`` of fresh deploy).
    * ``configured=True``, ``last_backup_at=...`` — most recent success;
      ``healthy`` flips ``false`` once ``age_seconds`` exceeds the stale
      threshold (default 36 h, matching the compose healthcheck)."""

    configured: bool
    last_backup_at: str | None
    age_seconds: int | None
    healthy: bool
    stale_threshold_seconds: int


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


# ---- Active sessions / refresh-token introspection ---------------------


class SessionOut(BaseModel):
    """One active refresh-token row, surfaced to the owner's UI.

    ``id`` is the refresh-token's ``jti`` UUID rendered as its canonical
    string form (matches the rest of the auth API where DB IDs cross the
    wire as strings). ``ip_hash_prefix`` is the first 8 hex chars of the
    full SHA-256 — enough for the UI to diff "same source" between
    sessions without exposing more of the hash than needed.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    user_agent: str | None = None
    created_at: datetime
    last_used_at: datetime | None = None
    is_current: bool = False
    ip_hash_prefix: str | None = None


class SessionsRevokeAllOut(BaseModel):
    revoked_count: int


# ---- Account delete -----------------------------------------------------


class AccountDeleteIn(BaseModel):
    """Self-service hard-delete payload.

    Three gates stacked on top of the bearer-token requirement:
      * ``password`` — proves a stolen access token alone can't nuke an
        account.
      * ``code`` / ``backup_code`` — second-factor; *consumed* when 2FA is
        enabled, ignored otherwise. Validation mirrors ``TotpDisableIn``.
      * ``confirm_username`` — typed re-entry of the user's exact username
        (case-sensitive). Anti-misclick gate; UI surfaces the requested
        username so an account-recovery scenario "type your username to
        confirm" makes sense.
    """

    password: Annotated[str, Field(min_length=1, max_length=128)]
    code: Annotated[str | None, Field(default=None, pattern=TOTP_CODE_PATTERN)] = None
    backup_code: Annotated[
        str | None, Field(default=None, pattern=BACKUP_CODE_PATTERN)
    ] = None
    confirm_username: Annotated[str, Field(min_length=1, max_length=32)]
