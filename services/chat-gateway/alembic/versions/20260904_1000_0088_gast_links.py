"""gast-links fuer sprachkanaele

Revision ID: 0088_gast_links
Revises: 220119df9614
Create Date: 2026-09-04 10:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Die Tabellen dieses Dienstes leben im Schema ``chat`` (jeder Dienst hat sein
# eigenes). Ohne ``schema=`` landet sie in ``public``, das Modell sucht sie
# aber unter ``chat.guest_links`` — im SQLite-Test faellt das nicht auf (dort
# wird das Schema flachgelegt), erst gegen Postgres. Genau so passiert: alle
# pytest-Tests gruen, der E2E-Lauf 500.
SCHEMA = "chat"

revision: str = "0088_gast_links"
down_revision: str | Sequence[str] | None = "220119df9614"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "guest_links",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        # SHA-256-Hex des Codes — der Code selbst wird nie gespeichert.
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("code_hash", name="uq_guest_links_code_hash"),
        schema=SCHEMA,
    )
    op.create_index("ix_guest_links_guild", "guest_links", ["guild_id"], schema=SCHEMA)
    op.create_index("ix_guest_links_channel", "guest_links", ["channel_id"], schema=SCHEMA)


def downgrade() -> None:
    op.drop_index("ix_guest_links_channel", table_name="guest_links", schema=SCHEMA)
    op.drop_index("ix_guest_links_guild", table_name="guest_links", schema=SCHEMA)
    op.drop_table("guest_links", schema=SCHEMA)
