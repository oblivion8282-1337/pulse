"""Minimaler pcap-Leser fuer RTCP-Feedback — ohne Fremdbibliothek.

Gebraucht fuer eine einzige Frage: Wer schickt wem eine Vollbild-Anforderung?
`tcpdump -x` von Hand zu parsen war zu fehleranfaellig (der erste Versuch am
2026-07-28 meldete sechs verschiedene Feedback-Formate mit exakt derselben
Anzahl — offensichtlicher Unsinn, aber erst beim Hinsehen erkennbar). Das
pcap-Format ist einfach genug, um es direkt zu lesen, und dann stimmt es auch.

RTCP-Kopf: `10FFFFFF PPPPPPPP LLLLLLLL LLLLLLLL` — zwei Bit Version (2),
ein Padding-Bit, fuenf Bit Format, ein Byte Payload-Typ, zwei Byte Laenge in
32-Bit-Woertern minus eins. Interessant sind PT 206 (PSFB) mit FMT 1 = PLI und
PT 206 mit FMT 4 = FIR, sowie PT 205 (RTPFB) mit FMT 1 = NACK.
"""

from __future__ import annotations

import struct
from pathlib import Path

# RTP/RTCP teilen sich den Port; unterschieden wird am Payload-Typ-Byte:
# RTCP liegt im Bereich 200-213, RTP-Nutzlasttypen darunter.
RTCP_MIN, RTCP_MAX = 200, 213
NAMEN = {(206, 1): "PLI", (206, 4): "FIR", (205, 1): "NACK"}


def _pakete(pfad: Path):
    """(quell_port, ziel_port, udp_nutzlast) je UDP-Paket."""
    daten = pfad.read_bytes()
    if len(daten) < 24:
        return
    magic = daten[:4]
    little = magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1")
    e = "<" if little else ">"
    linktype = struct.unpack(e + "I", daten[20:24])[0]
    pos = 24
    while pos + 16 <= len(daten):
        _, _, caplen, _ = struct.unpack(e + "IIII", daten[pos:pos + 16])
        pos += 16
        rahmen = daten[pos:pos + caplen]
        pos += caplen
        # Link-Schicht abziehen: 0 = NULL (4 Byte Familie), 1 = Ethernet (14),
        # 113 = Linux SLL (16). Auf `lo` liefert tcpdump ueblicherweise Ethernet.
        off = {0: 4, 1: 14, 113: 16, 276: 20}.get(linktype, 14)
        if len(rahmen) < off + 20:
            continue
        ip = rahmen[off:]
        if (ip[0] >> 4) != 4:
            continue
        ihl = (ip[0] & 0x0F) * 4
        if ip[9] != 17 or len(ip) < ihl + 8:   # 17 = UDP
            continue
        sport, dport = struct.unpack(">HH", ip[ihl:ihl + 4])
        yield sport, dport, ip[ihl + 8:]


def feedback_zaehlen(pfad: Path) -> dict[tuple[int, int, str], int]:
    """Zaehlt RTCP-Feedback je (Quellport, Zielport, Art)."""
    aus: dict[tuple[int, int, str], int] = {}
    for sport, dport, nutz in _pakete(pfad):
        i = 0
        while i + 4 <= len(nutz):
            kopf = nutz[i]
            if (kopf >> 6) != 2:            # keine RTCP-Version 2 → abbrechen
                break
            pt = nutz[i + 1]
            if not (RTCP_MIN <= pt <= RTCP_MAX):
                break                        # RTP oder verschluesselt
            laenge = (struct.unpack(">H", nutz[i + 2:i + 4])[0] + 1) * 4
            fmt = kopf & 0x1F
            name = NAMEN.get((pt, fmt))
            if name:
                schluessel = (sport, dport, name)
                aus[schluessel] = aus.get(schluessel, 0) + 1
            if laenge <= 0:
                break
            i += laenge                      # zusammengesetzte Pakete: weiterlesen
    return aus
