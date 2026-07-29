#!/usr/bin/env python3
"""Teilt das Mittelstueck der Latenzkette auf: MediaMTX gegen Empfangsweg.

Alles laeuft auf einem Rechner ueber die Schleife (loopback). Was hineingeht
(RTMPS, TCP 1936) und was herauskommt (WebRTC, UDP 8189) faehrt also ueber
dieselbe Schnittstelle und laesst sich in EINEM Mitschnitt aufzeichnen:

    sudo tcpdump -i lo -n -s 96 -w cap.pcap 'tcp port 1936 or udp port 8189'

Der Trick ist, dass beide Seiten verschluesselt sind (TLS bzw. SRTP) und der
Inhalt damit nichts hergibt — die ZEITSTRUKTUR aber ueberlebt: ein Keyframe ist
auf beiden Seiten ein Schub aus vielen Paketen, um ein Vielfaches groesser als
die Bilder dazwischen. Diese Schuebe sind eindeutig zuzuordnen, und ihr
zeitlicher Versatz ist die Zeit, die MediaMTX braucht.

Zwei Verfahren, unabhaengig voneinander, als gegenseitige Kontrolle:

* **Schub gegen Schub** — jeder Keyframe-Schub der Eingangsseite bekommt den
  naechstliegenden der Ausgangsseite zugeordnet. Liefert eine Zahl je Keyframe,
  also auch die Streuung.
* **Kreuzkorrelation** — die beiden Byte-je-Millisekunde-Verlaeufe werden
  gegeneinander verschoben, bis sie am besten uebereinstimmen. Braucht keine
  Schub-Erkennung und faellt deshalb nicht auf falsch gesetzte Schwellen herein.

Weichen beide Zahlen stark voneinander ab, ist keine von beiden zu glauben.

    ./split-latency.py --pcap cap.pcap
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

import numpy as np

ETH_HDR = 14


def read_pcap(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(ein_ts, ein_bytes, aus_ts, aus_bytes) — Zeiten in Sekunden."""
    raw = path.read_bytes()
    # Der Mitschnitt stammt von tcpdump auf derselben Maschine, also immer
    # little-endian geschrieben — die grossendian-Variante (Magic 0xD4C3B2A1)
    # kommt hier nie vor und wird bewusst nicht unterstuetzt.
    endian = "<"
    magic = struct.unpack(endian + "I", raw[:4])[0]
    if magic == 0xA1B2C3D4:
        nano = False
    elif magic == 0xA1B23C4D:
        nano = True
    else:
        raise SystemExit(f"kein little-endian pcap (Magic {magic:08x})")
    tick = 1e-9 if nano else 1e-6

    pos = 24
    ein_t, ein_b, aus_t, aus_b = [], [], [], []
    n = len(raw)
    while pos + 16 <= n:
        sec, usec, incl, orig = struct.unpack(endian + "IIII", raw[pos:pos + 16])
        pos += 16
        pkt = raw[pos:pos + incl]
        pos += incl
        if len(pkt) < ETH_HDR + 20:
            continue
        ts = sec + usec * tick
        ethertype = struct.unpack(">H", pkt[12:14])[0]
        ip = pkt[ETH_HDR:]
        if ethertype == 0x0800:
            ihl = (ip[0] & 0x0F) * 4
            proto = ip[9]
        elif ethertype == 0x86DD:
            # ffmpeg loest "localhost" zu ::1 auf — der Eingang faehrt also ueber
            # IPv6, waehrend der ICE-Ausgang auf 127.0.0.1 liegt. Beide Familien
            # muessen gelesen werden, sonst fehlt eine ganze Seite.
            ihl, proto = 40, ip[6]
        else:
            continue
        if len(ip) < ihl + 4:
            continue
        sport, dport = struct.unpack(">HH", ip[ihl:ihl + 4])
        if proto == 6 and dport == 1936:
            ein_t.append(ts)
            ein_b.append(orig)
        elif proto == 17 and sport == 8189:
            aus_t.append(ts)
            aus_b.append(orig)

    return (np.array(ein_t), np.array(ein_b, dtype=float),
            np.array(aus_t), np.array(aus_b, dtype=float))


