"""verschluesselte anhaenge — Bezug zur Nutzlast statt zur Nachricht (Etappe E)

Ein verschluesselt gesendeter Anhang kann NICHT an einer ``messages``-Zeile
haengen: verschluesselte Nachrichten erzeugen keine (Spec §4). Er gehoert
stattdessen an die Umschlaege, die seinen Dateischluessel tragen.

Zwei Aenderungen:

* ``dm_anhang_bezuege`` — Zuordnung Nutzlast ↔ Anhang. Viele-zu-viele, weil
  Olm je Empfaengergeraet eine EIGENE Nutzlast erzeugt: derselbe Anhang haengt
  bei einer DM an so vielen Nutzlasten, wie es Empfaengergeraete gibt. Beide
  Fremdschluessel kaskadieren — faellt eine Nutzlast (quittiert oder
  verfristet), faellt ihre Zuordnung mit, und der Anhang wird dadurch
  moeglicherweise verwaist (``postfach_pflege.py::sweep_verwaiste_anhaenge``).

* ``message_attachments.postfach_gebunden_am`` — der Zeitpunkt, zu dem der
  Anhang in eine Einlieferung aufgenommen wurde. Ohne diese Spalte sind zwei
  Zustaende nicht unterscheidbar, die entgegengesetzt behandelt werden
  muessen: ein frisch hochgeladener Anhang, dessen Umschlag noch unterwegs
  ist (NICHT loeschen), und ein zugestellter Anhang, dessen letzter Umschlag
  gerade wegfiel (loeschen). Beide haben ``message_id IS NULL`` und keine
  Bezugszeile. Die Spalte trennt zugleich die beiden Aufraeumwege sauber:
  der Anhang-Reaper (``routes/attachments.py``) nimmt nur ungebundene Zeilen,
  der Postfach-Lauf nur gebundene.

Die uebrigen Spalten mussten NICHT angefasst werden: ``filename``, ``mime``,
``width`` und ``height`` sind seit Migration 0007 nullable, ausdruecklich mit
diesem Fall als Begruendung.

Revision ID: 0073_verschl_anhaenge
Revises: 0072_gruppen_ersteller_fest
Create Date: 2026-08-28 20:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0073_verschl_anhaenge"
down_revision: str | None = "0072_gruppen_ersteller_fest"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "message_attachments",
        sa.Column("postfach_gebunden_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_table(
        "dm_anhang_bezuege",
        sa.Column("nutzlast_id", sa.BigInteger(), nullable=False),
        sa.Column("anhang_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("nutzlast_id", "anhang_id"),
        sa.ForeignKeyConstraint(
            ["nutzlast_id"], [f"{SCHEMA}.dm_nutzlasten.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["anhang_id"], [f"{SCHEMA}.message_attachments.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    # Der zusammengesetzte Primaerschluessel beginnt mit ``nutzlast_id`` und
    # kann eine Suche nach ``anhang_id`` allein nicht bedienen — genau die
    # faehrt aber jeder Aufraeumlauf ("hat dieser Anhang noch einen
    # Umschlag?"), derselbe Grund wie bei Migration 0070.
    op.create_index(
        "ix_dm_anhang_bezuege_anhang", "dm_anhang_bezuege", ["anhang_id"], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dm_anhang_bezuege_anhang", table_name="dm_anhang_bezuege", schema=SCHEMA
    )
    op.drop_table("dm_anhang_bezuege", schema=SCHEMA)
    op.drop_column("message_attachments", "postfach_gebunden_am", schema=SCHEMA)
