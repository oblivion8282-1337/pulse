"""Genau EIN Alembic-Kopf — sonst bricht der naechste Deploy.

Beide Migrate-Container fahren ``alembic upgrade head``
(``infra/prod/docker-compose.yml``). Alembic verweigert diesen Befehl, sobald
zwei Revisionen ohne gemeinsames Kind nebeneinander stehen: „Multiple head
revisions are present". Der Container endet dann mit einem Fehler, und die
Dienste starten gegen ein Schema, das ihre Modelle nicht kennen.

**Wie zwei Koepfe entstehen, ohne dass es jemandem auffaellt:** zwei
Feature-Zweige legen je eine Migration an, beide mit demselben
``down_revision`` — dem Kopf, den sie beim Abzweigen vorfanden. Jeder Zweig
ist fuer sich gruen. Erst das Landen des zweiten erzeugt die Gabelung, und
zwar in einer Datei, die der zweite PR gar nicht anfasst. Genau deshalb faellt
es in keinem Review auf.

Das ist bei diesem Projekt kein Randfall: es wird ausdruecklich auf mehreren
Rechnern parallel an Zweigen gearbeitet (``CLAUDE.md``, Branch-Workflow).

Die Behebung ist eine Zeile: das ``down_revision`` der spaeter landenden
Migration auf den inzwischen gewachsenen Kopf setzen. Teuer ist nur, es erst
in der Produktion zu merken.
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
