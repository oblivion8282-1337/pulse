#!/usr/bin/env python3
"""Wann geht das Paritaets-Tor auf — und wie lange danach?

Fuer die adaptive Paritaet (`PULSE_FLEXFEC_ADAPTIV=1`, Patch 0004). Sie
unterdrueckt den Paritaetsstrom, solange die gemeldete Verlustrate unter der
Schwelle liegt. `aufschlag.py` sagt, wieviel das ueber den ganzen Lauf spart —
diese Frage hier ist die andere Haelfte: **greift der Schutz, wenn er
gebraucht wird, und wie schnell?**

Konstruktionsbedingt hinkt die Regelung hinterher: der Server erfaehrt vom
Verlust erst ueber den naechsten Empfangsbericht des Zuschauers. Der Beginn
einer Stoerung laeuft also ungeschuetzt. Wie teuer das ist, war bis zum
2026-07-31 unbekannt und in der FEC-Analyse ausdruecklich als VERMUTET
markiert („NACK bedient dieses Fenster" — ungeprueft).

Gemessen wird je Sekunde:

* **Verlust** — Wiederholungen (Nachlieferungen vom Server) und NACKs des
  Players. Beides zeigt an, dass etwas gefehlt hat.
* **Paritaet** — Pakete des Paritaetsstroms. Er hat eine eigene Quellkennung,
  ist also sauber abtrennbar; null heisst „Tor zu".

Daraus die Zahl, um die es geht: der Abstand zwischen der ersten Sekunde mit
Verlust und der ersten Sekunde mit Paritaet danach.

    ./fec-verlauf.py intraref-adaptiv-stoerung.pcap
    ./fec-verlauf.py mein.pcap --alle          # jede Sekunde statt nur Fenster
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict, deque
from pathlib import Path

import aufschlag

FENSTER = aufschlag.FENSTER


def je_sekunde(pfad: Path, server_ip: str) -> tuple[list[dict], float]:
    """Zaehler je voller Sekunde seit Beginn des Mitschnitts."""
    sek: dict[int, dict] = defaultdict(
        lambda: {"medien": 0, "paritaet": 0, "wiederholt": 0, "nacks": 0})
    pakete_je_ssrc: dict[int, int] = defaultdict(int)
    fenster: dict[int, deque] = defaultdict(deque)
    gesehen: dict[int, set] = defaultdict(set)
    roh: list[tuple[int, int, bool]] = []      # (sekunde, ssrc, ist_wiederholung)
    nacks: list[int] = []
    start = None

    for zeit, vom_server, rtcp, ssrc, seq, _laenge in aufschlag.pakete_lesen(pfad, server_ip):
        if start is None:
            start = zeit
        s = int(zeit - start)
        if rtcp:
            # RTCP zum Server: NACKs stecken darin, aber der Typ liegt im
            # Paket, das `pakete_lesen` nicht mehr aufschluesselt. Gezaehlt
            # wird deshalb nur die Richtung — fuer „hier war Verlust" genuegt
            # das, weil die Wiederholungen dieselbe Aussage tragen.
            if not vom_server:
                nacks.append(s)
            continue
        if not vom_server:
            continue
        pakete_je_ssrc[ssrc] += 1
        f, m = fenster[ssrc], gesehen[ssrc]
        wdh = seq in m
        if not wdh:
            m.add(seq)
            f.append(seq)
            if len(f) > FENSTER:
                m.discard(f.popleft())
        roh.append((s, ssrc, wdh))

    if not pakete_je_ssrc:
        return [], 0.0
    # Der groesste Strom ist das Bild, alles andere ist Paritaet.
    medien_ssrc = max(pakete_je_ssrc, key=lambda s: pakete_je_ssrc[s])
    for s, ssrc, wdh in roh:
        eintrag = sek[s]
        if ssrc == medien_ssrc:
            eintrag["medien"] += 1
            if wdh:
                eintrag["wiederholt"] += 1
        else:
            eintrag["paritaet"] += 1
    for s in nacks:
        sek[s]["nacks"] += 1

    dauer = max(sek) + 1 if sek else 0
    return [{"sekunde": s, **sek[s]} for s in range(dauer)], float(dauer)


def bloecke(zeilen: list[dict], schluessel: str) -> list[tuple[int, int]]:
    """Zusammenhaengende Bereiche, in denen `schluessel` groesser null ist."""
    aus: list[tuple[int, int]] = []
    start = None
    for z in zeilen:
        if z[schluessel] > 0 and start is None:
            start = z["sekunde"]
        elif z[schluessel] == 0 and start is not None:
            aus.append((start, z["sekunde"] - 1))
            start = None
    if start is not None:
        aus.append((start, zeilen[-1]["sekunde"]))
    return aus


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap")
    ap.add_argument("--server", default=aufschlag.VORGABE_SERVER)
    ap.add_argument("--alle", action="store_true", help="jede Sekunde ausgeben")
    args = ap.parse_args()

    zeilen, dauer = je_sekunde(Path(args.pcap), args.server)
    if not zeilen:
        print("Mitschnitt enthaelt keine Pakete dieser Gegenstelle.", file=sys.stderr)
        return 1

    par = bloecke(zeilen, "paritaet")
    verlust = [z["sekunde"] for z in zeilen if z["wiederholt"] > 0]
    print(f"{Path(args.pcap).name}: {dauer:.0f} s\n")
    print(f"Sekunden mit Verlust (Wiederholungen): {len(verlust)}")
    print(f"Sekunden mit Paritaet:                 "
          f"{sum(1 for z in zeilen if z['paritaet'] > 0)}")
    print(f"Paritaetspakete gesamt:                "
          f"{sum(z['paritaet'] for z in zeilen)}")

    print("\nTorfenster (Paritaet floss):")
    if not par:
        print("  KEINE — das Tor ging im ganzen Lauf nicht auf.")
    for a, b in par:
        print(f"  Sekunde {a:>4} bis {b:>4}  ({b - a + 1} s)")

    # Die eigentliche Zahl: wie lange nach dem ersten Verlust kam die Paritaet?
    if verlust and par:
        print("\nReaktion:")
        for a, _b in par:
            davor = [s for s in verlust if s <= a]
            if davor:
                print(f"  Verlust ab Sekunde {davor[0]:>4} -> Paritaet ab {a:>4}"
                      f"   = {a - davor[0]} s Verzug")
    elif verlust and not par:
        print(f"\nReaktion: KEINE. Verlust in {len(verlust)} Sekunden "
              f"(erste bei {verlust[0]}), Paritaet nie.")

    if args.alle:
        print(f"\n{'Sek':>5} {'Medien':>7} {'wdh':>5} {'Paritaet':>9} {'RTCP hin':>9}")
        for z in zeilen:
            if not (args.alle or z["wiederholt"] or z["paritaet"]):
                continue
            print(f"{z['sekunde']:>5} {z['medien']:>7} {z['wiederholt']:>5} "
                  f"{z['paritaet']:>9} {z['nacks']:>9}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
