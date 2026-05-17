"""auth_settings singleton

Singleton row holding auth-svc-owned server-wide toggles the admin panel
mutates at runtime. First column: ``registration_mode`` (controls /register).
Seeded by the migration so reads never have to handle the "no row" case.

chat-gateway holds its own ``chat_settings`` row separately — per PLAN.md,
services never share DB tables.

Revision ID: 0004_auth_settings
Revises: 0003_users_admin_disabled
Create Date: 2026-05-17 13:10:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0004_auth_settings"
down_revision: str | None = "0003_users_admin_disabled"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "auth_settings",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column(
            "registration_mode",
            sa.String(length=16),
            server_default="open",
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_auth_settings_singleton"),
        schema=SCHEMA,
    )
    # Seed the singleton so reads always find it.
    op.execute(f"INSERT INTO {SCHEMA}.auth_settings (id) VALUES (1)")


def downgrade() -> None:
    op.drop_table("auth_settings", schema=SCHEMA)
