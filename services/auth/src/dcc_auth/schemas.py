"""Pydantic request/response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_serializer

# Username allows letters, digits, underscore, dot, dash; 3..32.
USERNAME_PATTERN = r"^[a-zA-Z0-9_.-]{3,32}$"

# TOTP codes are 6 numeric digits in the RFC 6238 default config that pyotp
# uses. Backup codes are 8 hex chars (uppercase). The schemas accept the
# slightly looser shapes so a user copying with a stray space still validates.
TOTP_CODE_PATTERN = r"^\d{6}$"
BACKUP_CODE_PATTERN = r"^[0-9A-Fa-f]{8}$"

# Shared field-type aliases — keep constraints in one place.
_PasswordField = Annotated[str, Field(min_length=8, max_length=128)]
_CurrentPasswordField = Annotated[str, Field(min_length=1, max_length=128)]
_TicketField = Annotated[str, Field(min_length=10, max_length=4096)]


class RegisterIn(BaseModel):
    username: Annotated[str, Field(pattern=USERNAME_PATTERN)]
    email: EmailStr
    password: _PasswordField
    display_name: Annotated[str | None, Field(default=None, max_length=64)] = None
    # Required only when the server is in ``invite_only`` mode; ignored
    # otherwise. Validated + consumed in the /register handler.
    invite_code: Annotated[str | None, Field(default=None, max_length=64)] = None


class LoginIn(BaseModel):
    email_or_username: Annotated[str, Field(min_length=3, max_length=255)]
    password: _CurrentPasswordField


class RefreshIn(BaseModel):
    refresh_token: Annotated[str, Field(max_length=4096)]



class LogoutIn(BaseModel):
    """Optional body for POST /logout.

    refresh_token is optional -- a caller using only the browser-session
    cookie can omit it.  Both paths are idempotent.
    """

    refresh_token: Annotated[str | None, Field(default=None, max_length=4096)] = None

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
    # Computed server-side (NOT a column): true iff SMTP is configured AND the
    # account is still unverified — i.e. the hard email-verification gate is
    # blocking this user. ``me()`` fills it; everywhere else it defaults false.
    email_verification_pending: bool = False
    # Profil-Felder: separater Update-Pfad (POST /me/profile). UI braucht sie
    # für die Round-Trip-Vorschau im Settings-"Profil"-Tab und für die
    # Default-Werte im Color-Picker / Avatar-Anzeige.
    avatar_hash: str | None = None
    profile_color: str | None = None
    profile_color_secondary: str | None = None

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
    profile_color: str | None = None
    profile_color_secondary: str | None = None

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


# ---- Registration invites -----------------------------------------------


class InviteCreateIn(BaseModel):
    """Create an invite code. All fields optional → defaults to a single-use
    code that never expires."""

    # NULL = unlimited uses. Must be >= 1 when given.
    max_uses: Annotated[int | None, Field(default=1, ge=1, le=100_000)] = 1
    # NULL = no expiry. Otherwise the code expires this many days from now.
    expires_in_days: Annotated[int | None, Field(default=None, ge=1, le=3650)] = None
    note: Annotated[str | None, Field(default=None, max_length=100)] = None


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    created_at: datetime
    expires_at: datetime | None = None
    max_uses: int | None = None
    uses: int
    revoked: bool
    note: str | None = None


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
    new_password: _PasswordField


class EmailVerifyConfirmIn(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=128)]


class PasswordChangeIn(BaseModel):
    """Authenticated password change — current pw required as a re-auth gate."""

    current_password: _CurrentPasswordField
    new_password: _PasswordField


class EmailChangeRequestIn(BaseModel):
    """Authenticated email change — current pw gates it; new address gets a link."""

    new_email: EmailStr
    current_password: _CurrentPasswordField


class EmailChangeConfirmIn(BaseModel):
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
    password: _CurrentPasswordField
    code: Annotated[str | None, Field(default=None, pattern=TOTP_CODE_PATTERN)] = None
    backup_code: Annotated[
        str | None, Field(default=None, pattern=BACKUP_CODE_PATTERN)
    ] = None


class TotpBackupRegenIn(BaseModel):
    password: _CurrentPasswordField
    code: Annotated[str, Field(pattern=TOTP_CODE_PATTERN)]


class LoginTotpIn(BaseModel):
    mfa_ticket: _TicketField
    code: Annotated[str | None, Field(default=None, pattern=TOTP_CODE_PATTERN)] = None
    backup_code: Annotated[
        str | None, Field(default=None, pattern=BACKUP_CODE_PATTERN)
    ] = None


class LoginMfaPending(BaseModel):
    """First-step response when the account has a second factor enabled.

    Frontend gates the second step on the presence of ``requires_mfa`` — a
    regular ``TokensOut`` lacks that field. Using a discriminated union in the
    route signature (``TokensOut | LoginMfaPending``) is how the OpenAPI schema
    makes that contract explicit.

    ``methods`` lists which second factors this account actually has, a subset
    of ``{"totp", "webauthn"}`` — the login UI shows only the relevant inputs.
    A passkey-only account has ``["webauthn"]`` and never sees a code field.
    """

    requires_mfa: Literal[True] = True
    mfa_ticket: str
    methods: list[Literal["totp", "webauthn"]]


# ---- WebAuthn / passkeys ------------------------------------------------


class WebAuthnOptionsOut(BaseModel):
    """Output of any WebAuthn *options* endpoint.

    ``options`` is the spec's ``PublicKeyCredentialCreationOptions`` /
    ``...RequestOptions`` JSON, ready to feed (after base64url→ArrayBuffer
    decoding) to ``navigator.credentials.create|get``. ``challenge_ticket`` is
    the signed JWT the client posts back to the matching verify endpoint.
    """

    options: dict[str, Any]
    challenge_ticket: str


class WebAuthnRegisterVerifyIn(BaseModel):
    """Body for ``POST /webauthn/register/verify``.

    ``credential`` is the JSON-serialised ``PublicKeyCredential`` returned by
    the browser — passed through verbatim to the ``webauthn`` library, which
    owns its shape. ``name`` is the user's label for the new passkey.
    """

    challenge_ticket: _TicketField
    credential: dict[str, Any]
    name: Annotated[str, Field(min_length=1, max_length=64)]


class WebAuthnCredentialOut(BaseModel):
    """One registered passkey, surfaced to its owner's settings UI."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    aaguid: str | None = None
    transports: list[str] | None = None
    created_at: datetime
    last_used_at: datetime | None = None

    @field_serializer("id")
    def _id_to_str(self, value: int) -> str:
        return str(value)


