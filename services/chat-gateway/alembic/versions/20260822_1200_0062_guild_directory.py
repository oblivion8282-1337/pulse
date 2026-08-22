"""guilds: Verzeichnis-Listung + Kategorie (Entdecken-Bereich)

Der Entdecken-Bildschirm des Mobil-Umbaus zeigt oeffentliche Communities als
durchsuchbare Liste. Bis hierher konnte der Server nur EINE bekannte Adresse
aufloesen (``GET /c/{handle}``); ein Schaufenster gab es nicht.

**Warum eine zweite Spalte statt einfach ``is_public``:** eine oeffentliche
Adresse bedeutet „wer den Link kennt, kommt rein". Ein durchsuchbares
Verzeichnis bedeutet „ich moechte gefunden werden". Das sind zwei
verschiedene Zustimmungen. Wer heute eine oeffentliche Adresse hat, hat der
zweiten nie zugestimmt — deshalb kommt ``listed`` mit ``false`` an und es gibt
**kein Nachziehen bestehender Zeilen**. Der Schalter sitzt im
``GuildPublicAddressEditor`` und verlangt ``MANAGE_GUILD``.

``category`` traegt eine der festen Kennungen aus ``COMMUNITY_CATEGORIES``
(gaming | music | tech | creative | other) — die Filter-Chips des
Verzeichnisses zeigen genau diese. Freie Schlagworte waeren Wildwuchs und
braeuchten eine eigene Tabelle.

Revision ID: 0062_guild_directory
Revises: 0061_device_limit
Create Date: 2026-08-22 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0062_guild_directory"
down_revision: str | None = "0061_device_limit"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column(
            "listed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("category", sa.String(length=16), nullable=True),
        schema=SCHEMA,
    )
    # Der Verzeichnis-Endpunkt filtert immer auf beide Flaggen zugleich.
    # Teil-Index, weil die grosse Mehrheit der Zeilen nicht gelistet ist.
    op.create_index(
        "ix_guilds_directory",
        "guilds",
        ["category"],
        unique=False,
        schema=SCHEMA,
        postgresql_where=sa.text("is_public AND listed"),
        sqlite_where=sa.text("is_public AND listed"),
    )


def downgrade() -> None:
    op.drop_index("ix_guilds_directory", table_name="guilds", schema=SCHEMA)
    op.drop_column("guilds", "category", schema=SCHEMA)
    op.drop_column("guilds", "listed", schema=SCHEMA)
