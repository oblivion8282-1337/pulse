#!/usr/bin/env python3
"""Der Bildschirm, ueber den Hetzner-Server, zurueck ins Player-Fenster.

Kein Zeitmuster, keine Stoerung, keine Messung. Nur der Stream, so wie ein
Nutzer ihn bekaeme — zum Ansehen und Selbsturteilen.

    ./ansehen.py                    # neuer Sendeweg, AV1 10 bit
    ./ansehen.py --proto rtmps      # der heutige Weg

Laeuft bis Strg-C. Beim ersten Start kommt der Wayland-Dialog — einen
BILDSCHIRM waehlen, kein Fenster.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time

from gemeinsam import laden, sender_starten
from harness import HERE, Player, mint_tokens

_fern = laden("fern-harness")
Sidecar = laden("real-harness").Sidecar


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proto", default="whip", choices=["rtmps", "srt", "whip"])
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--fps", type=int, default=60)
    # 3000, nicht 8000: hier schaut derselbe Anschluss zu, der auch sendet —
    # der Strom laeuft die 12-Mbit-Leitung hoch UND wieder runter. Mit 8000
    # misst man die eigene Leitung am Anschlag statt den Sendeweg (Falle vom
    # 2026-07-27). Fuer ein Qualitaetsurteil hoeher setzen, dann aber wissen,
    # dass die Leitung mitredet.
    ap.add_argument("--kbps", type=int, default=3000)
    ap.add_argument("--audio", default="Desktop")
    # Der lokale Server ist der einzige, auf dem eine noch nicht ausgerollte
    # Server-Aenderung ueberhaupt sichtbar wird — der Hetzner-Testserver laeuft
    # das veroeffentlichte Image. Dafuer faellt die echte Leitung weg: der
    # lokale Weg zeigt, ob eine Aenderung wirkt, nicht wie sie sich unterwegs
    # schlaegt.
    ap.add_argument("--lokal", action="store_true",
                    help="ueber den lokalen MediaMTX statt ueber den Testserver")
    # Auffangnetz: ein zweiter, winziger Strom, in dem JEDES Bild ein Vollbild
    # ist. Der Player zeigt ihn, solange der Hauptstrom nichts liefert.
    #
    # Hier erzeugt ihn ffmpeg mit einem Testbild statt der Bildschirmaufnahme —
    # absichtlich: Erstens braeuchte eine zweite Aufnahme einen zweiten
    # Portal-Zugriff (im Produkt speist EIN Zugriff beide Encoder, das ist der
    # Umbau im Sidecar). Zweitens ist ein deutlich anderes Bild fuer den Test
    # das bessere Werkzeug — man sieht auf den Millimeter genau, wann
    # umgeschaltet wird.
    ap.add_argument("--netz", action="store_true",
                    help="Auffangnetz mitlaufen lassen (ffmpeg-Testbild, alles Vollbilder)")
    args = ap.parse_args()

    def _adressen(proto: str) -> tuple[str, str, str]:
        """(whep, push, publish-token) fuer einen frischen Pfad."""
        if args.lokal:
            p, pub_, rd_ = mint_tokens()
            whep_ = f"http://localhost:8889/{p}/whep?token={rd_}"
            push_ = (f"http://localhost:8889/{p}/whip?token={pub_}" if proto == "whip"
                     else f"rtmps://localhost:1936/{p}?token={pub_}")
        else:
            p, pub_, rd_ = _fern.mint_remote()
            whep_ = f"https://{_fern.HOST}/whep/{p}/whep?token={rd_}"
            push_ = _fern.push_url(p, pub_, proto, 120)
        return whep_, push_, pub_

    whep, push, pub = _adressen(args.proto)
    netz_whep = netz_push = None
    if args.netz:
        # RTMPS auch dann, wenn der Hauptstrom per WHIP geht: ffmpeg soll hier
        # nichts weiter beweisen als "es kommt ein Bild an".
        netz_whep, netz_push, _ = _adressen("rtmps")

    sender = Sidecar(open(HERE / "ansehen-sender.log", "w"))
    player = None
    netz = None
    try:
        if not sender_starten(sender, args, pub, push):
            return 1
        if netz_push:
            netz = subprocess.Popen(
                ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-re",
                 "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10",
                 "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
                 # -g 1: JEDES Bild ein Vollbild. Das ist der ganze Witz des
                 # Netzes — es gibt keinen Einstiegspunkt, auf den man warten
                 # muesste, jedes ankommende Bild ist einer.
                 "-g", "1", "-b:v", "600k", "-pix_fmt", "yuv420p",
                 "-f", "flv", "-tls_verify", "0", netz_push],
                stdout=open(HERE / "ansehen-netz.log", "w"),
                stderr=subprocess.STDOUT,
            )
            print("Auffangnetz laeuft (640x360, 10 fps, nur Vollbilder)")
        print(f"Sender laeuft ({args.proto}, {args.codec} {args.bits} bit, "
              f"{args.fps} fps, {args.kbps} kbps) — warte auf den Server ...")
        time.sleep(5.0)

        player = Player(open(HERE / "ansehen-player.log", "w"))
        # Stumm: der Ton des Fensters liefe sonst ueber die Desktop-Aufnahme
        # zurueck in den Strom — eine Rueckkopplung, die sich aufschaukelt.
        # Wer den Ton beurteilen will, nimmt `--audio Aus` und hoert direkt.
        res = player.call("open", url=whep, title="Pulse", options={"volume": 0.0},
                          **({"fallback_url": netz_whep} if netz_whep else {}))
        if not res.get("ok"):
            print(f"Player-Start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        # Ein Vollbild auf Zuruf, sobald das Fenster offen ist. Der Player
        # wartet auf ein Vollbild und bliebe sonst bis zum naechsten Takt
        # schwarz — bei der heutigen Vorgabe von 60 s also fast eine Minute.
        # Bis zum 2026-08-21 stand hier als Begruendung der Intra-Refresh-
        # Betrieb (nach dem Start ueberhaupt KEIN Vollbild mehr); die
        # Betriebsart ist entfernt, der Handgriff bleibt noetig. Liegt der
        # Abstand kurz, ist die Anforderung folgenlos — deshalb immer.
        time.sleep(1.0)
        sender.call("keyframe", timeout=10)

        # Die Ereignisse des Players mitschreiben. Ohne das bleibt der Grund,
        # aus dem eine Sitzung endet, UNSICHTBAR: er reist als Ereignis ueber
        # stdout, und danach ruft hier niemand mehr `call`, das sie einsammeln
        # wuerde. Am 2026-07-28 zweimal am selben Tag darauf hereingefallen —
        # einmal am Sender, einmal hier.
        def _ereignisse() -> None:
            for zeile in player.p.stdout:
                try:
                    msg = json.loads(zeile)
                except json.JSONDecodeError:
                    continue
                if msg.get("ev"):
                    print(f"[player] {json.dumps(msg, ensure_ascii=False)}", flush=True)

        threading.Thread(target=_ereignisse, daemon=True).start()
        print("Fenster ist offen. Strg-C beendet.")
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        if player:
            player.stop()
        sender.stop()
        if netz:
            netz.terminate()
            try:
                netz.wait(timeout=5)
            except subprocess.TimeoutExpired:
                netz.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
