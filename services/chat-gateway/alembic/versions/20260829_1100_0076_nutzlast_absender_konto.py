"""nutzlast absender-konto — die Fairness-Grenze haengt am KONTO, nicht am Geraet

Belegter Fehler (2026-08-29): ``postfach_max_offene_zustellungen_je_absender_und_geraet``
zaehlte bisher ueber ``DmNutzlast.absender_device_pubkey`` — pro GERAET. Ein
Konto darf aber bis zu ``schluessel_max_buendel_je_konto`` (20) Geraete
fuehren. Zehn davon genuegen, um die Gesamt-Obergrenze eines Opfergeraets
(``postfach_max_offene_zustellungen_je_geraet``) allein zu fuellen, jedes
Geraet fuer sich innerhalb seiner eigenen "Zehntel"-Grenze — die Annahme "ein
Korrespondent = ein Geraet", auf der die alte Grenze beruhte, steht so nicht
im Code und trifft nicht zu.

Diese Spalte traegt das ABSENDER-KONTO direkt, gefuellt aus ``user.id`` des
authentifizierten Antragstellers (``routes/postfach.py``, bereits durch
``schluessel_nachweis.py::pruefe_geraet`` an dieses Zertifikat gebunden — kein
neuer Vertrauensschritt). Eine Herleitung ueber einen Join gegen
``DeviceKeyBundle.device_pubkey`` (wie ``routes/postfach_abholen.py`` es fuer
die ANZEIGE tut) waere hier die falsche Wahl: das Sendegeraet kann sich
zwischen Einliefern und einer spaeteren Zaehlung abmelden, sein Buendel
verschwindet dann (s. Kommentar an ``absender_curve25519``) — die Fairness-
Grenze braucht aber eine STABILE Kontozuordnung, keine, die mit dem Geraet
verwaist.

Nullable, aus demselben Grund wie ``absender_curve25519``: der Server
erzwingt sie nicht (Bestandszeilen aus Tests, die die Tabelle direkt
befuellen, kennen den Wert nicht) — die Route setzt sie bei jeder echten
Einlieferung.

Revision ID: 0076_absender_konto
Revises: 0075_umzug_kennung
Create Date: 2026-08-29 11:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0076_absender_konto"
down_revision: str | None = "0075_umzug_kennung"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "dm_nutzlasten",
        sa.Column("absender_user_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("dm_nutzlasten", "absender_user_id", schema=SCHEMA)
