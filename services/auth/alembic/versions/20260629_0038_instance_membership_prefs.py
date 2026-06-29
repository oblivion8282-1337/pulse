"""user_instance_memberships: per-user Label + Notification-Modus

Macht die zwei bisher gerätelokalen Server-Präferenzen account-basiert, damit
sie über Geräte/Browser hinweg gelten (Lücke aus dem Gap-Scan 2026-06-29):
- ``user_label``: der vom User vergebene Anzeigename des Servers (NULL = den
  Hostnamen anzeigen).
- ``notification_mode``: 'all' | 'mentions' | 'none' (Default 'mentions').

Revision ID: 0038_instance_membership_prefs
Revises: 9999_drop_user_cloud_backup
Create Date: 2026-06-29 09:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0038_instance_membership_prefs"
down_revision: str | None = "9999_drop_user_cloud_backup"
branch_labels = None
depends_on = None

SCHEMA = "auth"
_TABLE = "user_instance_memberships"


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column("user_label", sa.Text, nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        _TABLE,
        sa.Column(
            "notification_mode",
            sa.Text,
            nullable=False,
            server_default="mentions",
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column(_TABLE, "notification_mode", schema=SCHEMA)
    op.drop_column(_TABLE, "user_label", schema=SCHEMA)
