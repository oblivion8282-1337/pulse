#!/usr/bin/env python3
"""Wieviele KOPIEN kommen je verlorenem Paket an? Reine Nachauswertung.

**Warum es dieses Werkzeug gibt.** `nack-wirkung.py` zaehlte bis zum
2026-07-31 nur Wiederholungs-EREIGNISSE. Damit ist nicht unterscheidbar, ob
viele Pakete je einmal nachgeliefert wurden oder wenige Pakete sehr oft — und
das ist der ganze Unterschied zwischen „die Leitung verliert viel" und „der
Empfaenger fordert im Kreis".

Der Fall ist an diesem Tag eingetreten und hat drei Messungen verdorben. Der
Mitschnitt `fec-fest-ab3.pcap` zeigt:

    273662 eindeutige Pakete, 910 Luecken            = 0,33 Prozent Verlust
    795 davon nachgeliefert                          = 87 Prozent repariert
    61805 zusaetzliche Zustellungen                  = 78 Kopien je Nachlieferung

**Die 795 sind die REPARIERTEN, nicht die verlorenen** — dieses Werkzeug sieht
nur Pakete, die mindestens einmal ankamen. Wieviele ueberhaupt fehlten, zaehlt
`nack-wirkung.py` (`luecken_erkannt`); die Differenz (hier 115) ist nie
eingetroffen. Wer die 795 als Verlustzahl liest, unterschaetzt ihn um ein
Achtel.

Die Leitung war trotzdem ausgezeichnet. Die 931 kbit/s „Nachlieferungen", die
wie der Preis einer schlechten Strecke aussahen, waren zu 98 Prozent Duplikate
aus einer Rueckkopplung zwischen NACK-Erzeuger und SRTP-Wiedergabeschutz
(`fenster.py` misst die andere Haelfte davon).

**Merksatz fuer kuenftige Auswertungen:** eine Zaehlung von Ereignissen ohne
die zugehoerige Zahl betroffener Einheiten ist keine Messung, sondern eine
Zahl. Erst das Verhaeltnis sagt etwas.

    ./kopien.py fec-fest-ab3.pcap
    ./kopien.py mein.pcap 77.42.71.166
"""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

from aufschlag import VORGABE_SERVER, erweitern, pakete_lesen


def zaehlen(pfad: Path, server_ip: str) -> tuple[dict, float, int]:
    """Je SSRC: Zustellungen je erweiterter Sequenznummer, Bytes, Paketzahl."""
    zustand: dict = {}
    zaehl: dict[int, Counter] = defaultdict(Counter)
    bytes_je: dict[int, int] = defaultdict(int)
    rtcp_b = 0
    erste = letzte = None

    for zeit, vom_server, rtcp, ssrc, seq, laenge in pakete_lesen(pfad, server_ip):
        if not vom_server:                     # nur Server -> Player
            continue
        if erste is None:
            erste = zeit
        letzte = zeit
        if rtcp:
            rtcp_b += laenge
            continue
        zaehl[ssrc][erweitern(zustand, ssrc, seq)] += 1
        bytes_je[ssrc] += laenge

    dauer = (letzte - erste) if (erste and letzte) else 0.0
    return {s: (zaehl[s], bytes_je[s]) for s in zaehl}, dauer, rtcp_b


def main() -> int:
    pfad = Path(sys.argv[1])
    server_ip = sys.argv[2] if len(sys.argv) > 2 else VORGABE_SERVER
    je_ssrc, dauer, rtcp_b = zaehlen(pfad, server_ip)
    if not je_ssrc or dauer <= 0:
        print("kein auswertbarer Verkehr im Mitschnitt", file=sys.stderr)
        return 1

    def kbit(b: float) -> float:
        return b * 8 / dauer / 1000

    print(f"{pfad.name}: {dauer:.1f} s, Gegenstelle {server_ip}")
    # Die Rollen werden nach Datenmenge zugeordnet — der Bildstrom ist immer
    # der groesste. Das ist eine ANNAHME, keine Auslesung aus dem SDP; bei
    # ungewoehnlichen Aufbauten (mehrere Bildspuren) erst pruefen.
    reihe = sorted(je_ssrc, key=lambda s: -je_ssrc[s][1])
    haupt_betroffen = haupt_extra = 0    # fuer den BEFUND unten, aus i==0
    for i, ssrc in enumerate(reihe):
        c, bytes_ges = je_ssrc[ssrc]
        zustellungen = sum(c.values())
        eindeutig = len(c)
        extra = zustellungen - eindeutig
        betroffen = sum(1 for v in c.values() if v > 1)
        mittel = bytes_ges / max(zustellungen, 1)
        rolle = "MEDIEN" if i == 0 else ("PARITAET" if i == 1 else f"#{i}")
        if i == 0:
            haupt_betroffen, haupt_extra = betroffen, extra

        print(f"\n  {rolle}  ssrc={ssrc}  {kbit(bytes_ges):.0f} kbit/s"
              f"  mittlere Laenge {mittel:.0f} B")
        print(f"    Zustellungen           {zustellungen}")
        print(f"    eindeutige Pakete      {eindeutig}")
        print(f"    davon mehrfach geliefert {betroffen}"
              f"   = {100 * betroffen / max(eindeutig, 1):.3f} % der Pakete")
        print(f"    ueberfluessige Kopien  {extra}"
              f"   = {kbit(extra * mittel):.0f} kbit/s")
        if betroffen:
            print(f"    Kopien je betroffenem Paket {extra / betroffen:.1f}")
            oben = sorted(Counter(c.values()).items())[:10]
            print("    Verteilung (Zustellungen: Anzahl Pakete): "
                  + ", ".join(f"{k}x:{v}" for k, v in oben))
    print(f"\n  RTCP vom Server: {kbit(rtcp_b):.0f} kbit/s")

    if haupt_betroffen and haupt_extra / haupt_betroffen > 3:
        print(f"\n  BEFUND: {haupt_extra / haupt_betroffen:.0f} Kopien je verlorenem Paket. Eine")
        print("          Nachforderung, die beantwortet wird, braucht EINE. Alles")
        print("          darueber ist Rueckkopplung — `fenster.py` zeigt, ob die")
        print("          Antworten im SRTP-Wiedergabefenster ankommen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
