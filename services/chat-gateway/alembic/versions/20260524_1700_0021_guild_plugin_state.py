"""guild plugin state

Backend-State-Storage für Plugin-System Stufe C: ein generischer
``(guild_id, plugin_name) → JSONB``-Store, in dem Plugins ihren
**guild-scoped** Server-State persistieren. Erster Konsument ist
``tamagotchi`` (PR3 "Server-shared Tamagotchi"): ein Pet pro Guild,
alle Mitglieder füttern/streicheln gemeinsam.

Kein FK auf ``auth.users`` (Cross-Service-Grenze — auth & chat haben
getrennte Schemas, siehe ``CLAUDE.md``-Anti-Pattern). ``plugin_name``
ist TEXT, kein Enum, weil Plugins zur Compile-Zeit nicht bekannt sind.

ON DELETE CASCADE auf ``chat.guilds``: löscht ein Owner seinen Server,
fliegen die Plugin-State-Blobs direkt mit raus. Dieselbe Cascade-Logik
wie ``guild_plugins`` (siehe Migration 0020).

Revision ID: 0021_guild_plugin_state
Revises: 0020_plugin_admin_activation
Create Date: 2026-05-24 17:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021_guild_plugin_state"
down_revision: str | None = "0020_plugin_admin_activation"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # JSONB nur unter Postgres — die Tests laufen auf SQLite, dort fällt
    # SQLAlchemy auf einen generischen JSON-Type (TEXT) zurück. Atomar-
    # Update über ``jsonb_set`` ist ein PG-only Feature; in den Tests
    # nutzen wir entweder den fallback-Pfad (Read-Modify-Write) oder
    # SQLAlchemys ``with_variant``. Default ist auf SQLite leerer Dict-
    # String, auf Postgres ``'{}'::jsonb``.
    op.create_table(
        "guild_plugin_state",
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("plugin_name", sa.Text(), nullable=False),
        sa.Column(
            "state",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Nullable: ein System-Default-Insert (z.B. erstes Op-Auto-Create)
        # hat keinen "echten" User-Akteur. Cross-Service-Grenze → kein FK
        # auf auth.users.
        sa.Column(
            "updated_by_user_id", sa.BigInteger(), nullable=True
        ),
        sa.PrimaryKeyConstraint(
            "guild_id", "plugin_name", name="pk_guild_plugin_state"
        ),
        # Cascade auf guilds: Server-Delete räumt allen Plugin-State mit.
        sa.ForeignKeyConstraint(
            ["guild_id"],
            [f"{SCHEMA}.guilds.id"],
            ondelete="CASCADE",
            name="fk_guild_plugin_state_guild",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_guild_plugin_state_plugin",
        "guild_plugin_state",
        ["plugin_name"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_guild_plugin_state_plugin",
        "guild_plugin_state",
        schema=SCHEMA,
    )
    op.drop_table("guild_plugin_state", schema=SCHEMA)
