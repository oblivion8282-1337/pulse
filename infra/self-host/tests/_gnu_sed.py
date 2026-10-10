"""Prüft, ob auf diesem Rechner GNU-`sed` im PATH steht.

**Warum das eine eigene Datei ist.** Zwei Prüfungen fahren Skript-Ausschnitte
aus dem Self-Host-Image unverändert auf dem Host aus — das ist der Sinn der
Sache: der Fehler, gegen den sie gebaut wurden, steckte in der
Backslash-Verschachtelung einer `sed`-Zeile, und ein Abtippen im Test hätte
dieselbe Falle noch einmal aufgerissen.

Der Preis: sie brauchen dasselbe `sed` wie der Container, und das ist GNU-sed.
**Auf macOS ist das BSD-sed**, und das spricht die beiden Formen nicht, die in
den Skripten stehen: `a\\` zum Anfügen (`invalid command code`) und `-i` ohne
Backup-Suffix. Die Skripte sind damit NICHT kaputt — sie laufen im
Linux-Container, und dort ist GNU-sed richtig.

**Warum überspringen statt reparieren.** Ein Test, der auf einer ganzen
Plattform nie grün werden kann, meldet dort keine Regression mehr — er macht
nur das Gate dauerhaft rot, und ein dauerhaft rotes Gate wird irgendwann
ignoriert. Genau diese Lehre steht im `CLAUDE.md`. Die Skripte für beide
sed-Dialekte umzuschreiben wäre die teurere Antwort: sie änderte
ausgelieferten Code ohne Nutzen für den Betrieb, nur damit ein Test auf einem
Rechner läuft, der nicht das Ziel ist.

In der Linux-CI und auf Linux-Arbeitsrechnern laufen die Prüfungen
unverändert. Wer sie auf dem Mac fahren will: `brew install gnu-sed` und
dessen `gsed` als `sed` in den PATH hängen.
"""

from __future__ import annotations

import shutil
import subprocess


def gnu_sed_vorhanden() -> bool:
    """`True`, wenn `sed` GNU-sed ist. BSD-sed kennt `--version` nicht."""
    if shutil.which("sed") is None:
        return False
    try:
        fertig = subprocess.run(
            ["sed", "--version"], capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return fertig.returncode == 0 and "GNU sed" in fertig.stdout


GRUND = (
    "Braucht GNU-sed — die Skript-Ausschnitte stammen aus dem Linux-Container "
    "(s. Modul-Docstring in _gnu_sed.py)"
)
