"""users.is_admin + users.disabled

Adds the two boolean flags that drive the server-admin panel:

* ``is_admin`` — set true for the server operator(s). Bootstrapped via SQL after
  the migration runs (``UPDATE auth.users SET is_admin=true WHERE id=...``).
  Carried in the access-token as the ``admin`` claim so chat-gateway can
  authorize admin-only routes without a per-request lookup.
* ``disabled`` — soft-kick: ``/login`` and ``/refresh`` reject disabled
  accounts. Existing access tokens (≤15 min TTL) stay valid until they expire.

Revision ID: 0003_users_admin_disabled
Revises: 0002_users_updated_at_trigger
Create Date: 2026-05-17 13:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0003_users_admin_disabled"
down_revision: str | None = "0002_users_updated_at_trigger"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column("disabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "disabled", schema=SCHEMA)
    op.drop_column("users", "is_admin", schema=SCHEMA)
