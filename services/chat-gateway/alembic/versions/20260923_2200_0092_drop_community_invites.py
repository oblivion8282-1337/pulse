"""drop_community_invites — die tote Broker-Tabelle entfernen.

Migration 0063 hat die offenen Einladungen von ``community_invites`` auf
``community_invite_notifications`` uebernommen und die alte Tabelle bewusst
stehen lassen (Rollback-Sicherheit direkt nach dem Deploy). Der Deploy ist
seit Wochen erfolgt und geprueft; kein Code liest oder schreibt die Tabelle
mehr — der letzte Konsument war der Konto-Purge, der seit 3ebb0b5c
(2026-09-20) die neue Inbox raumt und mit diesem Stand auch den toten
Import/Block verloren hat. Das Model
``dcc_chat_gateway.models.community_invites.CommunityInvite`` faellt mit.

Downgrade legt die Tabelle samt ihrer drei Indizes wieder an — Spaltenform
1:1 aus dem entfernten Model uebernommen, keine Daten (die Zeilen sind mit
0063 in ``community_invite_notifications`` uebernommen worden).

Revision ID: 0092_drop_community_invites
Revises: 0091_pubkey_eindeutig
Create Date: 2026-09-23 22:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"
TABLE = "community_invites"

revision: str = "0092_drop_community_invites"
down_revision: str | Sequence[str] | None = "0091_pubkey_eindeutig"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table(TABLE, schema=SCHEMA)


def downgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("inviter_id", sa.BigInteger(), nullable=False),
        sa.Column("invitee_id", sa.BigInteger(), nullable=False),
        sa.Column("target_host", sa.String(255), nullable=False),
        sa.Column("target_instance_id", sa.BigInteger(), nullable=True),
        sa.Column("target_guild_id", sa.BigInteger(), nullable=False),
        sa.Column("target_guild_name", sa.String(128), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invites_invitee", TABLE, ["invitee_id", "created_at"], schema=SCHEMA
    )
    op.create_index(
        "ix_community_invites_dedupe",
        TABLE,
        ["inviter_id", "invitee_id", "target_guild_id"],
        unique=True,
        schema=SCHEMA,
    )
    op.create_index("ix_community_invites_expires", TABLE, ["expires_at"], schema=SCHEMA)
