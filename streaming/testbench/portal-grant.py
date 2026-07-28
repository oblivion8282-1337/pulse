#!/usr/bin/env python3
"""Portal-Quelle EINMAL auswählen lassen und das Restore-Token sichern.

Warum es das getrennt braucht: der Dialog blockiert, bis der Nutzer klickt,
und darf in dieser Zeit von nichts abgeräumt werden. Genau das ist die Falle,
die am 2026-07-28 einen ganzen Abend gekostet hat — und sie lag NICHT im
Portal, sondern hier: `start` antwortet SOFORT (der Sender wirft nur seinen
Worker-Faden an, `stream_controller.rs::start`), die erste Fassung hielt das
für „fertig", schlief zwei Sekunden und rief `stop`. Ein `stop` setzt im
Sidecar das Abbruch-Flag der Portal-Verhandlung (`capture/portal.rs`) — der
Dialog ging dem Nutzer nach zwei Sekunden unter den Händen zu. Die
15-Minuten-Frist hing am falschen Ereignis und war wirkungslos.

Verbindlich ist deshalb der ZUSTAND: warten, bis der Sender `live` meldet
(oder aufgibt). Token liegt danach in
`~/.local/state/pulse/portal-restore-token`, fertig.

    ./portal-grant.py
"""

from __future__ import annotations

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
            channel={"id": CID, "token": pub,
                     "push_url": f"rtmps://localhost:1936/{path}?token={pub}"},
            capture="portal",
            audio={"mode": "Aus"},
            overrides={"codec": "av1", "fps": 60, "bitrate_kbps": 1000, "bit_depth": 10},
        )
        if not res.get("ok"):
            print(f"Sender meldet: {res}", file=sys.stderr)
        # 15 Minuten fuer den Klick — hier, am Zustand, wirkt die Frist auch.
        zustand = sender.warte_auf_zustand({"live", "error", "stopped"}, timeout=900.0)
        if zustand is None:
            print("Sender meldete binnen 15 Minuten nichts.", file=sys.stderr)
        elif zustand.get("state") != "live":
            print(f"Sender ging nicht auf Sendung: {zustand}", file=sys.stderr)
        else:
            # Kurz laufen lassen: das Token schreibt der Sidecar waehrend der
            # Verhandlung, aber ein sofortiges `stop` traefe den Aufbau.
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
