"""instance join-mode + membership + join-invites (Self-Host gated join)

Adds the building blocks for a Self-Host "join mode / invite-only" gate:

* ``chat_settings.join_mode`` — String(16) NOT NULL, default ``invite_only``
  (a fresh instance starts locked-down; only the owner gets in until they
  open the door or mint invites).
* ``chat.instance_members`` — who has actually joined this instance. The
  cert-login handler checks membership on every re-auth (existing members
  never need an invite again).
* ``chat.instance_join_invites`` — invite codes, mirroring the auth-svc
  ``registration_invites`` shape but ``created_by`` is TEXT (the admin's
  ``user_identifier``, which is a pairwise-sub on self-host, not a BIGINT).

Data migration (so no current member is locked out by the new default):
* force the singleton ``chat_settings`` row to ``invite_only`` explicitly,
* backfill ``instance_members`` from every existing ``cached_user_profiles``
  row (``joined_via='migrated'``), idempotent via ON CONFLICT DO NOTHING.

Revision ID: 0032_instance_join_mode
Revises: 0031_cached_profile_synthetic_id
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0032_instance_join_mode"
down_revision = "0031_cached_profile_synthetic_id"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # a) join_mode on the singleton.
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

    # b) instance_members.
    op.create_table(
        "instance_members",
        sa.Column("user_identifier", sa.Text(), primary_key=True),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("joined_via", sa.Text(), nullable=True),
        schema=SCHEMA,
    )

    # c) instance_join_invites.
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

    # d) data migration — never lock out an existing member.
    #    The singleton row is created by migration 0006; force it explicitly to
    #    invite_only (the server_default only applies to *new* rows).
    op.execute(
        f"UPDATE {SCHEMA}.chat_settings SET join_mode = 'invite_only' WHERE id = 1"
    )
    #    Backfill every cached profile as a grandfathered member.
    op.execute(
        f"""
        INSERT INTO {SCHEMA}.instance_members (user_identifier, joined_at, joined_via)
        SELECT user_identifier, updated_at, 'migrated'
        FROM {SCHEMA}.cached_user_profiles
        ON CONFLICT (user_identifier) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_instance_join_invites_created",
        "instance_join_invites",
        schema=SCHEMA,
    )
    op.drop_table("instance_join_invites", schema=SCHEMA)
    op.drop_table("instance_members", schema=SCHEMA)
    op.drop_column("chat_settings", "join_mode", schema=SCHEMA)
