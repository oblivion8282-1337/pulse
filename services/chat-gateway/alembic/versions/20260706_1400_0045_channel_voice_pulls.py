"""channel_voice_pulls — temporäre Sichtbarkeits-Grants für Voice-Pull

Ein Voice-Pull („User X in privaten Voice-Channel ziehen") legt einen
User-Overwrite (VIEW_CHANNEL|CONNECT) an, damit der Gezogene den Channel
sehen + betreten kann. Diese Tabelle ist die Quelle der Wahrheit, *welche*
dieser Overwrite-Grants temporär sind und beim Verlassen des Channels
wieder entzogen werden sollen — ein permanenter Admin-Grant (gleicher
User-Overwrite) darf vom Auto-Revoke *nicht* angetastet werden.

voice-signaling detektiert das Verlassen autoritativ (participant_left-
Webhook) und ruft den chat-gateway-Internal-Endpoint, der Zeile + die
per Pull gesetzten Overwrite-Bits entfernt. Der Reaper-Backstop räumt
verwaiste Grants ab (Ziel hat nie verbunden / Webhook ging verloren).

Revision ID: 0045_channel_voice_pulls
Revises: 0044_channel_user_limit
Create Date: 2026-07-06 14:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0045_channel_voice_pulls"
down_revision: str | None = "0044_channel_user_limit"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "channel_voice_pulls",
        sa.Column(
            "channel_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # No FK to users — chat-gateway has no users table (identity lives in auth-svc).
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("granted_by", sa.BigInteger(), nullable=False),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("channel_id", "user_id"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("channel_voice_pulls", schema=SCHEMA)
