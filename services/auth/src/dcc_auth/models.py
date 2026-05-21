"""SQLAlchemy models for the auth service."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects import sqlite as _sqlite
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from dcc_auth.db import Base, snowflake_pk

# Autoincrement on SQLite only happens with the literal ``INTEGER PRIMARY KEY``
# affinity — ``BigInteger`` translates to ``BIGINT``, which doesn't. We use
# ``with_variant`` so the prod backend still gets BIGSERIAL while the test
# SQLite backend gets a normal autoincrementing rowid.
_AutoIncBig = BigInteger().with_variant(_sqlite.INTEGER(), "sqlite")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = snowflake_pk()
    username: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Server-wide admin (one or a handful of users). Bootstrap via SQL.
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    # Disabled accounts can't log in and can't refresh. Existing access tokens
    # stay valid until they expire (≤15 min) — no global revocation yet.
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    # Account-recovery / 2FA columns (migration 0006).
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # base32-encoded TOTP shared-secret. Set on ``/totp/setup`` (rotates on
    # repeat calls), but ``totp_enabled`` stays false until ``/totp/verify-setup``
    # — so login is unaffected for setups the user never confirmed.
    totp_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class PasswordResetToken(Base):
    """One-shot reset token. Only the SHA-256 of the plaintext lives in DB.

    The plaintext (43-char URL-safe random) is delivered to the user via email
    and is never persisted server-side — so a DB leak alone cannot be used to
    take over accounts.
    """

    __tablename__ = "password_reset_tokens"

    id: Mapped[int] = mapped_column(_AutoIncBig, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_password_reset_tokens_user_used", "user_id", "used_at"),)


class EmailVerificationToken(Base):
    """One-shot email-verify token. Same shape as ``PasswordResetToken``.

    The two tables are separate so the cleanup / rate-limit semantics of one
    flow can't accidentally invalidate tokens belonging to the other.
    """

    __tablename__ = "email_verification_tokens"

    id: Mapped[int] = mapped_column(_AutoIncBig, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_email_verification_tokens_user_used", "user_id", "used_at"),)


class BackupCode(Base):
    """Single-use TOTP backup code. Stored as SHA-256 of the plaintext.

    8-hex codes have ~32 bit of entropy — fine because they're single-use and
    the issuing endpoint is rate-limited. SHA-256 instead of Argon2 is
    intentional: the codes are throwaways, not long-lived secrets.
    """

    __tablename__ = "user_backup_codes"

    id: Mapped[int] = mapped_column(_AutoIncBig, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_user_backup_codes_user", "user_id"),)


class WebAuthnCredential(Base):
    """A registered WebAuthn / FIDO2 credential — a passkey or security key.

    Stores only *public* material: the credential's public key, its opaque
    credential-id, and a signature counter. The private key never leaves the
    user's authenticator, so a DB-only leak cannot be used to forge a login
    assertion — this is the structural advantage over the shared ``totp_secret``.

    ``credential_id`` and ``public_key`` are base64url-encoded text (not raw
    BLOBs) so the column behaves identically on the Postgres prod backend and
    the SQLite test backend, and a row stays greppable in psql.

    ``sign_count`` is the FIDO clone-detection counter. Many platform
    authenticators (synced passkeys) always report 0 — that's expected; the
    verifier only flags a *decrease*, never a flat 0.
    """

    __tablename__ = "webauthn_credentials"

    id: Mapped[int] = mapped_column(_AutoIncBig, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # base64url of the raw credential id. Globally unique per the WebAuthn
    # spec — the unique index also doubles as the fast lookup path on login.
    credential_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # base64url of the COSE-encoded public key captured at registration.
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    sign_count: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0"), default=0
    )
    # User-facing label, e.g. "MacBook Touch ID" or "YubiKey 5C".
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    # Authenticator-model id (AAGUID) — informational; may be all-zero for
    # privacy-preserving platform authenticators.
    aaguid: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # Transport hints from the browser (e.g. ["internal"], ["usb","nfc"]) —
    # echoed back in future allowCredentials so the browser picks the right
    # authenticator without prompting through every option.
    transports: Mapped[list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (Index("ix_webauthn_credentials_user", "user_id"),)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    jti: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    # SHA-256 hex of the client IP at issue / last-refresh time. Storing the
    # hash (not the IP) keeps the table DSGVO-friendly while still letting the
    # /sessions list surface a "same source as your current session?" hint to
    # the user via a short prefix exposed to the API.
    ip_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Updated on every successful /refresh for the newly-rotated row, so the
    # sessions UI can show real liveness. The old (revoked) row keeps its
    # original value as an audit trail.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index(
            "ix_refresh_tokens_user_active",
            "user_id",
            postgresql_where="revoked_at IS NULL",
        ),
        Index("ix_refresh_tokens_user_revoked", "user_id", "revoked_at"),
    )


class AuthSettings(Base):
    """Singleton row for auth-svc-owned server-wide settings.

    Per PLAN.md anti-pattern: services never share tables. chat-gateway keeps
    its own ``chat_settings`` row. The admin UI talks to both services
    separately.
    """

    __tablename__ = "auth_settings"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, default=1)
    # Registration mode: "open" | "invite_only" | "closed".
    # - open: anyone can /register
    # - invite_only: /register requires a valid invite code (later — currently
    #   the column exists but auth-svc treats invite_only like closed since
    #   there's no invite-issuing flow yet)
    # - closed: /register always 403s
    registration_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="open"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (CheckConstraint("id = 1", name="ck_auth_settings_singleton"),)


class SmtpSettings(Base):
    """Singleton row holding admin-managed SMTP credentials.

    ``email.py`` reads this first; if ``configured`` is false it falls back
    to env-based settings (back-compat with existing deployments). The
    password is Fernet-encrypted at rest — key derived from the JWT private
    key, see ``dcc_auth.crypto``.

    ``provider`` is one of the preset keys in ``dcc_auth.email_providers``
    (``brevo`` / ``mailgun`` / ``resend`` / ``gmail`` / ``custom``). The
    preset only seeds the UI defaults; the actual ``host``/``port``/``use_ssl``
    columns are authoritative once the row is saved.
    """

    __tablename__ = "smtp_settings"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, default=1)
    provider: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="custom"
    )
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    port: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("587")
    )
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Fernet ciphertext of the SMTP password / API key. Empty = not set.
    password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    from_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    use_ssl: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    configured: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (CheckConstraint("id = 1", name="ck_smtp_settings_singleton"),)


class AdminAuditLog(Base):
    """Append-only log of admin actions on the auth side (toggle is_admin,
    disable user, change registration mode). chat-gateway keeps its own
    audit-log table — the admin UI fetches both and merges client-side.
    """

    __tablename__ = "admin_audit_log"

    id: Mapped[int] = snowflake_pk()
    actor_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    payload: Mapped[dict] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=False, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_admin_audit_log_created", "created_at"),)
