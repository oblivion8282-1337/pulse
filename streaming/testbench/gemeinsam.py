"""Bausteine, die sich die Ansicht-Werkzeuge teilen.

``ansehen.py``, ``verzoegerung.py`` und ``zeigen.py`` werfen alle denselben
Sender auf dieselbe Weise an und muessen alle dieselben Skripte nachladen, deren
Name einen Bindestrich traegt. Beides steht deshalb hier EINMAL — sonst gibt es
drei Fassungen davon, wie ein Sender gestartet wird, und sie laufen
auseinander, sobald sich am Aufruf etwas aendert.

Absichtlich NICHT hier: die Argumente der drei. Sie sehen nur aehnlich aus —
die Voreinstellungen fuer die Bitrate unterscheiden sich, ``zeigen.py`` kennt
kein SRT und hat eine eigene Option. Ein gemeinsamer Parser mit einem Schalter
je Abweichung waere schwerer zu lesen als drei kurze Bloecke.

Kein Programm, nur ein Modul: die drei Werkzeuge bleiben einzeln aufrufbar.
"""

from __future__ import annotations

import importlib.util
import sys

from harness import CID, HERE


def laden(datei: str):
    """Modul mit Bindestrich im Namen laden.

    ``fern-harness.py``, ``netz-harness.py`` und ``real-harness.py`` sind als
    Programme benannt, nicht als Module — ein ``import`` waere ein
    Syntaxfehler. Die Bausteine daraus hier nachzubauen waere schlimmer: dann
    gaebe es zwei Fassungen davon, wie ein Sender gestartet und eine Stoerung
    gesetzt wird, und sie wuerden auseinanderlaufen.
    """
    spec = importlib.util.spec_from_file_location(datei.replace("-", "_"), HERE / f"{datei}.py")
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


def sender_starten(sender, args, token: str, push_url: str) -> bool:
    """Den Sender mit den Werten aus ``args`` anwerfen; meldet, ob es geklappt hat.

    Der Fehlerfall wird gemeldet statt geworfen, damit die Aufrufer ihre
    Aufraeum-Kette (``finally``) unveraendert behalten — dort haengt bei
    ``zeigen.py`` das Abraeumen der ``tc``-Regel dran.
    """
    res = sender.call(
        "start",
        channel={"id": CID, "token": token, "push_url": push_url},
        capture="portal",
        audio={"mode": args.audio},
        overrides={"codec": args.codec, "fps": args.fps,
                   "bitrate_kbps": args.kbps, "bit_depth": args.bits},
    )
    if res.get("ok"):
        return True
    print(f"Sender-Start fehlgeschlagen: {res}", file=sys.stderr)
    return False
