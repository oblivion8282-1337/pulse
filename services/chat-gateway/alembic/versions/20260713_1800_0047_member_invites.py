"""community_invite_notifications — Einladungen an Nicht-Freunde (Cloud, v1)

Einladungen in Cloud-Communities per Nutzername fahren auf den Schienen der
Freundschaftsanfragen (Annehmen/Ablehnen beim Empfänger) statt als DM —
DMs bleiben strikt friends-only. Nur Cloud-Communities: eine Nutzername-
Einladung auf einen Self-Host wäre cross-server und ist bewusst nicht v1.

Kein Unique-Constraint für „ein pending pro (guild, invitee)" — der Dedupe-
Guard läuft als Query im POST (SQLite-tauglich, wie die Friend-Request-
Dedupe-Prüfung); entschiedene Zeilen bleiben als Historie.

Revision ID: 0047_member_invites
Revises: 0046_perf_indexes
Create Date: 2026-07-13 18:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0047_member_invites"
down_revision: str | None = "0046_perf_indexes"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "community_invite_notifications",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Kein FK auf User — Identität lebt in auth-svc (getrennte Schemas).
        sa.Column("inviter_user_id", sa.BigInteger(), nullable=False),
        sa.Column("invitee_user_id", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invite_notifications_invitee_status",
        "community_invite_notifications",
        ["invitee_user_id", "status"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invite_notifications_guild_invitee",
        "community_invite_notifications",
        ["guild_id", "invitee_user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("community_invite_notifications", schema=SCHEMA)
