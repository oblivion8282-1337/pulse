#!/usr/bin/env python3
"""Leitet MediaMTX eine Vollbild-Anforderung an den Sender weiter?

**Warum die Frage zaehlt.** Paketverlust ist in der heutigen Kette nicht
reparierbar: es gibt keine Nachlieferung, und die Vollbild-Anforderung des
Players endet bei MediaMTX, weil RTMP keinen Rueckweg zum Encoder hat
(`verlust-2026-07-28-erholung.json`). Der verbliebene Ausweg waere ein Sender,
der ueber WebRTC veroeffentlicht (WHIP) — dann KOENNTE MediaMTX die Anforderung
durchreichen. Ob es das tut, ist der Unterschied zwischen "fuer alle Zuschauer
loesbar" und "nur auf dem Direktweg der Fernsteuerung loesbar".

**Das Verfahren.** Ein ffmpeg-Sender veroeffentlicht per WHIP, unser Player holt
per WHEP, und auf dem Medienweg liegt Paketverlust — damit der Player
Anforderungen schickt. Waehrenddessen laeuft ein Paketmitschnitt auf der
Schleife. Gesucht wird RTCP mit Payload-Typ 206 (PSFB) und Format 1 (PLI) auf
dem Weg ZUM Sender.

RTCP-Kopf: erstes Byte `10VVVVVV` (Version 2 + FMT), zweites Byte der Typ.
PLI ist also `0x81 0xCE`, FIR `0x84 0xCE` (PT 206, FMT 4).

    sudo ./pli-weiterleitung.py
"""

from __future__ import annotations

import re
import signal
import subprocess
import sys
import time

from harness import HERE, mint_tokens

DAUER = 25
VERLUST = "3%"   # kraeftig, damit der Player sicher anfordert


def netem(an: bool) -> None:
    subprocess.run(["sudo", "tc", "qdisc", "del", "dev", "lo", "root"],
                   stderr=subprocess.DEVNULL, check=False)
    if not an:
        return
    subprocess.run(["sudo", "tc", "qdisc", "add", "dev", "lo", "root", "handle", "1:",
                    "prio", "bands", "3"], check=True)
    subprocess.run(["sudo", "tc", "qdisc", "add", "dev", "lo", "parent", "1:3",
                    "handle", "30:", "netem", "loss", VERLUST], check=True)
    subprocess.run(["sudo", "tc", "filter", "add", "dev", "lo", "protocol", "ip",
                    "parent", "1:", "prio", "1", "flower", "ip_proto", "udp",
                    "src_port", "8189", "flowid", "1:3"], check=True)


def main() -> int:
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (netem(False), sys.exit(130)))

    path, pub, rd = mint_tokens()
    whip = f"http://localhost:8889/{path}/whip?token={pub}"
    whep = f"http://localhost:8889/{path}/whep?token={rd}"
    pcap = HERE / "pli.pcap"
    pcap.unlink(missing_ok=True)

    # Alles auf der Schleife mitschneiden — die Ports stehen erst zur Laufzeit
    # fest (ICE waehlt sie), deshalb kein engerer Filter.
    dump = subprocess.Popen(["sudo", "tcpdump", "-i", "lo", "-n", "-U",
                             "-s", "200", "-w", str(pcap), "udp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)

    sender = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30",
         "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
         "-bf", "0", "-g", "300", "-f", "whip", whip],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5.0)

    netem(True)
    player_log = open(HERE / "player-pli.log", "w")
    player = subprocess.Popen(
        [str(HERE.parent / "pulse-player/target/release/pulse-player")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=player_log,
        text=True, bufsize=1,
    )
    try:
        player.stdin.write(f'{{"op":"open","id":1,"url":"{whep}"}}\n')
        player.stdin.flush()
        time.sleep(DAUER)
    finally:
        netem(False)
        for p in (player, sender):
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        player_log.close()
        time.sleep(1.0)
        dump.terminate()
        try:
            dump.wait(timeout=5)
        except subprocess.TimeoutExpired:
            dump.kill()
        subprocess.run(["sudo", "chown", f"{HERE.stat().st_uid}", str(pcap)], check=False)

    # Auswerten: RTCP-Feedback-Pakete zaehlen, getrennt nach Richtung.
    r = subprocess.run(["sudo", "tcpdump", "-r", str(pcap), "-n", "-x", "udp"],
                       capture_output=True, text=True, check=False)
    zeilen = r.stdout.splitlines()
    treffer: dict[str, int] = {}
    kopf = re.compile(r"IP 127\.0\.0\.1\.(\d+) > 127\.0\.0\.1\.(\d+):")
    aktuell = None
    for z in zeilen:
        m = kopf.search(z)
        if m:
            aktuell = (m.group(1), m.group(2))
            continue
        if aktuell is None or "0x001c:" not in z and "0x0014:" not in z:
            # Nur die erste Nutzlast-Zeile interessiert (UDP-Nutzlast beginnt
            # bei Offset 0x1c im IP-Rahmen).
            pass
        if aktuell and "0x0010:" in z:
            # Die UDP-Nutzlast beginnt in dieser Zeile; RTCP-Kopf suchen.
            hexb = "".join(z.split()[1:])
            # Payload-Typ 206 = 0xce, direkt hinter dem ersten Byte 0x8?
            for i in range(0, len(hexb) - 3, 2):
                if hexb[i:i + 2] in ("80", "81", "82", "83", "84", "85") and \
                        hexb[i + 2:i + 4] == "ce":
                    fmt = int(hexb[i:i + 2], 16) & 0x1F
                    art = {1: "PLI", 4: "FIR"}.get(fmt, f"FMT{fmt}")
                    schluessel = f"{aktuell[0]} -> {aktuell[1]}  {art}"
                    treffer[schluessel] = treffer.get(schluessel, 0) + 1
                    break
            aktuell = None

    print(f"Mitschnitt: {pcap}")
    if not treffer:
        print("KEINE Vollbild-Anforderung im Mitschnitt gefunden.")
        print("Deutung: entweder schickt der Player keine, oder der Filter greift nicht.")
        return 1
    print("Gefundene Vollbild-Anforderungen (Quelle -> Ziel):")
    for k, v in sorted(treffer.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")
    print()
    print("MediaMTX lauscht fuer Medien auf 8189. Anforderungen, die VON 8189")
    print("ausgehen, sind weitergeleitete — sie gehen an den Sender.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
