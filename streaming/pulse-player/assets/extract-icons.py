#!/usr/bin/env python3
"""Holt die Symbole der Bedienleiste aus dem Lucide-Paket der Web-App.

WARUM AUS DEM PAKET UND NICHT VON HAND: Die Leiste im Player-Fenster soll
aussehen wie die in der App. Beide ziehen ihre Symbole damit aus **derselben
Quelle** — ein nachgezeichnetes Symbol waere von Anfang an eine zweite Wahrheit,
die beim naechsten Lucide-Update auseinanderlaeuft.

Das Paket liefert die Symbole als Svelte-Komponenten mit den Pfaddaten in einem
`iconNode`-Array; echte `.svg`-Dateien sind nicht dabei. Dieses Skript baut sie
daraus — mit denselben Vorgabewerten, die Lucide selbst setzt (24x24, Strich 2,
runde Enden).

Die Strichfarbe wird auf WEISS festgelegt statt auf `currentColor`: der
SVG-Zeichner im Player kennt keine vererbte Textfarbe. Eingefaerbt wird beim
Zeichnen (`tint`), weiss ist dafuer die neutrale Grundlage.

    ./extract-icons.py          # schreibt nach assets/icons/

Erneut laufen lassen, wenn ein Symbol dazukommt oder Lucide aktualisiert wird.
Lucide steht unter der ISC-Lizenz (permissiv, mit Namensnennung) — siehe
`icons/LICENSE.md`.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
QUELLE = HIER.parents[2] / "web/node_modules/@lucide/svelte/dist/icons"
ZIEL = HIER / "icons"

# Genau die Symbole der Kachel-Leiste (`web/src/lib/stream/components/TileDock.svelte`).
SYMBOLE = [
    "volume-2",       # Ton an
    "volume-x",       # stumm
    "message-square",  # Chat
    "maximize",       # Vollbild an
    "minimize",       # Vollbild aus
    "external-link",  # zurueck in die Kachel
    "x",              # Kachel schliessen
    "activity",       # Statistik ein/aus
    "mouse-pointer-click",  # Fernsteuerung anfragen
]

KOPF = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
    'viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round">'
)


def knoten_lesen(name: str) -> list[tuple[str, dict]]:
    """Das `iconNode`-Array aus der Svelte-Datei ziehen."""
    datei = QUELLE / f"{name}.svelte"
    if not datei.exists():
        raise FileNotFoundError(f"{datei} — heisst das Symbol wirklich so?")
    text = datei.read_text()
    treffer = re.search(r"const iconNode = (\[.*?\]);", text, re.S)
    if not treffer:
        raise ValueError(f"{name}: kein iconNode gefunden")
    # Der Inhalt ist bereits gueltiges JSON — Lucide schreibt Schluessel und
    # Werte durchgehend in doppelten Anfuehrungszeichen.
    roh = json.loads(treffer.group(1))
    return [(eintrag[0], eintrag[1]) for eintrag in roh]


def svg_bauen(knoten: list[tuple[str, dict]]) -> str:
    teile = [KOPF]
    for tag, attrs in knoten:
        attr_text = " ".join(f'{k}="{v}"' for k, v in attrs.items())
        teile.append(f"<{tag} {attr_text}/>")
    teile.append("</svg>")
    return "".join(teile) + "\n"


def main() -> int:
    if not QUELLE.is_dir():
        print(f"Lucide nicht gefunden: {QUELLE}\n"
              "Einmal `cd web && pnpm install` laufen lassen.", file=sys.stderr)
        return 2
    ZIEL.mkdir(parents=True, exist_ok=True)
    for name in SYMBOLE:
        (ZIEL / f"{name}.svg").write_text(svg_bauen(knoten_lesen(name)))
        print(f"  {name}.svg")
    print(f"{len(SYMBOLE)} Symbole nach {ZIEL.relative_to(HIER.parents[2])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
