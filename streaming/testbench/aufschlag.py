#!/usr/bin/env python3
"""Wieviel traegt der Strom ueber der Nutzlast — je Quelle, in Bytes.

Beantwortet die Frage „wieviel kommt auf den eigentlichen Stream oben drauf",
und zwar aufgeschluesselt: Paritaet, Nachlieferungen, Kopfzeilen. Aus EINEM
Mitschnitt, nicht aus der Differenz zweier Laeufe — die sind nie gleich stark
gestoert, und der Vergleich waere entsprechend schief.

**Warum das ueberhaupt geht.** Der Paritaetsstrom traegt eine eigene
Quellkennung (SSRC), er laesst sich also sauber vom Bild trennen, obwohl beides
verschluesselt ist: SRTP verschluesselt die Nutzlast, die Kopfzeilen bleiben
lesbar.

**Die Laengen kommen aus dem pcap-Kopf, nicht aus dem Paket.** Der Pruefstand
schneidet mit ``-s 120`` mit, die Pakete sind also abgeschnitten. Jeder
pcap-Datensatz traegt daneben die ECHTE Laenge (``orig_len``) — wer die
mitgeschnittene nimmt, bekommt fuer jedes Paket 120 heraus und misst nichts.

**Wiederholungen zaehlen getrennt.** Eine Nachlieferung ist Aufschlag auf der
Leitung, gehoert aber nicht zur Paritaet: sie faellt nur an, wenn wirklich
etwas verloren ging, waehrend die Paritaet (ohne Regelung) immer mitlaeuft.
Wer beides zusammenwirft, haelt eine gestoerte Messung fuer teure Paritaet.

    ./aufschlag.py intraref-verlust-fec.pcap
    ./aufschlag.py mein.pcap 77.42.71.166
"""

from __future__ import annotations

import struct
import sys
from collections import defaultdict, deque
from pathlib import Path

# So viele zurueckliegende Sequenznummern gelten als „noch aktuell" — wie in
# `nack-wirkung.py`, damit ein 16-Bit-Ueberlauf nicht als Wiederholung zaehlt.
FENSTER = 4000
VORGABE_SERVER = "77.42.71.166"


def ist_rtp_oder_rtcp(nutz: bytes) -> bool:
    """Trennt RTP/RTCP von STUN und DTLS auf demselben Port (RFC 7983)."""
    return len(nutz) >= 12 and (nutz[0] >> 6) == 2


def ist_rtcp(nutz: bytes) -> bool:
    return 64 <= (nutz[1] & 0x7F) <= 95


def pakete_lesen(pfad: Path, server_ip: str):
    """Jedes RTP/RTCP-Paket des Mitschnitts einzeln, als Wortfolge.

    Liefert ``(zeit, vom_server, ist_rtcp, ssrc, seq, laenge)`` — `ssrc` und
    `seq` sind bei RTCP `None`. `laenge` ist die ECHTE Paketlaenge aus dem
    pcap-Kopf, nicht die mitgeschnittene (der Pruefstand schneidet mit
    ``-s 120`` ab, sonst kaeme ueberall 120 heraus).

    **Eigene Funktion, weil zwei Werkzeuge dieselbe Schleife brauchen**
    ([`sammeln`] fuer die Summen, `fec-verlauf.py` fuer den Zeitverlauf). Zwei
    Fassungen davon wuerden auseinanderlaufen, sobald jemand einen Filter
    aendert — und ein Filterfehler faellt hier nicht auf: die Zahlen sehen
    weiter plausibel aus. Genau so sind am 2026-07-29 aus 2663 STUN-Paketen
    „505 Nachlieferungen" geworden.
    """
    ziel = bytes(int(x) for x in server_ip.split("."))
    roh = pfad.read_bytes()
    magic = struct.unpack("<I", roh[:4])[0]
    if magic not in (0xA1B2C3D4, 0xA1B23C4D):
        raise SystemExit(f"unbekanntes pcap-Magic {magic:08x}")
    teiler = 1e6 if magic == 0xA1B2C3D4 else 1e9

    pos, n = 24, len(roh)
    while pos + 16 <= n:
        sec, sub, incl, orig = struct.unpack("<IIII", roh[pos:pos + 16])
        zeit = sec + sub / teiler
        pos += 16
        pkt = roh[pos:pos + incl]
        pos += incl
        if len(pkt) < 42 or struct.unpack(">H", pkt[12:14])[0] != 0x0800:
            continue
        ihl = (pkt[14] & 0x0F) * 4
        if pkt[14 + 9] != 17:                       # nur UDP
            continue
        nutz = pkt[14 + ihl + 8:]
        if not ist_rtp_oder_rtcp(nutz):             # STUN/DTLS aussortieren
            continue
        vom_server = pkt[14 + 12:14 + 16] == ziel
        zum_server = pkt[14 + 16:14 + 20] == ziel
        if not (vom_server or zum_server):
            continue
        if ist_rtcp(nutz):
            yield zeit, vom_server, True, None, None, orig
            continue
        seq = struct.unpack(">H", nutz[2:4])[0]
        ssrc = struct.unpack(">I", nutz[8:12])[0]
        yield zeit, vom_server, False, ssrc, seq, orig


