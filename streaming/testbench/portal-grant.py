#!/usr/bin/env python3
"""Portal-Quelle EINMAL auswählen lassen und das Restore-Token sichern.

Warum es das getrennt braucht: `real-harness.py` und die Serien-Werkzeuge
rufen den Sender mit dem RPC-Vorgabe-Timeout von 90 Sekunden. Der
Portal-Dialog blockiert genau diesen Aufruf — wer nicht binnen anderthalb
Minuten klickt, dessen Dialog wird vom Prüfstand selbst abgeräumt, und im Log
steht nur ein wortloses `state=Stopped`. Am 2026-07-28 hat das drei Anläufe
gekostet, weil es wie ein Portal-Fehler aussah.

Hier ist der Timeout 15 Minuten, sonst passiert nichts: Aufnahme kurz starten,
Token liegt danach in `~/.local/state/pulse/portal-restore-token`, fertig.

    ./portal-grant.py
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from gemeinsam import laden
from harness import CID, HERE, mint_tokens

Sidecar = laden("real-harness").Sidecar

TOKEN = Path.home() / ".local/state/pulse/portal-restore-token"


def main() -> int:
    log = open(HERE / "portal-grant.log", "w")
    # ECHTES Push-Ziel (lokaler MediaMTX), kein Platzhalter: eine ungueltige
    # Adresse laesst den Sender waehrend des offenen Dialogs in den Fehlerpfad
    # laufen, der schliesst die Portal-Session — der Dialog verschwindet dem
    # Nutzer unter den Haenden. Genau so ist der erste Versuch gescheitert.
    path, pub, _rd = mint_tokens()
    sender = Sidecar(log)
    print("Dialog kommt gleich — Quelle waehlen (ein BILDSCHIRM, kein Fenster).",
          flush=True)
    try:
        res = sender.call(
            "start",
            timeout=900.0,
            channel={"id": CID, "token": pub,
                     "push_url": f"rtmps://localhost:1936/{path}?token={pub}"},
            capture="portal",
            audio={"mode": "Aus"},
            overrides={"codec": "av1", "fps": 60, "bitrate_kbps": 1000, "bit_depth": 10},
        )
        if not res.get("ok"):
            print(f"Sender meldet: {res}", file=sys.stderr)
        time.sleep(2.0)
    finally:
        sender.stop()
        log.close()

    quelle = [z for z in (HERE / "portal-grant.log").read_text(errors="replace").splitlines()
              if "Quelle gewählt" in z]
    if not quelle:
        print("KEINE Quelle gewaehlt (abgebrochen oder Dialog blieb aus).", file=sys.stderr)
        return 1
    print(quelle[-1].strip())
    print(f"Token gespeichert: {TOKEN.exists()}")
    return 0 if TOKEN.exists() else 1


if __name__ == "__main__":
    sys.exit(main())
