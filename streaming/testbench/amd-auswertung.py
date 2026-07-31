#!/usr/bin/env python3
"""Messakten aus `amd-encoder-sweep.py` zu Tabellen verdichten.

Fasst je Variante ueber die Runden zusammen — **Median und Spanne, nicht
Mittelwert**: ein einzelner Ausrutscher (Fremdlast, Taktwechsel) zieht den
Mittelwert, den Median nicht. Die Spanne steht daneben, weil eine Differenz
zwischen zwei Varianten nur zaehlt, wenn sie groesser ist als die Streuung
innerhalb einer Variante.

Achsen je Variante:

* `latenz_ms` — Encode-Latenz (Einschieben bis Paket), Median der Sekundenwerte
* `vcn_us` — VCN-Encoder-Zeit je Bild, die GPU-Kosten
* `csc_us` — `scale_vaapi`-Zeit je Bild, der AMD-eigene Zusatzpass
* `vmaf` — Bildqualitaet gegen den verlustfreien Encoder-Eingang
* `vmaf_min` — schlechtestes Einzelbild. Waechter: bricht das MINIMUM bei hohem
  Mittel ein, ist die Bildpaarung verrutscht und die Zahl taugt nicht
  (s. `vmaf_common.measure_vmaf`).

    ./amd-auswertung.py profiles/amd-sichten-2026-07-30-av1.json
    ./amd-auswertung.py --vergleich vorgabe profiles/amd-bild-*.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

ACHSEN = [
    ("latenz_ms", "latenz_ms_median", "ms", 2),
    ("vcn_us", "vcn_us_je_bild", "us/Bild", 0),
    ("csc_us", "csc_us_je_bild", "us/Bild", 0),
    ("vmaf", None, "VMAF", 2),
    ("vmaf_min", None, "VMAF min", 2),
    ("mbit_s", None, "Mbit/s", 2),
]


def hole(lauf: dict, feld: str | None, name: str, sekunden: int) -> float | None:
    if name.startswith("vmaf"):
        return (lauf.get("bild") or {}).get(name)
    if name == "mbit_s":
        b = lauf.get("bytes") or 0
        return b * 8 / sekunden / 1e6 if sekunden else None
    return lauf.get(feld)


def verdichten(akte: Path) -> tuple[dict, dict[str, dict]]:
    d = json.loads(akte.read_text())
    sekunden = d.get("sekunden_je_lauf", 30)
    je_variante: dict[str, list[dict]] = {}
    for lauf in d["laeufe"]:
        if not lauf.get("live") or lauf.get("ungueltig"):
            continue
        je_variante.setdefault(lauf["variante"], []).append(lauf)

    ergebnis: dict[str, dict] = {}
    for variante, laeufe in je_variante.items():
        z: dict = {"laeufe": len(laeufe)}
        for name, feld, _e, _n in ACHSEN:
            werte = [v for v in (hole(l, feld, name, sekunden) for l in laeufe) if v is not None]
            if werte:
                z[name] = statistics.median(werte)
                z[f"{name}_spanne"] = max(werte) - min(werte)
        z["duplikate"] = sum(l.get("duplikate", 0) for l in laeufe)
        ergebnis[variante] = z
    return d, ergebnis


def tabelle(kopf: dict, werte: dict[str, dict], bezug: str | None) -> str:
    z = [f"## {kopf.get('was', '?')}",
         f"{kopf.get('maschine', '')}",
         f"{kopf.get('aufnahme', '')} · {kopf['fps']} fps · "
         f"{kopf['sekunden_je_lauf']} s/Lauf · {kopf['runden']} Runden verschraenkt",
         ""]
    spalten = [n for n, *_ in ACHSEN if any(n in v for v in werte.values())]
    z.append("| Variante | Laeufe | " + " | ".join(
        f"{n} ({e})" for n, _f, e, _d in ACHSEN if n in spalten) + " |")
    z.append("|" + "---|" * (2 + len(spalten)))

    b = werte.get(bezug) if bezug else None
    for variante, v in werte.items():
        zellen = []
        for name, _f, _e, stellen in ACHSEN:
            if name not in spalten:
                continue
            if name not in v:
                zellen.append("—")
                continue
            s = f"{v[name]:.{stellen}f} ±{v[f'{name}_spanne']:.{stellen}f}"
            if b and name in b and b[name]:
                delta = (v[name] - b[name]) / b[name] * 100
                if abs(delta) >= 1:
                    s += f"  ({delta:+.0f} %)"
            zellen.append(s)
        marke = " ← Bezug" if variante == bezug else ""
        z.append(f"| `{variante}`{marke} | {v['laeufe']} | " + " | ".join(zellen) + " |")

    # Duplikate erst ab einem ANTEIL melden, nicht ab dem ersten Bild. Wayland
    # liefert nur bei Bildaenderung, und die mpv-Schleife setzt beim Neustart
    # kurz aus — ein paar Prozent sind der Normalfall. Wer bei jeder Zahl warnt,
    # erzieht dazu, die Warnung zu ueberlesen; gemeint ist der Fall "Schirm
    # stand still", und der liegt bei Dutzenden Prozent.
    bilder = kopf["fps"] * kopf["sekunden_je_lauf"] * sum(v["laeufe"] for v in werte.values())
    dups = sum(v["duplikate"] for v in werte.values())
    anteil = dups / bilder * 100 if bilder else 0
    if anteil >= 20:
        z += ["", f"**Achtung: {anteil:.0f} % doppelte Bilder** ({dups} von {bilder}) — "
                  "stand der Schirm still? Ohne Bewegung sind Bildqualitaet und "
                  "GPU-Last bedeutungslos."]
    elif dups:
        z += ["", f"({anteil:.1f} % doppelte Bilder — im Rahmen)"]
    return "\n".join(z)


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("akten", nargs="+", type=Path)
    a.add_argument("--vergleich", default="vorgabe",
                   help="Variante als Bezugspunkt fuer die Prozentspalten")
    n = a.parse_args()
    for akte in n.akten:
        if not akte.exists():
            print(f"fehlt: {akte}", file=sys.stderr)
            continue
        kopf, werte = verdichten(akte)
        print(tabelle(kopf, werte, n.vergleich if n.vergleich in werte else None))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
