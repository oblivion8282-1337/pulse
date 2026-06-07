"""replace join_mode + instance_join_invites with a single "locked" toggle

Stufe 5 (Entscheidung 7): instance access is now decided per community (a
friend community-invite grant or a public-community address). The old 3-way
instance lock (``chat_settings.join_mode`` open/invite_only/closed) and the
``instance_join_invites`` code table no longer gate anything and are removed.

In their place: a single boolean ``chat_settings.locked`` ("Server gesperrt"
not-aus toggle), default ``false``, that overrides **every** new join — both
the community-invite grant and the public-community handle.

Upgrade:
* add ``chat_settings.locked`` BOOLEAN NOT NULL default false,
* drop ``chat_settings.join_mode``,
* drop the ``instance_join_invites`` table (+ its index).

Downgrade (reversible):
* recreate ``instance_join_invites`` (+ index),
* re-add ``chat_settings.join_mode`` String(16) NOT NULL default ``invite_only``
  (the locked-down legacy default),
* drop ``chat_settings.locked``.

Data note: ``locked`` defaults false, so every existing instance comes back
unlocked (open to the per-community access paths) — the safe default for the
new model (the per-community gates do the real access control). The previous
``join_mode`` value is not carried over; the downgrade restores the column with
its original default but cannot recover the pre-upgrade per-instance value.

Revision ID: 0035_instance_locked_toggle
Revises: 0034_public_community_handle
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0035_instance_locked_toggle"
down_revision = "0034_public_community_handle"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # a) New single "Server gesperrt" toggle.
    op.add_column(
        "chat_settings",
        sa.Column(
            "locked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )

    # b) Drop the legacy 3-way join_mode column.
    op.drop_column("chat_settings", "join_mode", schema=SCHEMA)

    # c) Drop the legacy instance join-invite code table (+ index).
    op.drop_index(
        "ix_instance_join_invites_created",
        table_name="instance_join_invites",
        schema=SCHEMA,
    )
    op.drop_table("instance_join_invites", schema=SCHEMA)


def downgrade() -> None:
    # Recreate the legacy join-invite code table (+ index).
    op.create_table(
        "instance_join_invites",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "revoked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("note", sa.String(100), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_instance_join_invites_created",
        "instance_join_invites",
        ["created_at"],
        schema=SCHEMA,
    )

    # Re-add the legacy join_mode column (locked-down default).
    op.add_column(
        "chat_settings",
        sa.Column(
            "join_mode",
            sa.String(16),
            nullable=False,
            server_default="invite_only",
        ),
        schema=SCHEMA,
    )

    # Drop the locked toggle.
    op.drop_column("chat_settings", "locked", schema=SCHEMA)
