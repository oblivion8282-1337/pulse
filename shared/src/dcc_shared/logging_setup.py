"""Der eine Ort, an dem entschieden wird, welche Meldungen sichtbar sind.

Warum es das gibt
-----------------
Bis 2026-08-25 konfigurierte **niemand** das Logging: kein ``basicConfig``, kein
``dictConfig``, kein ``--log-level`` in irgendeinem Startbefehl. uvicorn richtet
nur seine eigenen drei Logger ein (``uvicorn``, ``uvicorn.error``,
``uvicorn.access``) und lässt den Wurzel-Logger unberührt — der steht damit auf
Pythons Vorgabe **WARNING**, ohne einen einzigen Handler.

Die Folge war nicht bloss unschön, sie hat Geld gekostet: die Diagnose, die am
2026-07-27 eigens gebaut wurde, um „warum ist der Betreiber kein Admin?" zu
beantworten (``dcc_chat_gateway.owner_admin_log``), schreibt ihre beiden
aussagekräftigen Zeilen mit ``log.info`` — und war damit **unsichtbar**.
Sichtbar blieb allein die ``log.warning`` für „OWNER_ID nicht gesetzt", also
ausgerechnet der Fall, den ``10-check-cloud-creds.sh`` schon beim Start
abfängt. Zwei Meldungen desselben Fehlers später hatte immer noch niemand die
Zeile gesehen.

Nachgemessen (nicht vermutet): nach ``dictConfig(uvicorn.config.LOGGING_CONFIG)``
liefert ``logging.getLogger("dcc_chat_gateway.owner_admin_log")`` das effektive
Level ``WARNING`` und ``isEnabledFor(INFO) is False``. Gegenprobe am echten
Container-Protokoll eines Self-Hosters: die einzigen App-Zeilen darin sind
``log.warning``-Aufrufe; kein einziges ``log.info`` taucht auf.

Was hier NICHT passiert
-----------------------
* **uvicorns Logger bleiben unangetastet.** Sie haben ``propagate: False``,
  ihre Zeilen kämen sonst doppelt.
* **structlog bleibt unangetastet.** Es schreibt mit seinen Vorgaben direkt
  nach stdout, an der Standard-Bibliothek vorbei — deshalb sind
  ``[debug]``-Zeilen aus structlog-Modulen längst sichtbar, während ein
  ``log.info`` daneben verschwindet. Dass beide Welten unterschiedlich viel
  zeigen, bleibt bestehen; hier wird nur die Seite geradegezogen, die gar
  nichts zeigte.

Die Vorgabe ist ``warning`` — damit ändert sich am Cloud-Betrieb und am
Dev-Stack **nichts**. Der Self-Host-Container setzt ``PULSE_LOG_LEVEL=info``
von sich aus (``07-render-env.sh``); dieser Schalter existierte schon, wurde
aber von niemandem gelesen. Jetzt wird er gelesen.

Wer ruft das auf, und wer nicht
-------------------------------
Angeschlossen sind die drei Dienste, die überhaupt über die Standard-Bibliothek
loggen: **auth** (12 Module), **chat-gateway** (65) und **voice-signaling** (3,
in ``routes/{chat_gateway,overrides_state,livekit_client}``). Nicht
angeschlossen sind **media-svc** und **mediamtx-auth-hook** — beide loggen
ausschliesslich über structlog, hätten also nichts davon. Beim auth-hook kommt
ein zweiter Grund dazu, der wichtiger ist als Einheitlichkeit: er hat
**bewusst keine ``dcc-shared``-Abhängigkeit** (siehe ``CLAUDE.md``), und die
wegen einer Logger-Einstellung einzuführen wäre der falsche Handel.
"""

from __future__ import annotations

import logging
import os
import sys

#: Was ``PULSE_LOG_LEVEL`` annehmen darf. Alles andere fällt auf die Vorgabe
#: zurück — ein Tippfehler im Schalter darf einen Dienst nicht am Start hindern.
STUFEN: dict[str, int] = {
    "critical": logging.CRITICAL,
    "error": logging.ERROR,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}

#: Kennzeichen unseres Handlers. Ohne das legte ein zweiter Aufruf einen
#: zweiten Handler an und jede Zeile stünde doppelt da.
_MARKE = "pulse-root"

_FORMAT = "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s"
_ZEITFORMAT = "%Y-%m-%d %H:%M:%S"


def stufe_aus_umgebung(vorgabe: str = "warning") -> int:
    """``PULSE_LOG_LEVEL`` als Zahl; unbekannte Werte ergeben die Vorgabe."""
    gewuenscht = (os.environ.get("PULSE_LOG_LEVEL") or vorgabe).strip().lower()
    return STUFEN.get(gewuenscht, STUFEN.get(vorgabe, logging.WARNING))


def konfiguriere_logging(vorgabe: str = "warning") -> int:
    """Setzt Level und Handler des Wurzel-Loggers. Mehrfach aufrufbar.

    Gibt die gesetzte Stufe zurück, damit ein Aufrufer (und der Test) sie
    prüfen kann, statt sie erneut aus der Umgebung abzuleiten.
    """
    stufe = stufe_aus_umgebung(vorgabe)
    wurzel = logging.getLogger()
    wurzel.setLevel(stufe)

    for vorhanden in wurzel.handlers:
        if getattr(vorhanden, "name", None) == _MARKE:
            vorhanden.setLevel(stufe)
            return stufe

    # stderr, nicht stdout: uvicorn schreibt seine Zeilen ebenfalls dorthin,
    # und im Container läuft ohnehin beides zusammen (`exec 2>&1`).
    handler = logging.StreamHandler(sys.stderr)
    handler.name = _MARKE
    handler.setLevel(stufe)
    handler.setFormatter(logging.Formatter(_FORMAT, datefmt=_ZEITFORMAT))
    wurzel.addHandler(handler)
    return stufe
