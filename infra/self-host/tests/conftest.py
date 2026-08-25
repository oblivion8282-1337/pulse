"""Testwerkzeug für die Shell-Skripte des Self-Host-Containers.

Die cont-init-Skripte laufen im Container von oben nach unten durch; sourcen
geht deshalb nicht. Stattdessen wird die zu prüfende Funktion herausgeschnitten
und einzeln gefahren.
"""

from __future__ import annotations

import pathlib
import subprocess

import pytest

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"


def _schneide(quelle: str, name: str) -> str:
    zeilen = quelle.split("\n")
    start = next(
        (i for i, z in enumerate(zeilen) if z.startswith(f"{name}() ") or z.startswith(f"{name}()")),
        None,
    )
    assert start is not None, f"Funktion {name}() nicht gefunden — Skript umgebaut?"
    ende = next((i for i, z in enumerate(zeilen) if i > start and z == "}"), None)
    assert ende is not None, f"kein Ende fuer {name}()"
    return "\n".join(zeilen[start : ende + 1])


@pytest.fixture
def skript_funktion():
    """Gibt den Quelltext einer Shell-Funktion aus einem Skript unter s6/ zurück."""

    def hole(pfad: str, name: str) -> str:
        datei = S6 / pfad
        assert datei.is_file(), f"{datei} fehlt"
        return _schneide(datei.read_text(encoding="utf-8"), name)

    return hole


@pytest.fixture
def bash_lauf(tmp_path):
    """Führt ein bash-Skript mit einem PATH aus, auf dem gefälschte Kommandos liegen."""

    def lauf(skript: str, faelschungen: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        binde = tmp_path / "bin"
        binde.mkdir(exist_ok=True)
        for name, inhalt in (faelschungen or {}).items():
            ziel = binde / name
            ziel.write_text(inhalt, encoding="utf-8")
            ziel.chmod(0o755)
        import os

        umgebung = {**os.environ, "PATH": f"{binde}:{os.environ['PATH']}"}
        return subprocess.run(
            ["bash", "-c", skript], capture_output=True, text=True, env=umgebung
        )

    return lauf
