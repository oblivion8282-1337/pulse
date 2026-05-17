"""chat_settings: allow_guild_creation + allow_member_invites

Two new boolean flags the admin panel can toggle:

* ``allow_guild_creation`` — when false, ``POST /guilds`` rejects non-admin
  callers with 403. Admins can always create guilds.
* ``allow_member_invites`` — when false, ``POST /guilds/{id}/invites``
  rejects callers who aren't the ``guild.owner_id``. Per-guild owner
  override; global admins do not get a special exemption (the spec said
  "nur Guild-Owner" — admin users would still need ownership of the
  specific guild). Defaults to true so existing behaviour is preserved.

Revision ID: 0008_permission_flags
Revises: 0007_message_attachments
Create Date: 2026-05-17 19:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0008_permission_flags"
down_revision: str | None = "0007_message_attachments"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column(
            "allow_guild_creation",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column(
            "allow_member_invites",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("chat_settings", "allow_member_invites", schema=SCHEMA)
    op.drop_column("chat_settings", "allow_guild_creation", schema=SCHEMA)
