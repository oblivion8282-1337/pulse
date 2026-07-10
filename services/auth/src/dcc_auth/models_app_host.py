"""SQLAlchemy model for app_host_applications (migration 0035).

User-Anträge auf App-Hosting-Freischaltung — komplementär zu
``InstanceApplication`` (Server-Hosting), aber ohne die server-spezifischen
Felder (kein Hostname, kein expected_users). Approval setzt automatisch
``users.self_host_enabled=true`` im selben Tx.

Ausgelagert aus models.py wegen Größen-Policy (≤500 Z.).
Alembic-Discovery läuft via ``from dcc_auth import models`` → re-export dort.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from dcc_auth.db import Base, snowflake_pk


class AppHostApplication(Base):
    """A user request to be enabled for App Hosting.

    Lifecycle: pending → (approved | rejected). Approved setzt
    ``users.self_host_enabled=true`` in derselben Transaktion. Mehrere
    ``pending``-Anträge pro User sind verboten (Dedup-Check auf POST).

    Reject lässt ``self_host_enabled`` unverändert; der User kann danach
    einen neuen Antrag stellen.
    """

    __tablename__ = "app_host_applications"

    id: Mapped[int] = snowflake_pk()
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # pending | approved | rejected | revoked
    # 'revoked' = erteilte Freischaltung vom Admin zurückgenommen
    # (routes_admin_app_host_revoke.py). Historie — der User darf neu beantragen.
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="pending"
    )
    reviewed_by: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    applicant: Mapped["User"] = relationship("User", foreign_keys=[user_id])
    reviewer: Mapped["User | None"] = relationship(
        "User", foreign_keys=[reviewed_by]
    )

    __table_args__ = (
        Index(
            "ix_app_host_applications_user_status",
            "user_id",
            "status",
        ),
        Index("ix_app_host_applications_status", "status"),
    )