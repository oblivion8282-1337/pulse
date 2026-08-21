#!/usr/bin/env python3
"""Wie gleichmaessig kam das Bild beim Zuschauer heraus?

Die Zahl, auf die es beim Ruckeln ankommt, ist **nicht** die Bildrate, sondern
der Abstand zwischen zwei ausgegebenen Bildern. Der Player schreibt ihn je
Sekunde als Spanne mit (``Abstand 2.3-267.3 ms``); dieses Werkzeug macht daraus
die Kennzahlen, mit denen zwei Laeufe vergleichbar werden — dieselben, in denen
am 2026-07-31 der Intra-Refresh-Gewinn auf NVIDIA ausgedrueckt wurde. Jene
Messakte (``profiles/hq-2026-07-31-intra-refresh-echter-sender.json``) ist am
2026-08-21 mit der Betriebsart geloescht worden; die Kennzahlen sind davon
unberuehrt und vergleichen heute z. B. zwei Vollbild-Abstaende.

    ./ausgabe-abstand.py player-amd-60s.log player-amd-2s.log

**Gezaehlt wird je SEKUNDE, nicht je Bild.** Der Player meldet je Sekunde nur
Kleinst- und Groesstwert, nicht jeden einzelnen Abstand — ein Median ueber alle
Bilder ist daraus nicht zu gewinnen und wird hier auch nicht behauptet. Was
zaehlbar ist und die Frage beantwortet: in wie vielen Sekunden gab es einen
Haenger. Ein einziger Aussetzer von 250 ms ist sichtbar, auch wenn die anderen
59 Bilder derselben Sekunde tadellos kamen.

**Warum der Abstand ZWISCHEN den Haengern mitgezaehlt wird:** liegt er
regelmaessig bei zwei Sekunden, ist es der Keyframe-Takt und kein Zufall. Genau
daran wurde der periodische Keyframe als Quelle des Stotterns ueberfuehrt.

**Lebendkontrolle:** ein Lauf ohne auswertbare Zeilen bekommt KEINE Zahlen,
sondern einen Vermerk. Ein Werkzeug, das bei Totalausfall eine Zahl liefert,
ist schlimmer als keins (Lehre vom 2026-07-28).
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

# `Abstand 2.3-267.3 ms (0 zu spaet)` — Kleinst- und Groesstwert der Sekunde.
ABSTAND = re.compile(r"Abstand ([\d.]+)-([\d.]+) ms")
# Die Zahl in derselben Klammer: Ausgabe-Abstaende ueber dem DOPPELTEN Soll.
#
# **Sie wurde hier bis zum 2026-08-05 nicht gelesen**, obwohl die README des
# Pruefstands sie „die Zahl, auf die es ankommt" nennt und der Player sie seit
# jeher mitschreibt. Ausgewertet wurde nur der groesste Abstand je Sekunde —
# das ist EIN Ereignis je Sekunde, egal ob in dieser Sekunde ein Bild zu spaet
# kam oder dreissig. Fuer die Frage „wie gleichmaessig laeuft die Ausgabe" ist
# die Anzahl die Groesse, der Ausschlag nur ihr schlimmster Einzelfall.
ZU_SPAET = re.compile(r"Abstand [\d.]+-[\d.]+ ms \((\d+) zu spaet\)")
# `Ausgabe-Takt 60 ms Vorhalt, verspaetet 12, neu verankert 0` — nur vorhanden,
# wenn der Takt laeuft (`PULSE_PLAYER_AUSGABETAKT_MS`). `verspaetet` ist dessen
# Kontrollzahl: steigt sie, ist der Vorhalt kleiner als die Schwankung der
# Strecke und es taktet nichts mehr.
TAKT = re.compile(r"Ausgabe-Takt (\d+) ms Vorhalt, verspaetet (\d+), neu verankert (\d+), nachgezogen (\d+)")
BITRATE = re.compile(r"([\d.]+) kbit/s")
DEKODIERT = re.compile(r"dekodiert (\d+)/s")
GEZEICHNET = re.compile(r"gezeichnet (\d+)/s")
NETZ_SCHIRM = re.compile(r"Netz-bis-Schirm ([\d.]+)/([\d.]+) ms")
VERLUST = re.compile(r"Paketverlust (\d+)")
# `Ende-zu-Ende 98.1/132.0 ms (0 ohne Muster)` — nur mit --muster vorhanden.
E2E = re.compile(r"Ende-zu-Ende ([\d.]+)/([\d.]+) ms \((\d+) ohne Muster\)")
VOLLBILD = re.compile(r"Vollbild #(\d+) empfangen")


def anteil(werte: list[float], schwelle: float) -> float:
    return round(100.0 * sum(1 for w in werte if w > schwelle) / len(werte), 1)


def quantil(werte: list[float], q: float) -> float:
    geordnet = sorted(werte)
    return round(geordnet[min(len(geordnet) - 1, int(q * len(geordnet)))], 1)


def auswerten(pfad: Path) -> dict:
    groesster: list[float] = []      # groesster Ausgabe-Abstand je Sekunde
    kbit: list[float] = []
    dekodiert: list[int] = []
    gezeichnet: list[int] = []
    schirm: list[float] = []
    verlust = 0
    e2e: list[float] = []
    ohne_muster = 0
    vollbilder = 0
    # In welcher Sekunde des Laufs lag ein Haenger — daraus die Abstaende.
    haenger_bei: list[int] = []
    zu_spaet: list[int] = []
    takt_vorhalt: int | None = None
    takt_verspaetet = 0
    takt_verankert = 0
    takt_nachgezogen = 0

    for zeile in pfad.read_text(errors="replace").splitlines():
        if VOLLBILD.search(zeile):
            vollbilder += 1
        if m := E2E.search(zeile):
            e2e.append(float(m.group(1)))
            ohne_muster += int(m.group(3))
        if t := TAKT.search(zeile):
            # KUMULATIV wie der Paketverlust: der Player zaehlt ueber die
            # Sitzung, nicht je Fenster.
            takt_vorhalt = int(t.group(1))
            takt_verspaetet = int(t.group(2))
            takt_verankert = int(t.group(3))
            takt_nachgezogen = int(t.group(4))
        m = ABSTAND.search(zeile)
        if not m:
            continue
        if z := ZU_SPAET.search(zeile):
            zu_spaet.append(int(z.group(1)))
        sekunde = len(groesster)
        gross = float(m.group(2))
        groesster.append(gross)
        if gross > 100.0:
            haenger_bei.append(sekunde)
        if b := BITRATE.search(zeile):
            kbit.append(float(b.group(1)))
        if d := DEKODIERT.search(zeile):
            dekodiert.append(int(d.group(1)))
        if g := GEZEICHNET.search(zeile):
            gezeichnet.append(int(g.group(1)))
        if s := NETZ_SCHIRM.search(zeile):
            schirm.append(float(s.group(1)))
        if v := VERLUST.search(zeile):
            # KUMULATIV, nicht je Sekunde (im Log nachgesehen: 0,0,0 … 359,
            # 359,379). Summieren haette daraus eine Zahl gemacht, die nach
            # sehr viel Verlust aussieht und nichts bedeutet.
            verlust = int(v.group(1))

    if not groesster:
        return {"datei": pfad.name,
                "KEIN_URTEIL": "keine auswertbare Statistikzeile — Lauf hat nie "
                               "ein Bild ausgegeben, oder das Log ist unvollstaendig"}

    return {
        "datei": pfad.name,
        "sekunden_betrieb": len(groesster),
        "groesster_abstand_median_ms": round(statistics.median(groesster), 1),
        "groesster_abstand_p90_ms": quantil(groesster, 0.90),
        "groesster_abstand_p99_ms": quantil(groesster, 0.99),
        "groesster_abstand_max_ms": round(max(groesster), 1),
        "sekunden_ueber_33ms_prozent": anteil(groesster, 33.0),
        "sekunden_ueber_100ms_prozent": anteil(groesster, 100.0),
        "haenger_ueber_100ms_anzahl": len(haenger_bei),
        # Die eigentliche Gleichmaessigkeits-Zahl (s. Kommentar an ZU_SPAET).
        # `summe` ist der Vergleichswert zwischen zwei Laeufen GLEICHER Laenge,
        # `je_sekunde` der zwischen verschieden langen.
        "zu_spaet_summe": sum(zu_spaet) if zu_spaet else None,
        "zu_spaet_je_sekunde_median": (statistics.median(zu_spaet)
                                       if zu_spaet else None),
        "zu_spaet_je_sekunde_max": max(zu_spaet) if zu_spaet else None,
        "sekunden_ohne_zu_spaet_prozent": (
            round(100.0 * sum(1 for z in zu_spaet if z == 0) / len(zu_spaet), 1)
            if zu_spaet else None),
        # Nur gesetzt, wenn der Ausgabe-Takt lief.
        "ausgabetakt_vorhalt_ms": takt_vorhalt,
        "ausgabetakt_verspaetet": takt_verspaetet if takt_vorhalt else None,
        "ausgabetakt_neu_verankert": takt_verankert if takt_vorhalt else None,
        "ausgabetakt_nachgezogen": takt_nachgezogen if takt_vorhalt else None,
        "abstaende_zwischen_den_haengern_s": [b - a for a, b in
                                              zip(haenger_bei, haenger_bei[1:])][:40],
        "bitrate_median_kbit": round(statistics.median(kbit), 0) if kbit else None,
        "dekodiert_median_je_s": statistics.median(dekodiert) if dekodiert else None,
        "gezeichnet_median_je_s": statistics.median(gezeichnet) if gezeichnet else None,
        "netz_bis_schirm_median_ms": round(statistics.median(schirm), 1) if schirm else None,
        # Ende-zu-Ende nur, wenn die Sonde das Zeitmuster ueberhaupt gelesen
        # hat. Sonst steht hier ein Wert, der aus den paar Bildern stammt, bei
        # denen es zufaellig klappte — und der sieht aus wie eine Messung.
        # (Am 2026-08-01 gebraucht: mit Software-Decoder und 10 bit war das
        # Muster in JEDEM Bild unlesbar, `luma_at` im Player las den falschen
        # Halb-Byte-Teil.)
        "ende_zu_ende_median_ms": (round(statistics.median(e2e), 1)
                                   if e2e and ohne_muster < len(e2e) else None),
        "bilder_ohne_muster": ohne_muster,
        "muster_lesbar": ohne_muster < len(e2e) if e2e else None,
        "paketverlust_ende": verlust,
        "vollbilder_empfangen": vollbilder,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+", type=Path)
    ap.add_argument("--json", action="store_true", help="nur JSON ausgeben")
    args = ap.parse_args()

    ergebnisse = [auswerten(p) for p in args.logs]
    if args.json:
        print(json.dumps(ergebnisse, ensure_ascii=False, indent=1))
        return 0

    for e in ergebnisse:
        print(f"--- {e['datei']}")
        for k, v in e.items():
            if k != "datei":
                print(f"  {k}: {v}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
