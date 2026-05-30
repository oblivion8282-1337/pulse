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
    # Permission gates. ``allow_guild_creation`` defaults to FALSE so a
    # fresh self-hosted deploy is locked down: only the bootstrap admin
    # can spin up Servers until they explicitly open the door via
    # /admin/permissions. ``allow_member_invites`` stays true so members
    # of a guild can invite friends — that's a per-guild concern, not a
    # global one.
    allow_guild_creation: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    allow_member_invites: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    # Per-file cap (bytes) for per-guild sound-override uploads. Tunable
    # by the Pulse-instance admin via /admin/permissions; the route layer
    # in chat-gateway enforces it on PUT. 512 KB default = comfortable
    # headroom over the Kenney UI Audio defaults (~10–30 KB).
    guild_sound_max_size_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="524288"
    )
    # Global HQ-stream quality limits (the GSR desktop stream). Enforced
    # client-side in the stream panel + buildStartArgs — media-svc/MediaMTX
    # never see these params (no transcoding, PLAN.md anti-pattern), so this
    # is a best-effort cap, same as the long-standing client-side bitrate max.
    # Defaults mirror today's hard-coded behaviour → no effect until an admin
    # tightens them. ``hq_resolution_max`` is a ceiling ('Native' = no cap);
    # ordering is downscale-only (Native > 4K > 1440p > 1080p > 720p > 480p).
    hq_bitrate_min_kbps: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="1000"
    )
    hq_bitrate_max_kbps: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="10000"
    )
    hq_fps_min: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="1"
    )
    hq_fps_max: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="360"
    )
    hq_resolution_max: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="Native"
    )
    # Global limits for the *normal* (browser LiveKit screen-share) path —
    # separate from the HQ caps above (per user request: own values). Bitrate
    # stored in kbps like the HQ ones (the UI shows Mbit/s). Resolution ceiling
    # uses the screen-share set (native > 1080p > 720p > 480p; 'native' = no
    # cap). Defaults mirror today's client behaviour (1–10 Mbit/s, 1–240 fps,
    # no cap) → no-op until tightened.
    ns_bitrate_min_kbps: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="1000"
    )
    ns_bitrate_max_kbps: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="10000"
    )
    ns_fps_min: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="1"
    )
    ns_fps_max: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="240"
    )
    ns_resolution_max: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="native"
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