def erweitern(zustand: dict, ssrc: int, seq: int) -> int:
    """16-Bit-Sequenznummer in eine monoton wachsende umrechnen (RFC 3550).

    **Ohne diese Umrechnung zaehlt jede Auswertung Unsinn, und zwar
    unauffaellig.** Die RTP-Sequenznummer laeuft nach 65536 Paketen ueber; bei
    440 Paketen je Sekunde ist das alle zweieinhalb Minuten. Wer roh zaehlt,
    haelt jede Nummer des zweiten Umlaufs fuer eine Wiederholung der ersten.
    Am 2026-07-31 ist genau das passiert: eine Handauswertung meldete „65536
    eindeutige Nummern, alle mehrfach zugestellt" — das ist exakt der volle
    Zahlenraum und war reiner Ueberlauf, kein einziges Duplikat.

    Der Zustand wird je SSRC gefuehrt (`zustand` ist ein leeres dict beim
    ersten Aufruf). Entscheidend ist die Behandlung von RUECKWAERTS-Spruengen:
    eine Nachlieferung oder Umsortierung darf den Bezugspunkt NICHT
    fortschreiben, sonst wird sie selbst als Ueberlauf gelesen und die
    Zaehlung explodiert.
    """
    z = zustand.setdefault(ssrc, {"cycles": 0, "max": None})
    if z["max"] is None:
        z["max"] = seq
        return seq
    vor = z["max"]
    if ((seq - vor) & 0xFFFF) < 0x8000:          # vorwaerts
        if seq < vor:                            # dabei ueber die Grenze
            z["cycles"] += 1
        z["max"] = seq
        return (z["cycles"] << 16) | seq
    # rueckwaerts: Nachlieferung oder Umsortierung, Bezugspunkt bleibt stehen
    c = z["cycles"]
    if seq > vor:                                # gehoert in den vorigen Umlauf
        c = max(c - 1, 0)
    return (c << 16) | seq


def sammeln(pfad: Path, server_ip: str) -> tuple[dict, dict, dict, int, int, float]:
    """(pakete, bytes, wiederholte_bytes) je SSRC + RTCP-Pakete/Bytes + Dauer."""
    pakete: dict[int, int] = defaultdict(int)
    groesse: dict[int, int] = defaultdict(int)
    wieder: dict[int, int] = defaultdict(int)
    fenster: dict[int, deque] = defaultdict(deque)
    gesehen: dict[int, set] = defaultdict(set)
    rtcp_n = rtcp_b = 0
    erste = letzte = None

    for zeit, vom_server, rtcp, ssrc, seq, orig in pakete_lesen(pfad, server_ip):
        if not vom_server:
            continue
        if erste is None:
            erste = zeit
        letzte = zeit
        if rtcp:
            rtcp_n += 1
            rtcp_b += orig
            continue
        pakete[ssrc] += 1
        groesse[ssrc] += orig
        f, m = fenster[ssrc], gesehen[ssrc]
        if seq in m:
            wieder[ssrc] += orig
        else:
            m.add(seq)
            f.append(seq)
            if len(f) > FENSTER:
                m.discard(f.popleft())
    return pakete, groesse, wieder, rtcp_n, rtcp_b, (letzte - erste) if erste and letzte else 0.0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[-2].strip(), file=sys.stderr)
        return 2
    pfad = Path(sys.argv[1])
    server = sys.argv[2] if len(sys.argv) > 2 else VORGABE_SERVER
    pakete, groesse, wieder, rtcp_n, rtcp_b, dauer = sammeln(pfad, server)
    if not dauer:
        print("Mitschnitt enthaelt keine Pakete dieser Gegenstelle.", file=sys.stderr)
        return 1

    kbit = lambda b: b * 8 / dauer / 1000  # noqa: E731 — nur hier gebraucht
    gesamt = sum(groesse.values()) + rtcp_b
    print(f"{pfad.name}: {dauer:.1f} s, Richtung Server -> Player\n")
    print(f"{'SSRC':>12} {'Pakete':>9} {'MByte':>8} {'kbit/s':>9}  Anteil")
    for ssrc in sorted(pakete, key=lambda s: -groesse[s]):
        print(f"{ssrc:>12} {pakete[ssrc]:>9} {groesse[ssrc]/1e6:>8.1f} "
              f"{kbit(groesse[ssrc]):>9.0f}  {100*groesse[ssrc]/gesamt:>5.1f} %")
    if rtcp_n:
        print(f"{'RTCP':>12} {rtcp_n:>9} {rtcp_b/1e6:>8.1f} {kbit(rtcp_b):>9.0f}  "
              f"{100*rtcp_b/gesamt:>5.1f} %")

    # Der groesste Strom ist das Bild; ein zweiter, kleinerer ist die Paritaet.
    # Bei abgeschalteter Paritaet gibt es ihn schlicht nicht — dann steht hier
    # eine Null, und genau das ist die Aussage.
    reihe = sorted(pakete, key=lambda s: -groesse[s])
    medien = reihe[0]
    par_bytes = groesse[reihe[1]] if len(reihe) > 1 else 0
    nutzlast = groesse[medien] - wieder[medien]
    anteil = lambda b: f"{100*b/nutzlast:>5.1f} %" if nutzlast else "   n/a"  # noqa: E731
    print(f"\n{'':-<62}")
    print(f"Nutzlast (Bild ohne Wiederholungen)   {kbit(nutzlast):>8.0f} kbit/s")
    print(f"Paritaet                              {kbit(par_bytes):>8.0f} kbit/s  = {anteil(par_bytes)}")
    print(f"Wiederholungen (NACK)                 {kbit(wieder[medien]):>8.0f} kbit/s  = {anteil(wieder[medien])}")
    print(f"RTCP                                  {kbit(rtcp_b):>8.0f} kbit/s  = {anteil(rtcp_b)}")
    print(f"{'':-<62}")
    auf = par_bytes + wieder[medien] + rtcp_b
    print(f"GESAMT auf der Leitung                {kbit(gesamt):>8.0f} kbit/s  = {anteil(auf)} darueber")
    return 0


if __name__ == "__main__":
    sys.exit(main())
