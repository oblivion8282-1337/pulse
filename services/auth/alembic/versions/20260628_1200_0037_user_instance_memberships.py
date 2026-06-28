"""user_instance_memberships — Account-basierte Server-Liste (Vault-Ersatz)

Legt ``auth.user_instance_memberships`` an und droppt ``encrypted_server_vaults``
(Migration 0026): statt eines clientseitig verschlüsselten Vaults hält die
Cloud jetzt eine schlichte Membership-Tabelle. Inhalts-Privacy bleibt
unverändert (Cert-Modell: Self-Hosts sind isolierte DB-Welten); nur die
sekundäre Tracking-Dimension der persönlichen Server-Liste wird preisgegeben.

Revision ID: 0037_user_instance_memberships
Revises: 0036_env_file_one_shot
Create Date: 2026-06-28 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0037_user_instance_memberships"
down_revision: str | None = "0036_env_file_one_shot"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "user_instance_memberships",
        sa.Column(
            "user_id",
            sa.BigInteger,
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "instance_id",
            sa.BigInteger,
            sa.ForeignKey(f"{SCHEMA}.registered_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "role",
            sa.Text,
            nullable=False,
            server_default="owner",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("user_id", "instance_id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_instance_memberships_user",
        "user_instance_memberships",
        ["user_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_instance_memberships_instance",
        "user_instance_memberships",
        ["instance_id"],
        schema=SCHEMA,
    )

    # Bestandsdaten: alle aktiven Instanzen → registered_by als owner.
    op.execute(
        sa.text(
            """
            INSERT INTO auth.user_instance_memberships (user_id, instance_id, role, created_at)
            SELECT registered_by, id, 'owner', registered_at
            FROM auth.registered_instances
            WHERE status = 'active' AND registered_by IS NOT NULL
            ON CONFLICT (user_id, instance_id) DO NOTHING
            """
        )
    )

    op.drop_table("encrypted_server_vaults", schema=SCHEMA)


def downgrade() -> None:
    op.create_table(
        "encrypted_server_vaults",
        sa.Column(
            "user_id",
            sa.BigInteger,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "encrypted_blob",
            sa.LargeBinary,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema=SCHEMA,
    )
    op.drop_index(
        "ix_user_instance_memberships_instance",
        "user_instance_memberships",
        schema=SCHEMA,
    )
    op.drop_index(
        "ix_user_instance_memberships_user",
        "user_instance_memberships",
        schema=SCHEMA,
    )
    op.drop_table("user_instance_memberships", schema=SCHEMA)