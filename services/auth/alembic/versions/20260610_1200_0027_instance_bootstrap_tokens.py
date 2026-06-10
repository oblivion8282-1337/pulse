"""instance_bootstrap_tokens — One-Time-Token für den Ein-Befehl-Self-Host-Installer

Adds ``auth.instance_bootstrap_tokens``. Der Owner mintet einen kurzlebigen,
single-use Token (``POST /me/instances/{id}/bootstrap-token``); der Installer
löst ihn einmal ein (``POST /selfhost/bootstrap``) und erhält dabei die frisch
rotierten Cloud-Pairing-Credentials. Gespeichert wird nur der SHA-256-Hash.

Columns
-------
id          — Snowflake-PK.
instance_id — FK → ``auth.registered_instances(id)`` CASCADE.
token_hash  — SHA-256 hex des Tokens, unique. Klartext nie persistiert.
expires_at  — Ablaufzeitpunkt (Mint + TTL).
consumed_at — Gesetzt beim Einlösen → Token danach tot (single-use).
created_at  — Mint-Zeitpunkt.

Revision ID: 0027_instance_bootstrap_tokens
Revises: 0026_encrypted_server_vaults
Create Date: 2026-06-10 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0027_instance_bootstrap_tokens"
down_revision: str | None = "0026_encrypted_server_vaults"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "instance_bootstrap_tokens",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("instance_id", sa.BigInteger(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["instance_id"],
            [f"{SCHEMA}.registered_instances.id"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token_hash", name="uq_instance_bootstrap_tokens_hash"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_instance_bootstrap_tokens_instance_id",
        "instance_bootstrap_tokens",
        ["instance_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_instance_bootstrap_tokens_instance_id",
        table_name="instance_bootstrap_tokens",
        schema=SCHEMA,
    )
    op.drop_table("instance_bootstrap_tokens", schema=SCHEMA)
