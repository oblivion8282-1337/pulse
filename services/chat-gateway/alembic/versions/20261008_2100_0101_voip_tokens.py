"""voip_tokens — PushKit-Tokens der iOS-App (iOS-Liste Punkt 40)

Revision ID: 0101_voip_tokens
Revises: 0100_cached_user_profiles_lower
Create Date: 2026-10-08 21:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0101_voip_tokens"
down_revision: str | Sequence[str] | None = "0100_cached_user_profiles_lower"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Form wie ``fcm_tokens`` (0096), und das ist Absicht: derselbe Upsert
    # bedient beide (``routes/_geraetetoken.py``). EIGENE Tabelle, weil der
    # PushKit-Token ein anderer Token mit anderem Topic ist — in fcm_tokens
    # wäre ``token`` UNIQUE über zwei verschiedene Bedeutungen, und der
    # FCM-Versand nähme eine VoIP-Zeile fälschlich mit (Begründung am Modell).
    op.create_table(
        "voip_tokens",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("geraet_id", sa.Text(), nullable=False),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column(
            "erstellt_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("user_id", "geraet_id"),
        sa.UniqueConstraint("token", name="uq_voip_tokens_token"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("voip_tokens", schema=SCHEMA)
