"""archiv — verschlüsselter DM-Verlauf beim Server (Übergabe 2026-10-04 §5)

Revision ID: 0098_archiv
Revises: 0097_meine_anhaenge
Create Date: 2026-10-04 02:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0098_archiv"
down_revision: str | Sequence[str] | None = "0097_meine_anhaenge"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "archiv_zeilen",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("nutzlast", sa.LargeBinary(), nullable=False),
        sa.Column(
            "erstellt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_archiv_zeilen"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_archiv_zeilen_kanal_id", "archiv_zeilen", ["channel_id", "id"], schema=SCHEMA
    )
    op.create_index(
        "ix_archiv_zeilen_erstellt", "archiv_zeilen", ["erstellt_at"], schema=SCHEMA
    )
    op.create_table(
        "archiv_kanal_schluessel",
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("wrap", sa.LargeBinary(), nullable=False),
        sa.Column(
            "erstellt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("channel_id", "user_id", name="pk_archiv_kanal_schluessel"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("archiv_kanal_schluessel", schema=SCHEMA)
    op.drop_index("ix_archiv_zeilen_erstellt", table_name="archiv_zeilen", schema=SCHEMA)
    op.drop_index("ix_archiv_zeilen_kanal_id", table_name="archiv_zeilen", schema=SCHEMA)
    op.drop_table("archiv_zeilen", schema=SCHEMA)
