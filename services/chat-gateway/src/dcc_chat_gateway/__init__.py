"""Chat gateway service."""

import os

__version__ = "0.8.0"


def build_version() -> str:
    """Der Baustempel dieses Laufs — der kurze Commit-SHA, den die CI beim
    Bauen als ``PULSE_BUILD_VERSION`` ins Image schreibt (Cloud-Einzel-Images
    und All-in-One tragen denselben Stempel, wenn sie aus demselben Commit
    gebaut sind). Ohne CI-Bau (Dev-Stack, lokale Pytests) steht hier ``dev``
    — ehrlich: hier lief kein Bauprozess mit.

    Bewusst eine Funktion statt einer Import-Zeit-Konstante: Tests setzen die
    Variable per ``monkeypatch`` und lesen sie danach sofort, ohne das Modul
    neu importieren zu muessen.

    Abzugrenzen von ``__version__``: die ist die handgesetzte KOMPATIBILITAETS-
    Nummer (Sprachstand App<->Server, s. ``web/src/lib/api/constants.ts``) und
    bewegt sich nur bei Breaking-Changes — sie sagt nichts darueber, welcher
    Stand laeuft. Genau das leistet der Baustempel.
    """
    return os.environ.get("PULSE_BUILD_VERSION", "dev")
