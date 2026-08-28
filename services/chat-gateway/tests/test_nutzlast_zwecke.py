"""Prufstein fuer die Zweck-Liste in ``schluessel_nachweis.baue_nutzlast``.

**Warum ein Test auf einen Docstring.** Die Liste ist die einzige Stelle, an
der steht, welche Zwecke im Umlauf sind — und der Zweck ist es, was zwei
Verfahren gegenseitig blind fuereinander macht. Wer einen neuen erfindet und
die Liste vergisst, bricht nichts: die Sicherheitsaussage stimmt weiter, nur
die Aufzaehlung nicht. Genau das ist schon einmal passiert (die Liste stand
auf zwei, waehrend es fuenf waren), und ohne Prufstein faellt es erst dem
naechsten Leser auf.

Geprueft wird gegen den QUELLTEXT der Routen, nicht gegen eine zweite Liste:
eine zweite Liste haette dasselbe Problem wie die erste.
"""

from __future__ import annotations

import re
from pathlib import Path

import dcc_chat_gateway.schluessel_nachweis as nachweis

_ROUTEN = Path(nachweis.__file__).parent


def _zwecke_im_quelltext() -> set[str]:
    """Sammelt jedes ``baue_nutzlast("…")`` im Dienst — der erste Parameter."""
    muster = re.compile(r"baue_nutzlast\(\s*[\"']([a-z0-9-]+)[\"']")
    gefunden: set[str] = set()
    for datei in _ROUTEN.rglob("*.py"):
        gefunden.update(muster.findall(datei.read_text(encoding="utf-8")))
    return gefunden


def test_zweck_liste_im_docstring_ist_vollstaendig():
    doku = nachweis.baue_nutzlast.__doc__ or ""
    fehlend = sorted(z for z in _zwecke_im_quelltext() if f"``{z}``" not in doku)
    assert not fehlend, (
        "Diese Zwecke werden benutzt, stehen aber nicht in der Aufzaehlung im "
        f"Docstring von baue_nutzlast: {fehlend}"
    )


def test_prufstein_findet_ueberhaupt_etwas():
    """Gegenprobe zum Prufstein selbst.

    Faende das Muster nichts — weil sich der Aufrufstil aendert oder der Pfad
    nicht mehr stimmt —, waere der Test oben stumm gruen und damit wertlos.
    Die Untergrenze ist bewusst niedrig: sie soll ein LEERES Ergebnis fangen,
    nicht eine Zahl festschreiben, die bei jeder neuen Route zu pflegen waere.
    """
    assert len(_zwecke_im_quelltext()) >= 5
