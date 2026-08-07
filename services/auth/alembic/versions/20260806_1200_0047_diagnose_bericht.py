"""Diagnose-Berichte: strukturierter Bericht statt Rohtext, plus Zuschauerseite.

Vier Aenderungen an `auth.experimental_logs`:

* `role` — welche Seite berichtet ("sender" | "viewer"). Bis hierher meldete
  ausschliesslich die Senderseite; die Zuschauerseite fehlte vollstaendig.
* `channel_id` — der Kanal, dessen Stream berichtet wird. Mit Index, weil genau
  danach gesucht wird, um Server- und Zuschauersicht zu verbinden: der Pfad im
  MediaMTX-Log heisst `channel-<kanal>-<sender>-<nonce>`, die Kanalkennung ist
  also das gemeinsame Stueck.

  **Hier stand zuerst `session_id`, gedacht als die MediaMTX-Sitzungskennung
  (`[session 9a28cbc6]`). Das war ein Irrtum, und er ist am Quelltext geprueft:**
  das Log-Praefix ist `hex(session.uuid[:4])`, der `Location`-Header der
  WHEP-Antwort traegt dagegen `session.secret` — eine andere UUID, aus der die
  erste nicht ableitbar ist. Der Client kann die Log-Kennung also gar nicht
  erfahren. Und `secret` autorisiert `PATCH`/`DELETE` auf die Sitzung; es
  hochzuladen hiesse, ein Sitzungs-Token in eine Diagnosetabelle zu schreiben.
  Eine Spalte, die niemand befuellen kann, waere ein toter Index geblieben.
* `report` — der strukturierte Bericht (JSONB auf Postgres).
* `log_text` wird NULLABLE. Ein Zuschauerbericht entsteht im Browser und hat
  keine `sidecar.log`.

Die Lockerung von `log_text` ist der einzige Schritt, der sich nicht sauber
zuruecknehmen laesst: sobald ein Zuschauerbericht drinsteht, wuerde ein
`NOT NULL` beim Downgrade scheitern. Das `downgrade()` raeumt solche Zeilen
deshalb ausdruecklich weg, statt mit einem Integritaetsfehler stehenzubleiben —
sie sind ohne die neuen Spalten ohnehin bedeutungslos.

Revision ID: 0047_diagnose_bericht
Revises: 0046_complaint_submitter_user
Create Date: 2026-08-06 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0047_diagnose_bericht"
down_revision: str | None = "0046_complaint_submitter_user"
branch_labels = None
depends_on = None

SCHEMA = "auth"

# JSONB auf Postgres, plain JSON sonst — identisch zur Modell-Definition in
# `models_experimental.py`. Alembic laeuft in Produktion nur gegen Postgres,
# aber die Variante haelt die Migration mit dem Modell in einer Zeile.
_JSON = postgresql.JSONB().with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.add_column("experimental_logs", sa.Column("role", sa.Text(), nullable=True), schema=SCHEMA)
    op.add_column(
        "experimental_logs", sa.Column("channel_id", sa.Text(), nullable=True), schema=SCHEMA
    )
    op.add_column("experimental_logs", sa.Column("report", _JSON, nullable=True), schema=SCHEMA)
    op.create_index(
        "ix_experimental_logs_channel_id",
        "experimental_logs",
        ["channel_id"],
        schema=SCHEMA,
    )
    op.alter_column(
        "experimental_logs", "log_text", existing_type=sa.Text(), nullable=True, schema=SCHEMA
    )


def downgrade() -> None:
    # Zuerst die Zeilen weg, die ohne `log_text` auskamen — sonst scheitert das
    # `NOT NULL` unten an ihnen. Sie sind Zuschauerberichte und ohne die
    # Berichts-Spalte, die gleich mit faellt, ohne Aussage.
    op.execute(f"DELETE FROM {SCHEMA}.experimental_logs WHERE log_text IS NULL")
    op.alter_column(
        "experimental_logs", "log_text", existing_type=sa.Text(), nullable=False, schema=SCHEMA
    )
    op.drop_index("ix_experimental_logs_channel_id", "experimental_logs", schema=SCHEMA)
    op.drop_column("experimental_logs", "report", schema=SCHEMA)
    op.drop_column("experimental_logs", "channel_id", schema=SCHEMA)
    op.drop_column("experimental_logs", "role", schema=SCHEMA)
