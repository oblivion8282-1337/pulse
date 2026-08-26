"""Wurzel-conftest: eigener Redis-Server je Worker (pytest-xdist).

Warum ein eigener SERVER und nicht nur eine eigene Datenbank
-----------------------------------------------------------
Die Datenbank ist kein Problem — jeder Test bekommt SQLite ``:memory:`` bzw.
eine eigene Datei. Redis schon: die Suite benutzt echte Schluessel
(``presence:activity``, ``voice:room:*``) UND echte Pubsub-Kanaele
(``guild:events``, ``stream:events``, ``voice:events``).

Der erste Anlauf gab jedem Worker eine eigene Redis-DB. Das reicht nicht, und
zwar aus einem Grund, der leicht zu uebersehen ist: **Redis-Pubsub ist
server-global, nicht pro Datenbank.** Nachgemessen — eine auf DB 7
veroeffentlichte Nachricht kommt bei einem Abonnenten auf DB 2 an. Die
Schluessel waren damit getrennt, der Ereignisbus nicht, und genau daran hingen
die Tests, die weiter rot blieben (Poller, Voice-Webhook, WS-Broadcasts).

Also ein eigener ``redis-server`` je Worker. Der Prozess ist winzig
(``--save ''``, kein AOF, alles im Speicher), startet in Millisekunden und
stirbt mit dem Worker.

Ohne ``-n`` passiert nichts: ``PYTEST_XDIST_WORKER`` ist dann nicht gesetzt,
``REDIS_URL`` bleibt unangetastet und alles laeuft wie bisher gegen den
gemeinsamen Dev-Redis.
"""

from __future__ import annotations

import atexit
import os
import shutil
import socket
import subprocess
import time

_START_FRIST_S = 10.0


def _freier_port() -> int:
    """Vom Betriebssystem einen freien Port geben lassen.

    Nicht ``6381 + worker_nummer``: laufen zwei Testlaeufe gleichzeitig (der
    Entwickler und ein Agent, oder zwei Worktrees), kollidieren feste Ports —
    und der zweite Lauf haenge sich still an den Redis des ersten, also genau
    an die Vermischung, die hier verhindert werden soll.
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _warte_auf_port(port: int, prozess: subprocess.Popen) -> None:
    ende = time.monotonic() + _START_FRIST_S
    while time.monotonic() < ende:
        if prozess.poll() is not None:
            raise RuntimeError(
                f"redis-server für den Testlauf beendete sich sofort "
                f"(Exit {prozess.returncode})."
            )
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    prozess.terminate()
    raise RuntimeError(f"redis-server auf Port {port} war nach {_START_FRIST_S}s nicht da.")


def _eigener_redis_je_worker() -> None:
    if not os.environ.get("PYTEST_XDIST_WORKER"):
        return
    if shutil.which("redis-server") is None:
        # Fail-closed statt einer Warnung: ohne eigenen Server teilen sich die
        # Worker den Ereignisbus, und das erzeugt Fehlschlaege, die wie
        # flackernde Tests aussehen und keine sind. Ein solcher Lauf ist
        # wertlos — er darf nicht wie ein Ergebnis aussehen.
        raise RuntimeError(
            "Paralleler Testlauf (-n) braucht `redis-server` im PATH — jeder "
            "Worker bekommt einen eigenen (Pubsub ist server-global, eine "
            "eigene DB je Worker reicht NICHT). Entweder installieren oder "
            "seriell laufen lassen (PULSE_GATE_JOBS=1)."
        )
    port = _freier_port()
    prozess = subprocess.Popen(
        [
            "redis-server",
            "--port", str(port),
            "--bind", "127.0.0.1",
            "--save", "",
            "--appendonly", "no",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    atexit.register(lambda: (prozess.terminate(), prozess.wait(timeout=5)))
    _warte_auf_port(port, prozess)
    # DB 1 wie im seriellen Lauf — zwei Paket-conftests erzwingen ohnehin ``/1``
    # (media-svc, mediamtx-auth-hook), und auf einem eigenen Server ist das
    # jetzt folgenlos.
    os.environ["REDIS_URL"] = f"redis://127.0.0.1:{port}/1"


_eigener_redis_je_worker()
