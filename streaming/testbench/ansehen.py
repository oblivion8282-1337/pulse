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
    args = ap.parse_args()

    if args.lokal:
        path, pub, rd = mint_tokens()
        whep = f"http://localhost:8889/{path}/whep?token={rd}"
        push = (f"http://localhost:8889/{path}/whip?token={pub}" if args.proto == "whip"
                else f"rtmps://localhost:1936/{path}?token={pub}")
    else:
        path, pub, rd = _fern.mint_remote()
        whep = f"https://{_fern.HOST}/whep/{path}/whep?token={rd}"
        push = _fern.push_url(path, pub, args.proto, 120)

    sender = Sidecar(open(HERE / "ansehen-sender.log", "w"))
    player = None
    try:
        if not sender_starten(sender, args, pub, push):
            return 1
        print(f"Sender laeuft ({args.proto}, {args.codec} {args.bits} bit, "
              f"{args.fps} fps, {args.kbps} kbps) — warte auf den Server ...")
        time.sleep(5.0)

        player = Player(open(HERE / "ansehen-player.log", "w"))
        # Stumm: der Ton des Fensters liefe sonst ueber die Desktop-Aufnahme
        # zurueck in den Strom — eine Rueckkopplung, die sich aufschaukelt.
        # Wer den Ton beurteilen will, nimmt `--audio Aus` und hoert direkt.
        res = player.call("open", url=whep, title="Pulse", options={"volume": 0.0})
        if not res.get("ok"):
            print(f"Player-Start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
        # Ein Vollbild auf Zuruf, sobald das Fenster offen ist. Im
        # Intra-Refresh-Betrieb hat der Strom nach dem Start KEIN Vollbild mehr;
        # der Player wartet aber auf eines und bliebe sonst schwarz. Ohne
        # Intra-Refresh ist die Anforderung folgenlos — deshalb immer.
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
