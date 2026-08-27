"""Genau EIN Alembic-Kopf — sonst bricht der naechste Deploy.

Gleicher Waechter wie in ``services/chat-gateway/tests/test_alembic_koepfe.py``;
die ausfuehrliche Begruendung steht dort. Kurz: beide Migrate-Container fahren
``alembic upgrade head``, und Alembic verweigert das bei zwei Koepfen. Zwei
Zweige, die je eine Migration auf denselben Vorgaenger setzen, sind einzeln
gruen und erzeugen die Gabelung erst beim Landen des zweiten.

Bewusst dupliziert statt geteilt: jeder Dienst hat seine eigene
Migrationskette und sein eigenes ``alembic.ini``. Ein gemeinsamer Helfer
muesste beide Pfade kennen und liefe trotzdem zweimal — der Gewinn waere
geringer als die zusaetzliche Kopplung.
"""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_genau_ein_alembic_kopf() -> None:
    dienst = Path(__file__).resolve().parents[1]
    cfg = Config(str(dienst / "alembic.ini"))
    cfg.set_main_option("script_location", str(dienst / "alembic"))

    koepfe = ScriptDirectory.from_config(cfg).get_heads()

    assert len(koepfe) == 1, (
        "Alembic hat mehrere Koepfe: "
        + ", ".join(sorted(koepfe))
        + ". `alembic upgrade head` bricht damit ab und der Deploy schlaegt "
        "fehl. Behebung: das down_revision der zuletzt hinzugekommenen "
        "Migration auf den anderen Kopf setzen, damit wieder eine Kette "
        "entsteht."
    )
