"""SQLAlchemy models for Phase 2 — Self-Host Instance-Registry (migration 0020).

Ausgelagert aus models.py wegen Größen-Policy (≤500 Z.).
Alembic-Discovery läuft via ``from dcc_auth import models`` → re-export dort.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from dcc_auth.db import Base, snowflake_pk

# JSONB on Postgres, plain JSON on SQLite.
_JsonbOrJson = JSONB().with_variant(JSON(), "sqlite")


class RegisteredInstance(Base):
    """A registered Self-Host instance.

    ``client_secret`` stores an Argon2id hash — Wave 2 endpoints handle hashing
    before writing.  The plaintext is NEVER persisted here.

    Worker-ID uniqueness (chat/voice/media) is enforced via unique indexes so
    Snowflake sequences stay globally collision-free across all federated pods.
    """

    __tablename__ = "registered_instances"

    id: Mapped[int] = snowflake_pk()
    hostname: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    client_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # Argon2id hash — plaintext never stored
    client_secret: Mapped[str] = mapped_column(Text, nullable=False)
    # JSON list of allowed OAuth redirect URIs
    redirect_uris: Mapped[list] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=False,
        server_default="[]",
        default=list,
    )
    worker_id_chat: Mapped[int] = mapped_column(SmallInteger, nullable=False, unique=True)
    worker_id_voice: Mapped[int] = mapped_column(SmallInteger, nullable=False, unique=True)
    worker_id_media: Mapped[int] = mapped_column(SmallInteger, nullable=False, unique=True)
    # active | suspended
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    registered_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    registrar: Mapped["User"] = relationship("User", foreign_keys=[registered_by])
    suspended_entry: Mapped["SuspendedInstance | None"] = relationship(
        "SuspendedInstance", back_populates="instance", uselist=False, cascade="all, delete-orphan"
    )
    applications: Mapped[list["InstanceApplication"]] = relationship(
        "InstanceApplication",
        back_populates="approved_instance",
        foreign_keys="InstanceApplication.approved_instance_id",
    )

    __table_args__ = (
        # hostname + client_id: unique=True on mapped_column is enough —
        # no extra Index entries to avoid double unique indexes on Postgres.
        Index("uq_registered_instances_worker_id_chat", "worker_id_chat", unique=True),
        Index("uq_registered_instances_worker_id_voice", "worker_id_voice", unique=True),
        Index("uq_registered_instances_worker_id_media", "worker_id_media", unique=True),
    )


class InstanceApplication(Base):
    """Application from a Self-Host operator requesting instance registration.

    Workflow: operator submits → status='pending' → admin reviews →
    approved (creates RegisteredInstance, sets approved_instance_id) or rejected.
    """

    __tablename__ = "instance_applications"

    id: Mapped[int] = snowflake_pk()
    applicant_user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    hostname: Mapped[str] = mapped_column(Text, nullable=False)
    # privat | verein | firma | sonst
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    expected_users: Mapped[int] = mapped_column(nullable=False)
    contact_email: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # pending | approved | rejected
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    reviewed_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Set on approval — links back to the created RegisteredInstance.
    # ondelete="SET NULL": preserve application history even if the instance is deleted.
    approved_instance_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("registered_instances.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    applicant: Mapped["User"] = relationship("User", foreign_keys=[applicant_user_id])
    reviewer: Mapped["User | None"] = relationship("User", foreign_keys=[reviewed_by])
    approved_instance: Mapped["RegisteredInstance | None"] = relationship(
        "RegisteredInstance",
        back_populates="applications",
        foreign_keys=[approved_instance_id],
    )

    __table_args__ = (
        Index(
            "ix_instance_applications_applicant_status",
            "applicant_user_id",
            "status",
        ),
        Index("ix_instance_applications_status", "status"),
    )


class SuspendedInstance(Base):
    """Cache row for /.well-known/pulse-suspended-instances.

    Source-of-Truth is registered_instances.status='suspended', but this table
    records the precise suspension timestamp for ETag / If-Modified-Since
    calculations in the well-known endpoint.  Populated by the suspend endpoint
    in Wave 2.  Removed (CASCADE) when the parent RegisteredInstance is deleted.
    """

    __tablename__ = "suspended_instances"

    instance_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("registered_instances.id", ondelete="CASCADE"),
        primary_key=True,
    )
    suspended_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    instance: Mapped["RegisteredInstance"] = relationship(
        "RegisteredInstance", back_populates="suspended_entry"
    )


class InstanceBootstrapToken(Base):
    """One-time bootstrap token for the one-command Self-Host installer.

    Der Owner mintet in der UI einen kurzlebigen, single-use Token; der
    Installer löst ihn **einmal** gegen die Cloud ein (``POST /selfhost/bootstrap``)
    und bekommt dabei die frisch **rotierten** Pairing-Credentials. So liegt nie
    ein Klartext-Secret in der Cloud, und der Token ist nach einem Gebrauch tot.

    Gespeichert wird nur der SHA-256-**Hash** des Tokens (der Token selbst ist
    hochentropisch → kein Argon2 nötig, ein schneller Hash reicht). Der Redeem
    schlägt den Token über den indizierten ``token_hash`` per SQL-Equality nach;
    ein Timing-Angriff auf einen 256-bit-Hash über diesen Pfad ist nicht
    praktikabel.
    """

    __tablename__ = "instance_bootstrap_tokens"

    id: Mapped[int] = snowflake_pk()
    instance_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("registered_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    # SHA-256 hex des Tokens — Klartext wird nie persistiert.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    instance: Mapped["RegisteredInstance"] = relationship(
        "RegisteredInstance", foreign_keys=[instance_id]
    )

    __table_args__ = (
        Index("ix_instance_bootstrap_tokens_instance_id", "instance_id"),
    )


class Complaint(Base):
    """Abuse report against an instance or a user.

    Either ``target_instance_id`` or ``target_user_id`` should be set (or both).
    ``submitter_email`` is nullable — anonymous reports are allowed.
    """

    __tablename__ = "complaints"

    id: Mapped[int] = snowflake_pk()
    # ondelete="SET NULL": preserve audit log when instance is deleted.
    target_instance_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("registered_instances.id", ondelete="SET NULL"),
        nullable=True,
    )
    target_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # Optional URL reference (e.g. link to offending content on the instance).
    target_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitter_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # new | acknowledged | forwarded | resolved
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="new")
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Forward audit trail — set when an admin forwards the complaint to the
    # instance operator. ``forwarded_to_email`` is the address the notice was
    # actually delivered to (NULL when no operator contact was on file or SMTP
    # was unconfigured); ``forward_notice`` keeps the message that was sent.
    forwarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    forwarded_to_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    forward_notice: Mapped[str | None] = mapped_column(Text, nullable=True)

    target_instance: Mapped["RegisteredInstance | None"] = relationship(
        "RegisteredInstance", foreign_keys=[target_instance_id]
    )
    target_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[target_user_id]
    )

    __table_args__ = (
        Index("ix_complaints_status_submitted_at", "status", "submitted_at"),
    )
