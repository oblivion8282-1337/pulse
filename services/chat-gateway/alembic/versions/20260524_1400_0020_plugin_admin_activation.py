"""plugin admin activation

Zwei-Ebenen-Aktivierungsmodell für das Pulse-Plugin-System
(ersetzt die per-User-Aktivierung aus Schritt 6):

* ``chat.instance_plugin_allowlist`` — vom Bootstrap-Admin gepflegt.
  Was darf auf dieser Pulse-Instanz überhaupt geladen werden?
* ``chat.guild_plugins`` — vom Guild-Admin (``MANAGE_GUILD``) pro Server
  gepflegt. Plugin muss in der Allowlist stehen; ``hello`` ist ein
  Sonderfall (gilt immer als aktiviert, ist im Frontend nicht togglebar
  und kann nicht aus der Allowlist entfernt werden).

Keine FKs auf ``auth.users`` (cross-service grenze — auth & chat haben
getrennte Schemas, siehe ``CLAUDE.md``-Anti-Pattern "shared DB-Tabellen").
``plugin_name`` ist TEXT statt Enum, weil Plugins zur Compile-Zeit nicht
bekannt sind.

Seed: ``hello`` wird im upgrade()-Block in die Allowlist eingetragen,
damit der Loader-Smoketest auch nach einem Fresh-Deploy direkt grün ist.
Der Loader hat zusätzlich ein Self-Heal, das diesen Insert idempotent
wiederholt — falls die Migration mal gelaufen ist und ein Admin ``hello``
manuell entfernt hat, kommt es beim nächsten Startup zurück.

Revision ID: 0020_plugin_admin_activation
Revises: 0019_user_preferences
Create Date: 2026-05-24 14:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0020_plugin_admin_activation"
down_revision: str | None = "0019_user_preferences"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "instance_plugin_allowlist",
        sa.Column("plugin_name", sa.Text(), nullable=False),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Nullable: der Bootstrap-Seed (``hello``) hat keinen Akteur.
        # Cross-service-Grenze → kein FK auf auth.users.
        sa.Column("added_by_user_id", sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint(
            "plugin_name", name="pk_instance_plugin_allowlist"
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "guild_plugins",
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("plugin_name", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("enabled_by_user_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "enabled_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "guild_id", "plugin_name", name="pk_guild_plugins"
        ),
        # Cascade auf guilds: löscht ein Owner seinen Server, fliegen
        # die Plugin-Toggle-Rows direkt mit raus. Die Allowlist-Seite
        # bleibt unberührt — Allowlist ist instanzweit, nicht guildweit.
        sa.ForeignKeyConstraint(
            ["guild_id"],
            [f"{SCHEMA}.guilds.id"],
            ondelete="CASCADE",
            name="fk_guild_plugins_guild",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_guild_plugins_plugin",
        "guild_plugins",
        ["plugin_name"],
        schema=SCHEMA,
    )

    # Seed: hello-Plugin ist immer in der Allowlist. ON CONFLICT macht
    # die Migration idempotent (falls jemand sie auf einer DB läuft,
    # in der das Self-Heal des Loaders den Insert schon gemacht hat).
    op.execute(
        sa.text(
            f"INSERT INTO {SCHEMA}.instance_plugin_allowlist "
            "(plugin_name, added_by_user_id) "
            "VALUES ('hello', NULL) "
            "ON CONFLICT (plugin_name) DO NOTHING"
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_guild_plugins_plugin", "guild_plugins", schema=SCHEMA
    )
    op.drop_table("guild_plugins", schema=SCHEMA)
    op.drop_table("instance_plugin_allowlist", schema=SCHEMA)
