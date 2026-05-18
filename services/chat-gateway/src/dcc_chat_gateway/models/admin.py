"""Server-wide chat settings (singleton) + admin audit log."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    JSON,
    SmallInteger,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class ChatSettings(Base):
    """Singleton row for chat-gateway-owned server-wide settings.

    Per PLAN.md anti-pattern: services never share tables. auth-svc keeps
    its own ``auth_settings`` row. The admin UI talks to both services
    separately (registration mode → auth-svc, the fields here → chat-gateway).
    """

    __tablename__ = "chat_settings"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, default=1)
    # DM attachment limits. Guild channels carry per-guild limits on the
    # ``Guild`` row instead — these only apply to 1:1 DM channels.
    dm_attachment_max_size_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="26214400"  # 25 MB
    )
    dm_attachment_max_count_per_message: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="4"
    )
    # Permission gates. Default true keeps the historical "anyone can"
    # behaviour; the admin flips them off via /admin/permissions.
    allow_guild_creation: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    allow_member_invites: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (CheckConstraint("id = 1", name="ck_chat_settings_singleton"),)


class AdminAuditLog(Base):
    """Append-only log of admin actions for accountability + debugging.

    Every admin write — toggling is_admin, disabling a user, changing
    registration mode, raising DM limits — appends a row here. The
    payload is opaque JSON so we don't need to migrate this table every
    time a new admin action is added.
    """

    __tablename__ = "admin_audit_log"

    id: Mapped[int] = snowflake_pk()
    actor_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_admin_audit_log_created", "created_at"),)
