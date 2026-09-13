"""Ohne diesen Test wäre ein kaputtes Schneidewerkzeug wortlos grün."""

import sys

import pytest

# Die Tests laufenen bash mit gefälschten Kommandos aus einem PATH-Ordner —
# unter Windows trennt der PATH mit „;“ und chmod(0o755) setzt kein
# Ausführungsbit, die Fälschung wird also nie gefunden. Die Skripte unter der
# Lupe gehören in den Linux-Selbsthost-Container; dort (und in der Linux-CI)
# laufen die Prüfungen unverändert.
if sys.platform == "win32":
    pytest.skip(
        "bash-lauf-Fälschungen brauchen Linux-PATH-Semantik — s. Modul-Docstring",
        allow_module_level=True,
    )


def test_schneidet_eine_bekannte_funktion(skript_funktion):
    quelle = skript_funktion("etc/s6-overlay/scripts/03-init-secrets.sh", "write_if_missing")
    assert "write_if_missing()" in quelle
    assert quelle.rstrip().endswith("}")


def test_meldet_eine_fehlende_funktion(skript_funktion):
    import pytest

    with pytest.raises(AssertionError, match="nicht gefunden"):
        skript_funktion("etc/s6-overlay/scripts/03-init-secrets.sh", "gibt_es_nicht")


def test_bash_lauf_nutzt_die_faelschung(bash_lauf):
    ergebnis = bash_lauf('docker ps', {"docker": '#!/bin/bash\necho GEFAELSCHT\n'})
    assert ergebnis.stdout.strip() == "GEFAELSCHT"
