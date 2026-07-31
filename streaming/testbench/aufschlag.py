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


def sammeln(pfad: Path, server_ip: str) -> tuple[dict, dict, dict, int, int, float]:
    """(pakete, bytes, wiederholte_bytes) je SSRC + RTCP-Pakete/Bytes + Dauer."""
    ziel = bytes(int(x) for x in server_ip.split("."))
    roh = pfad.read_bytes()
    magic = struct.unpack("<I", roh[:4])[0]
    if magic not in (0xA1B2C3D4, 0xA1B23C4D):
        raise SystemExit(f"unbekanntes pcap-Magic {magic:08x}")
    teiler = 1e6 if magic == 0xA1B2C3D4 else 1e9

    pakete: dict[int, int] = defaultdict(int)
    groesse: dict[int, int] = defaultdict(int)
    wieder: dict[int, int] = defaultdict(int)
    fenster: dict[int, deque] = defaultdict(deque)
    gesehen: dict[int, set] = defaultdict(set)
    rtcp_n = rtcp_b = 0
    erste = letzte = None

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
        if not ist_rtp_oder_rtcp(nutz):
            continue
        if pkt[14 + 12:14 + 16] != ziel:            # nur Server -> Player
            continue
        if erste is None:
            erste = zeit
        letzte = zeit
        if ist_rtcp(nutz):
            rtcp_n += 1
            rtcp_b += orig
            continue
        seq = struct.unpack(">H", nutz[2:4])[0]
        ssrc = struct.unpack(">I", nutz[8:12])[0]
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
