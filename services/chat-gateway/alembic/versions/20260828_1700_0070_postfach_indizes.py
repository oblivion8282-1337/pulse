"""postfach indizes — zwei fehlende Indexe, sequentielle Scans unter Last

Der Test-Suite auf SQLite faellt keiner der beiden auf; Postgres indiziert
Fremdschluessel NICHT automatisch, und beide Spalten werden mit jeder
Nachricht haeufiger abgefragt:

- ``dm_zustellungen.nutzlast_id`` — die ``NOT EXISTS``-Pruefung in
  ``routes/postfach_abholen.py`` (Quittung, JEDE Bestaetigung eines
  Klienten) und ``postfach_pflege.py::sweep_verwaiste_nutzlasten`` (jeder
  Aufraeum-Takt) filtern beide direkt auf diese Spalte. Der bestehende
  Index ``ix_dm_zustellungen_empfaenger`` beginnt mit
  ``empfaenger_device_pubkey`` und kann eine Suche nach ``nutzlast_id``
  allein nicht bedienen.
- ``device_key_bundles.device_pubkey`` — zwei Abfragen suchen NUR danach:
  der ``exists()``-Check in ``routes/postfach.py`` (fremdes Geraet erkannt,
  aber nicht Teilnehmer des Kanals) und der ``outerjoin`` in
  ``routes/postfach_abholen.py`` (Absender-Konto zu jeder Abholung, JEDE
  Abholung). Der bestehende ``UniqueConstraint(user_id, device_pubkey)``
  und ``ix_device_key_bundles_user`` beginnen beide mit ``user_id`` — ein
  zusammengesetzter Index kann eine Suche nach der zweiten Spalte allein
  nicht bedienen (Postgres braucht dafuer die gesuchte Spalte vorn).

Revision ID: 0070_postfach_indizes
Revises: 0069_curve25519
Create Date: 2026-08-28 17:00:00
"""

from __future__ import annotations

from alembic import op

revision: str = "0070_postfach_indizes"
down_revision: str | None = "0069_curve25519"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_index(
        "ix_dm_zustellungen_nutzlast", "dm_zustellungen", ["nutzlast_id"], schema=SCHEMA
    )
    op.create_index(
        "ix_device_key_bundles_pubkey",
        "device_key_bundles",
        ["device_pubkey"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_device_key_bundles_pubkey", table_name="device_key_bundles", schema=SCHEMA
    )
    op.drop_index(
        "ix_dm_zustellungen_nutzlast", table_name="dm_zustellungen", schema=SCHEMA
    )
