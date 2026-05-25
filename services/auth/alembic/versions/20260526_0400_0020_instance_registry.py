"""instance_registry — Phase 2.1 Self-Host Instance-Registry

4 neue Tabellen im auth-Schema:

  registered_instances  — bekannte Self-Host-Instanzen (hostname, client credentials,
                          Worker-IDs, Status). client_secret ist Argon2id-Hash (NIE Klartext).
  instance_applications — Antragsformular für Self-Host-Betreiber (pending→approved/rejected).
  suspended_instances   — Cache-Tabelle für /.well-known/pulse-suspended-instances; Source-of-Truth
                          ist registered_instances.status='suspended'.
  complaints            — Missbrauchs-Meldungen gegen Instanzen oder Users.

Revision ID: 0020_instance_registry
Revises: 0019_kdf_rename
Create Date: 2026-05-26 04:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0020_instance_registry"
down_revision: str | None = "0019_kdf_rename"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. registered_instances
    # ------------------------------------------------------------------
    op.create_table(
        "registered_instances",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("hostname", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        # Argon2id-Hash — Wave 2 implementiert Hashing, Schema speichert nur Hash
        sa.Column("client_secret", sa.Text(), nullable=False),
        sa.Column(
            "redirect_uris",
            sa.JSON(),
            nullable=False,
            server_default="[]",
        ),
        sa.Column("worker_id_chat", sa.SmallInteger(), nullable=False),
        sa.Column("worker_id_voice", sa.SmallInteger(), nullable=False),
        sa.Column("worker_id_media", sa.SmallInteger(), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="active",
        ),  # active | suspended
        sa.Column(
            "registered_by",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.users.id"),
            nullable=False,
        ),
        sa.Column(
            "registered_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_registered_instances_hostname",
        "registered_instances",
        ["hostname"],
        unique=True,
        schema=SCHEMA,
    )
    op.create_index(
        "uq_registered_instances_client_id",
        "registered_instances",
        ["client_id"],
        unique=True,
        schema=SCHEMA,
    )
    # Worker-IDs sind global eindeutig
    op.create_index(
        "uq_registered_instances_worker_id_chat",
        "registered_instances",
        ["worker_id_chat"],
        unique=True,
        schema=SCHEMA,
    )
    op.create_index(
        "uq_registered_instances_worker_id_voice",
        "registered_instances",
        ["worker_id_voice"],
        unique=True,
        schema=SCHEMA,
    )
    op.create_index(
        "uq_registered_instances_worker_id_media",
        "registered_instances",
        ["worker_id_media"],
        unique=True,
        schema=SCHEMA,
    )

    # ------------------------------------------------------------------
    # 2. instance_applications
    # ------------------------------------------------------------------
    op.create_table(
        "instance_applications",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "applicant_user_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.users.id"),
            nullable=False,
        ),
        sa.Column("hostname", sa.Text(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),  # privat | verein | firma | sonst
        sa.Column("expected_users", sa.Integer(), nullable=False),
        sa.Column("contact_email", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),  # pending | approved | rejected
        sa.Column(
            "reviewed_by",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.users.id"),
            nullable=True,
        ),
        sa.Column("reviewed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column(
            "approved_instance_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.registered_instances.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_instance_applications_applicant_status",
        "instance_applications",
        ["applicant_user_id", "status"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_instance_applications_status",
        "instance_applications",
        ["status"],
        schema=SCHEMA,
    )

    # ------------------------------------------------------------------
    # 3. suspended_instances
    # ------------------------------------------------------------------
    op.create_table(
        "suspended_instances",
        sa.Column(
            "instance_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.registered_instances.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "suspended_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("reason", sa.Text(), nullable=True),
        schema=SCHEMA,
    )

    # ------------------------------------------------------------------
    # 4. complaints
    # ------------------------------------------------------------------
    op.create_table(
        "complaints",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "target_instance_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.registered_instances.id"),
            nullable=True,
        ),
        sa.Column(
            "target_user_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.users.id"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("submitter_email", sa.Text(), nullable=True),
        sa.Column(
            "submitted_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="new",
        ),  # new | acknowledged | forwarded | resolved
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_complaints_status_submitted_at",
        "complaints",
        ["status", "submitted_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_complaints_status_submitted_at", "complaints", schema=SCHEMA)
    op.drop_table("complaints", schema=SCHEMA)

    op.drop_table("suspended_instances", schema=SCHEMA)

    op.drop_index("ix_instance_applications_status", "instance_applications", schema=SCHEMA)
    op.drop_index(
        "ix_instance_applications_applicant_status", "instance_applications", schema=SCHEMA
    )
    op.drop_table("instance_applications", schema=SCHEMA)

    op.drop_index(
        "uq_registered_instances_worker_id_media", "registered_instances", schema=SCHEMA
    )
    op.drop_index(
        "uq_registered_instances_worker_id_voice", "registered_instances", schema=SCHEMA
    )
    op.drop_index(
        "uq_registered_instances_worker_id_chat", "registered_instances", schema=SCHEMA
    )
    op.drop_index(
        "uq_registered_instances_client_id", "registered_instances", schema=SCHEMA
    )
    op.drop_index(
        "uq_registered_instances_hostname", "registered_instances", schema=SCHEMA
    )
    op.drop_table("registered_instances", schema=SCHEMA)
