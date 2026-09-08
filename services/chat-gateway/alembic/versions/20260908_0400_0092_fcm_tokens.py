"""fcm_tokens — FCM-Registrierungstokens der Android-App (Übergabe P0.1)

Revision ID: 0092_fcm_tokens
Revises: 0091_anrufe
Create Date: 2026-09-08 04:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0092_fcm_tokens"
down_revision: str | Sequence[str] | None = "0091_anrufe"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Schlüssel (user_id, geraet_id): ein Konto, viele Geräte, je Gerät
    # eine Zeile (Upsert der App-Anmeldung). Der führende user_id-Teil des
    # PK ist zugleich der Fan-out-Zugriff des Push-Senders — kein zusätzlicher
    # Index. token UNIQUE: ein physischer FCM-Token gehört zu genau einem Konto.
    op.create_table(
        "fcm_tokens",
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
        sa.UniqueConstraint("token", name="uq_fcm_tokens_token"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("fcm_tokens", schema=SCHEMA)
