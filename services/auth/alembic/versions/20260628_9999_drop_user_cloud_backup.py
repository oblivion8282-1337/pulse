"""drop user-cloud-backup tables

Das User-Cloud-Backup-Feature (verschlüsselter Ed25519-Keypair-Backup in der
Cloud, opt-in, nie in Prod aktiviert) wurde 2026-06-28 komplett entfernt
(Frontend + Backend + Tests). Diese Migration droppt die jetzt ungenutzten
Tabellen ``auth.encrypted_key_backups`` (aus Migration 0015) und
``auth.account_keys`` (aus Migration 0028).

Historie bleibt unangetastet: 0015 und 0028 laufen weiterhin, ihre Tabellen
werden am Ende der Kette hiermit wieder entfernt. Frische Deploys laufen die
volle Kette + diese Drop-Migration → netto keine Backup-Tabellen.

Revision ID: 9999_drop_user_cloud_backup
Revises: 0037_user_instance_memberships
Create Date: 2026-06-28 12:30:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "9999_drop_user_cloud_backup"
down_revision: str | None = "0037_user_instance_memberships"
branch_labels = None
depends_on = None

SCHEMA = "auth"

_UUIDOrText = pg.UUID(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    # encrypted_key_backups hat eine FK auf issued_credentials(cert_id) +
    # users(id), jeweils ON DELETE CASCADE. DROP TABLE … CASCADE räumt die FK
    # auf (es gibt keine FK in die andere Richtung — die backup-Relationship
    # war nur eine SQLAlchemy-ORM-Spec, keine DB-Constraint).
    op.drop_table("encrypted_key_backups", schema=SCHEMA)
    op.drop_table("account_keys", schema=SCHEMA)


def downgrade() -> None:
    # Symmetrisch zu 0015 + 0028 — re-create die Tabellen, damit ein
    # alembic-downgrade die DB wieder in den Vor-Refactor-Stand bringt.
    op.create_table(
        "encrypted_key_backups",
        sa.Column("cert_id", _UUIDOrText, primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("device_label", sa.Text(), nullable=False),
        sa.Column("encrypted_blob", sa.LargeBinary(), nullable=False),
        sa.Column("previous_blob", sa.LargeBinary(), nullable=True),
        sa.Column("argon2_salt", sa.LargeBinary(), nullable=False),
        sa.Column("argon2_params", sa.Text(), nullable=False),
        sa.Column("gcm_nonce", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("previous_replaced_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["cert_id"],
            [f"{SCHEMA}.issued_credentials.cert_id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "account_keys",
        sa.Column("user_id", sa.BigInteger(), primary_key=True),
        sa.Column("wrapped_key", sa.LargeBinary(), nullable=False),
        sa.Column("kdf_salt", sa.LargeBinary(), nullable=False),
        sa.Column("kdf_params", sa.Text(), nullable=False),
        sa.Column("gcm_nonce", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
