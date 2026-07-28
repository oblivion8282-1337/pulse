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
import sys
import time

from gemeinsam import laden, sender_starten
from harness import HERE, Player

_fern = laden("fern-harness")
Sidecar = laden("real-harness").Sidecar


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proto", default="whip", choices=["rtmps", "srt", "whip"])
    ap.add_argument("--codec", default="av1")
    ap.add_argument("--bits", type=int, default=10)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--kbps", type=int, default=8000)
    ap.add_argument("--audio", default="Desktop")
    args = ap.parse_args()

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
        res = player.call("open", url=whep, title="Pulse")
        if not res.get("ok"):
            print(f"Player-Start fehlgeschlagen: {res}", file=sys.stderr)
            return 1
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