def bin_ms(ts: np.ndarray, by: np.ndarray, t0: float, t1: float) -> np.ndarray:
    """Bytes je Millisekunde."""
    n = int((t1 - t0) * 1000) + 1
    idx = ((ts - t0) * 1000).astype(int)
    keep = (idx >= 0) & (idx < n)
    out = np.zeros(n)
    np.add.at(out, idx[keep], by[keep])
    return out


def bursts(series: np.ndarray, fenster: int, faktor: float) -> np.ndarray:
    """Anfangs-Millisekunde jedes Schubs (geglaettet, mit Mindestabstand)."""
    kern = np.ones(fenster)
    glatt = np.convolve(series, kern, mode="same")
    schwelle = np.median(glatt[glatt > 0]) * faktor
    ueber = glatt > schwelle
    # Flanken: Uebergang von "darunter" nach "darueber"
    flanken = np.flatnonzero(ueber[1:] & ~ueber[:-1]) + 1
    if flanken.size == 0:
        return flanken
    # Mindestabstand 300 ms — ein Keyframe kommt bei uns jede Sekunde
    behalten = [flanken[0]]
    for f in flanken[1:]:
        if f - behalten[-1] >= 300:
            behalten.append(f)
    return np.array(behalten)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pcap", required=True, type=Path)
    ap.add_argument("--fenster", type=int, default=5, help="Glaettung in ms")
    ap.add_argument("--faktor", type=float, default=3.0, help="Schwelle als Vielfaches des Medians")
    ap.add_argument("--max-versatz", type=int, default=400, help="groesster gepruefter Versatz in ms")
    args = ap.parse_args()

    ein_t, ein_b, aus_t, aus_b = read_pcap(args.pcap)
    if ein_t.size == 0 or aus_t.size == 0:
        print(f"zu wenig Pakete: {ein_t.size} hinein, {aus_t.size} heraus", file=sys.stderr)
        return 1

    t0 = min(ein_t[0], aus_t[0])
    t1 = max(ein_t[-1], aus_t[-1])
    print(f"Mitschnitt {t1 - t0:.1f} s — {ein_t.size} Pakete hinein "
          f"({ein_b.sum() / 1e6:.1f} MB), {aus_t.size} heraus ({aus_b.sum() / 1e6:.1f} MB)")

    ein = bin_ms(ein_t, ein_b, t0, t1)
    aus = bin_ms(aus_t, aus_b, t0, t1)

    # --- Verfahren 1: Schub gegen Schub -----------------------------------
    e_schuebe = bursts(ein, args.fenster, args.faktor)
    a_schuebe = bursts(aus, args.fenster, args.faktor)
    print(f"\nSchuebe: {e_schuebe.size} hinein, {a_schuebe.size} heraus")

    paare = []
    for e in e_schuebe:
        spaeter = a_schuebe[(a_schuebe >= e) & (a_schuebe <= e + args.max_versatz)]
        if spaeter.size:
            paare.append((e, spaeter[0], spaeter[0] - e))
    if paare:
        d = np.array([p[2] for p in paare], dtype=float)
        print(f"  zugeordnet {len(paare)} — Versatz Mittel {d.mean():.1f} ms, "
              f"Median {np.median(d):.1f}, min {d.min():.0f}, max {d.max():.0f}")
        print("  je Schub: " + " ".join(f"{x:.0f}" for x in d))
    else:
        print("  keine Zuordnung — Schwelle anpassen (--faktor)")

    # --- Verfahren 2: Kreuzkorrelation ------------------------------------
    a = ein - ein.mean()
    b = aus - aus.mean()
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    werte = []
    for lag in range(args.max_versatz + 1):
        werte.append(float(np.dot(a[:n - lag], b[lag:])))
    werte = np.array(werte)
    best = int(np.argmax(werte))
    print(f"\nKreuzkorrelation: bestes Zusammenpassen bei {best} ms Versatz")
    ordnung = np.argsort(werte)[::-1][:5]
    print("  Spitzenreiter: " + ", ".join(f"{l} ms ({werte[l] / werte[best]:.2f})" for l in ordnung))

    return 0


if __name__ == "__main__":
    sys.exit(main())
