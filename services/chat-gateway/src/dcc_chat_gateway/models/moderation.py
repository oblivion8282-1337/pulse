"""Moderation-related models (Phase 3.1).

Three tables for Self-Host Phase 3 Wave 1:

* :class:`CachedUserProfile` — Cross-mode profile cache. Primary key is
  ``user_identifier`` (Cloud: user_id string; Self-Host: pairwise-sub).
  ``last_statement_iat`` protects against replay of old profile statements.

* :class:`Report` — Moderation report submitted by a member. Lifecycle:
  ``new`` → ``triaged`` → ``resolved | dismissed``.

* :class:`ModAuditLog` — Append-only guild-scoped audit trail for every
  moderation action (ban, message delete, role change, report resolution, …).

No FK references to ``auth.users`` — cross-service boundary (chat + auth
have separate schemas, CLAUDE.md anti-pattern §1).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class CachedUserProfile(Base):
    """Cross-mode profile cache for chat-gateway.

    Cloud mode: ``user_identifier`` = numeric user_id serialised as TEXT.
    Self-Host:  ``user_identifier`` = pairwise-sub (16-char Base64url).

    ``last_statement_iat`` is the ``iat`` (issued-at) of the most recently
    accepted profile statement JWT.  Any statement with an equal or older
    ``iat`` is rejected as a replay (DE 11 A.3).

    ``stale`` is set to ``True`` when the Cloud signals that the profile may
    have changed (e.g. CRL update cycle) but no fresh statement has arrived
    yet.  Read paths should prefer fresh data over stale but MAY use stale
    under degraded connectivity.
    """

    __tablename__ = "cached_user_profiles"

    user_identifier: Mapped[str] = mapped_column(Text, primary_key=True)
    username: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    avatar_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile_color: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_statement_iat: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    stale: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    __table_args__ = (Index("ix_cached_user_profiles_username", "username"),)


class Report(Base):
    """Moderation report raised by an instance member.

    ``reason_code`` is one of: ``spam`` | ``harassment`` | ``illegal`` |
    ``csam`` | ``other``.  ``body`` is the free-text description.

    ``status`` lifecycle: ``new`` → ``triaged`` → ``resolved`` | ``dismissed``.

    At most one of ``target_message_id``, ``target_user_id``,
    ``target_channel_id`` should be set; some reports reference multiple
    targets — the payload is not constrained at DB level (UI validates).
    """

    __tablename__ = "reports"

    id: Mapped[int] = snowflake_pk()
    reporter_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    target_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    target_user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    target_channel_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    reason_code: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="new", server_default=text("'new'")
    )
    resolver_user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_reports_status_created", "status", "created_at"),
        Index(
            "ix_reports_target_channel",
            "target_channel_id",
            postgresql_where=text("target_channel_id IS NOT NULL"),
        ),
        Index(
            "ix_reports_target_message",
            "target_message_id",
            postgresql_where=text("target_message_id IS NOT NULL"),
        ),
        Index(
            "ix_reports_target_user",
            "target_user_id",
            postgresql_where=text("target_user_id IS NOT NULL"),
        ),
    )


class ModAuditLog(Base):
    """Append-only moderation audit trail (guild-scoped).

    ``action_type`` is a free-text discriminator, e.g.:
    ``permission_change``, ``ban``, ``message_delete``,
    ``report_resolution``, ``role_change``.

    ``target_kind`` is one of ``user`` | ``channel`` | ``role`` | ``message``
    (nullable when the action has no single target).

    ``payload`` is opaque JSON — callers put action-specific context there
    (old/new values, reason strings, etc.).  JSONB under Postgres for
    indexability, falls back to TEXT-JSON under SQLite in tests.
    """

    __tablename__ = "mod_audit_log"

    id: Mapped[int] = snowflake_pk()
    guild_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    actor_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    action_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    payload: Mapped[dict | None] = mapped_column(
        JSON().with_variant(postgresql.JSONB(), "postgresql"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Per-guild timeline (most recent first) — primary mod-queue query
        Index("ix_mod_audit_log_guild_created", "guild_id", "created_at"),
        # Per-actor timeline — audit trail for a specific moderator
        Index("ix_mod_audit_log_actor_created", "actor_user_id", "created_at"),
    )


__all__ = ["CachedUserProfile", "ModAuditLog", "Report"]
