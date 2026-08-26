"""Anmelde-Kette und Rueckverweis fuer Refresh-Token.

Warum
-----
``/refresh`` behandelte einen wiederholt vorgelegten Token immer als Diebstahl
und widerrief daraufhin **alle** Token des Kontos. Beides war zu grob, und die
Produktionsdatenbank zeigte am 2026-08-26, was es kostet: ein einzelner Nutzer
verlor in 17 Tagen 28-mal seine Sitzung, ein Vorfall riss sechs Anmelde-Ketten
auf einmal mit — darunter zwei aus der Vorwoche und eine aus einem zweiten
Browser, in dem er gerade nicht einmal arbeitete.

Die beiden Spalten beantworten die zwei Fragen, die dafuer fehlten:

* ``family_id`` — **zu welcher Anmeldung gehoert diese Zeile?** Beim Anmelden
  vergeben, bei jeder Rotation vererbt. Sie ist die neue Reichweite des
  Widerrufs: ein Verdacht in einer Kette sagt nichts ueber die anderen Geraete
  desselben Nutzers.
* ``replaced_by`` — **hat der Klient seinen Nachfolger je bekommen?** Wurde er
  nie eingeloest, war der Aufruf unterwegs abgerissen (Ruhezustand,
  Netzwechsel) und der wiederholte Token ist harmlos. Wurde er benutzt, sind
  zwei Parteien im Umlauf und der Verdacht bleibt bestehen.
* ``nachgereicht`` — **wie oft ging das in dieser Kette schon so?** Ohne diese
  Grenze faengt die Frage nach dem Nachfolger den mitlaufenden Dieb nicht: er
  liegt nie zwei Schritte zurueck und bliebe unbegrenzt unerkannt (nachgemessen,
  s. ``refresh_kette.NACHREICH_LIMIT``). Der Zaehler wandert bei jeder Rotation
  mit — an der einzelnen Zeile waere er wirkungslos.

Backfill und Uebergang
----------------------
Bestandszeilen bekommen ``family_id = jti`` — jede steht damit fuer sich.
Zusammenfassen liesse sich nur raten (gleiche IP-Pruefsumme, gleicher
Browser-Kennstring), und ein falsch geratener Bezug meldete beim ersten Vorfall
das falsche Geraet ab. Genau dieselbe Ueberlegung wie beim Verzicht auf einen
Backfill in 0049.

``replaced_by`` bleibt bei Bestandszeilen leer. Fuer sie ist ein wiederholt
vorgelegter Token deshalb nicht heilbar — der Nutzer sieht dort noch einmal ein
401, seine anderen Geraete aber bleiben schon verschont. Mit dem ersten
``/refresh`` nach dem Ausrollen traegt jede weiterlaufende Kette den Verweis.

``family_id`` und ``replaced_by`` sind **nullable und ohne Vorgabewert**. Das
ist Absicht: waehrend des Ausrollens schreibt der alte Code noch Zeilen, und der
kennt die Spalten nicht. Ein ``NOT NULL`` liesse in genau diesem Fenster jede
Anmeldung auflaufen. ``NULL`` heisst im Code "steht allein"
(s. ``refresh_kette``). ``nachgereicht`` kann dagegen NOT NULL sein, weil sein
Wert fuer jede Zeile derselbe ist und eine Vorgabe ihn deshalb tragen kann.

Revision ID: 0050_refresh_token_kette
Revises: 0049_refresh_token_session_link
Create Date: 2026-08-26 21:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0050_refresh_token_kette"
down_revision: str | None = "0049_refresh_token_session_link"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "refresh_tokens",
        sa.Column("replaced_by", postgresql.UUID(as_uuid=True), nullable=True),
        schema=SCHEMA,
    )
    # NOT NULL mit Vorgabe: der alte Code kennt die Spalte waehrend des
    # Ausrollens nicht und schreibt sie nicht mit — die Vorgabe traegt seine
    # Zeilen, ohne dass eine Anmeldung auflaeuft. Bei den beiden Spalten oben
    # geht das nicht, weil ihr Wert je Zeile verschieden ist.
    op.add_column(
        "refresh_tokens",
        sa.Column(
            "nachgereicht", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        schema=SCHEMA,
    )
    # Jede Bestandszeile wird ihre eigene Kette (s. Kopf). Ein einzelnes UPDATE
    # ueber eine Tabelle dieser Groessenordnung — rund 12 000 Zeilen zum
    # Zeitpunkt des Schreibens — ist in einem Wimpernschlag durch.
    op.execute(f"UPDATE {SCHEMA}.refresh_tokens SET family_id = jti")
    # Der Index deckt genau die Abfrage des Widerrufs ab: die noch lebenden
    # Zeilen EINER Kette. Teilindex, weil widerrufene Zeilen nie gesucht werden
    # und den Baum sonst mit der Zeit dominierten — sie werden erst nach 30
    # Tagen weggeraeumt (``cleanup.py``).
    op.create_index(
        "ix_refresh_tokens_family_active",
        "refresh_tokens",
        ["family_id"],
        schema=SCHEMA,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_family_active", "refresh_tokens", schema=SCHEMA)
    op.drop_column("refresh_tokens", "nachgereicht", schema=SCHEMA)
    op.drop_column("refresh_tokens", "replaced_by", schema=SCHEMA)
    op.drop_column("refresh_tokens", "family_id", schema=SCHEMA)
