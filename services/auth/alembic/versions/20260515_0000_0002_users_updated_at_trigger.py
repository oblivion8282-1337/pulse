"""users.updated_at trigger

SQLAlchemy's ``onupdate=func.now()`` only fires when the column is explicitly
named in an ORM UPDATE. Without that, ``user.updated_at`` stays stuck at the
``created_at`` value — so the avatar-upload (and every other ORM update) leaves
the timestamp stale. We move the responsibility to Postgres via a
``BEFORE UPDATE`` trigger which is authoritative and doesn't depend on ORM
behaviour.

Revision ID: 0002_users_updated_at_trigger
Revises: 0001_initial
Create Date: 2026-05-15 00:00:00
"""
from __future__ import annotations

from alembic import op

revision: str = "0002_users_updated_at_trigger"
down_revision: str | None = "0001_initial"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION {SCHEMA}.set_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER users_set_updated_at
        BEFORE UPDATE ON {SCHEMA}.users
        FOR EACH ROW
        EXECUTE FUNCTION {SCHEMA}.set_updated_at();
        """
    )


def downgrade() -> None:
    op.execute(f"DROP TRIGGER IF EXISTS users_set_updated_at ON {SCHEMA}.users")
    op.execute(f"DROP FUNCTION IF EXISTS {SCHEMA}.set_updated_at()")
