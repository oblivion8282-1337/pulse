"""SQLAlchemy models for the auth service."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
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
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from dcc_auth.db import Base, snowflake_pk


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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


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

    __table_args__ = (
        Index(
            "ix_refresh_tokens_user_active",
            "user_id",
            postgresql_where="revoked_at IS NULL",
        ),
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
