"""flip allow_guild_creation default to false + reset existing row

Self-hosted Pulse should be locked down by default: only the
bootstrap admin can create Servers until they explicitly open it up
in the admin panel. The historical default (true) made every fresh
deploy a "anyone can create a Server" — wrong primary for self-host.

Existing installs that explicitly toggled the flag are reverted to
false here too. The admin reads the audit log on the prod server
during a deploy and flips back if needed; the trade-off accepts that
over leaving a more-permissive door open by accident.

Revision ID: 0010_default_guild_creation_off
Revises: 0009_roles_permissions
Create Date: 2026-05-18 13:30:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0010_default_guild_creation_off"
down_revision: str | None = "0009_roles_permissions"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.alter_column(
        "chat_settings",
        "allow_guild_creation",
        server_default=sa.text("false"),
        existing_type=sa.Boolean(),
        existing_nullable=False,
        schema=SCHEMA,
    )
    op.execute(
        f"UPDATE {SCHEMA}.chat_settings SET allow_guild_creation = false WHERE id = 1"
    )


def downgrade() -> None:
    op.alter_column(
        "chat_settings",
        "allow_guild_creation",
        server_default=sa.text("true"),
        existing_type=sa.Boolean(),
        existing_nullable=False,
        schema=SCHEMA,
    )
    op.execute(
        f"UPDATE {SCHEMA}.chat_settings SET allow_guild_creation = true WHERE id = 1"
    )
