"""message_pinned_at — Pinned Messages pro Kanal

Eine nullable ``pinned_at``-Spalte an ``messages`` statt einer Pin-Tabelle:
der Zeitstempel ordnet die Pin-Liste (Discord ordnet nach Pin-Zeit) und NULL
ist zugleich „nicht angepinnt“. Max. 50 Pins pro Kanal — dafür braucht es
keine eigene Entität. Der Pin-Index ist partial (nur tatsächliche Pins),
damit er neben der größten Tabelle des Schemas flach bleibt.

Nachrichten-Soft-Delete löst den Pin in der Route (nicht per Trigger) —
dort liegt die restliche Aufräumlogik ohnehin.

Revision ID: 0064_message_pinned_at
Revises: 0063_einladungen_ohne_dm
Create Date: 2026-09-01 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0064_message_pinned_at"
down_revision: str | None = "0063_einladungen_ohne_dm"
branch_labels = None
depends_on = None

SCHEMA = "chat"
TABLE = "messages"
INDEX = "ix_messages_pinned"


def upgrade() -> None:
    op.add_column(
        TABLE,
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    # Partial-Index nur auf Postgres — SQLite-Dev-Staende (create_all) bauen
    # ihn aus den Modellen, und ein WHERE-Klausel-Index dort via Alembic zu
    # spiegeln lohnt nicht.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.create_index(
            INDEX,
            TABLE,
            ["channel_id", "pinned_at"],
            schema=SCHEMA,
            postgresql_where=sa.text("pinned_at IS NOT NULL"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.drop_index(INDEX, table_name=TABLE, schema=SCHEMA)
    op.drop_column(TABLE, "pinned_at", schema=SCHEMA)
