"""message_attachments.laufwerk_verteilt_am — Anhang liegt in den Laufwerken

Spec: ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`` §11.1.

Ein verschluesselter DM-Anhang wandert seit dieser Aenderung in den
Cloud-Ordner JEDES Beteiligten, und Pulse gibt danach seine eigene Kopie im
Objektspeicher frei. Diese Spalte haelt fest, DASS das passiert ist.

**Warum eine Spalte und nicht bloss „der Klumpen ist halt weg".** Ohne sie
haette ``POST /postfach/anhaenge/{id}/abrufadresse`` weiter eine vorsignierte
Adresse auf ein geloeschtes Objekt herausgegeben; der Klient waere in einen
404 des Objektspeichers gelaufen, der von „Anhang verfallen" nicht zu
unterscheiden ist. Mit der Spalte antwortet die Route stattdessen 410 mit
einer eigenen Kennung — der Klient weiss dann sicher, dass er in seinem
eigenen Laufwerk nachsehen muss, statt zu raten. Genau die Sorte stiller
Fehlschlag, die dieses Vorhaben vermeiden soll.

Die Spalte traegt **keinen Pfad**: er ergibt sich rein rechnerisch aus der
Anhang-Kennung (``ablage_anhang_verteilung.archiv_pfad``), und beide Seiten
leiten ihn unabhaengig ab. Ein gespeicherter Pfad waere eine zweite Wahrheit.

Kein Backfill: bestehende Zeilen bleiben NULL und damit auf dem heutigen
Weg (Pulse haelt den Klumpen, bis der letzte Umschlag quittiert ist).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0087_anhang_laufwerk_verteilt"
down_revision: str | None = "0086_ablage_konto_laufwerk"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "message_attachments",
        sa.Column("laufwerk_verteilt_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("message_attachments", "laufwerk_verteilt_am", schema=SCHEMA)
