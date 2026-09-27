"""Ein LIVE device_pubkey gehört genau einem Konto (Bughunt Runde 42, 4.6)

Partieller Unique-Index über alle Konten hinweg: zwei gleichzeitige
ERSTVERÖFFENTLICHUNGEN desselben Geraeteschlüssels durch verschiedene
Konten gewannen bisher beide die 409-Vorabprüfung (check-then-act) und
hinterließen zwei Zeilen — ``_bundle_laden`` fand dann zwei Buendel zu
einem Pubkey (MultipleResultsFound → 500 für jede Einlieferung im
Gespräch). Der Index ist die DB-seitige Rückfallebung, die Route fängt
den Verstoß als 409. Grabsteine (``verfallen_am``/``entfernt_am``)
zählen nicht — eine verwaiste Kennung blockiert keine Neuanlage.

Kollisions-Bestand: falls eine bestehende DB durch das frühere
Wettlauf-Fenster bereits zwei LIVE-Zeilen zu einem Pubkey trägt, schlägt
diese Migration fehl (eindeutiger Verstoß beim Indexbau). Das ist
absicht — der Befund ist real und muss von Hand bereinigt werden
(z. B. ältere Zeile auf ``entfernt_am = now()``, dann Migration erneut).

Anmerkung zur Nummerierung: `feat/mobile` trägt ebenfalls 0091+er
Revisionen (rein additiv); bei der Zusammenführung entscheidet wie schon
bei 220119df9614 die Merge-Revision, und tests/test_alembic_koepfe.py
wacht darüber.

Revision ID: 0091_pubkey_eindeutig
Revises: 0090_ablage_pulse
Create Date: 2026-09-21 10:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0091_pubkey_eindeutig"
down_revision: str | Sequence[str] | None = "0090_ablage_pulse"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "uq_device_key_bundles_pubkey_live",
        "device_key_bundles",
        ["device_pubkey"],
        unique=True,
        postgresql_where="verfallen_am IS NULL AND entfernt_am IS NULL",
        sqlite_where="verfallen_am IS NULL AND entfernt_am IS NULL",
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_device_key_bundles_pubkey_live",
        table_name="device_key_bundles",
        schema=SCHEMA,
    )