class WebAuthnRegisterVerifyOut(BaseModel):
    """Result of enrolling a passkey.

    ``backup_codes`` is populated *only* the first time an account gains any
    MFA factor via a passkey (i.e. no TOTP, no prior codes) — those are the
    one-time recovery codes, shown once. It is ``None`` on every later add.
    """

    credential: WebAuthnCredentialOut
    backup_codes: list[str] | None = None


class WebAuthnCredentialRenameIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]


class WebAuthnLoginOptionsIn(BaseModel):
    """Body for ``POST /login/webauthn/options``.

    ``mfa_ticket`` present → 2FA second step (options scoped to the pinned
    user's credentials). Absent → passwordless login (discoverable).
    """

    mfa_ticket: Annotated[str | None, Field(default=None, max_length=4096)] = None


class WebAuthnLoginVerifyIn(BaseModel):
    """Body for ``POST /login/webauthn/verify``.

    ``mfa_ticket`` must be echoed back on the 2FA path (it pins the same user
    the password step authenticated); omitted on the passwordless path.
    """

    challenge_ticket: _TicketField
    credential: dict[str, Any]
    mfa_ticket: Annotated[str | None, Field(default=None, max_length=4096)] = None


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

    password: _CurrentPasswordField
    code: Annotated[str | None, Field(default=None, pattern=TOTP_CODE_PATTERN)] = None
    backup_code: Annotated[
        str | None, Field(default=None, pattern=BACKUP_CODE_PATTERN)
    ] = None
    confirm_username: Annotated[str, Field(min_length=1, max_length=32)]
