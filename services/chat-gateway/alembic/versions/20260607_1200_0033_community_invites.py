"""community-invite broker (Stufe 2 / B-lite, cloud-only)

Adds the ``chat.community_invites`` table — the Cloud-only invite-broker that
relays a private friend-to-friend community invitation to the invitee and is
deleted on accept/decline (B-lite, no durable membership register).

Lives in the chat schema (the broker is part of the chat-gateway), but is only
ever written/read on the Cloud (the ``community_invites`` router is guarded by
``CloudOnly``). On a Self-Host the table is harmless dead weight — same posture
as ``friendships``/``dm_channels``.

Revision ID: 0033_community_invites
Revises: 0032_instance_join_mode
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0033_community_invites"
down_revision = "0032_instance_join_mode"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "community_invites",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("inviter_id", sa.BigInteger(), nullable=False),
        sa.Column("invitee_id", sa.BigInteger(), nullable=False),
        sa.Column("target_host", sa.String(255), nullable=False),
        sa.Column("target_instance_id", sa.BigInteger(), nullable=True),
        sa.Column("target_guild_id", sa.BigInteger(), nullable=False),
        sa.Column("target_guild_name", sa.String(128), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invites_invitee",
        "community_invites",
        ["invitee_id", "created_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invites_dedupe",
        "community_invites",
        ["inviter_id", "invitee_id", "target_guild_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_community_invites_expires",
        "community_invites",
        ["expires_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_community_invites_expires", "community_invites", schema=SCHEMA
    )
    op.drop_index(
        "ix_community_invites_dedupe", "community_invites", schema=SCHEMA
    )
    op.drop_index(
        "ix_community_invites_invitee", "community_invites", schema=SCHEMA
    )
    op.drop_table("community_invites", schema=SCHEMA)
