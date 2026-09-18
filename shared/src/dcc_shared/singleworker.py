"""Fail-Fast-Guard: genau eine Prozess-Instanz pro Service und Host.

Die Rate-Limiter in auth-svc (``routes._check_rate``), chat-gateway und
voice-signaling (jeweils ``ratelimit.py``) und media-svc leben IN PROZESS —
mit ``uvicorn --workers 4`` oder einer zweiten Instanz desselben Services auf
demselben Host multipliziert sich jedes Brute-Force-Budget still (die Caveat
steht in jedem der Module, ein Guard fehlte — Security-Scan 2026-09-18).

Aufruf als erste Zeile im ``lifespan`` jedes betroffenen ``app.py``::

    assert_single_worker("chat-gateway")

Mechanik: exklusives ``flock`` auf ``<tmp>/pulse-singleworker-<service>.lock``,
das der Kernel beim Prozessende freigibt (auch bei Crash/Kill — kein Stale-
Lock). Idempotent innerhalb eines Prozesses (Tests bauen die App mehrfach;
ein Prozess = ein Zaehler). Ausstieg ``PULSE_ALLOW_MULTIPLE_WORKERS=1``: wer
horizontal skaliert, muss die Limiter ohnehin vorher auf Redis umstellen.

Windows hat kein ``fcntl`` — dort ist der Guard ein No-Op (die Services
laufen in Containern; Windows-Entwicklung läuft über WSL/Docker).
"""

from __future__ import annotations

import os
import tempfile

try:
    import fcntl
except ImportError:  # pragma: no cover — Windows ohne Container/WSL
    fcntl = None  # type: ignore[assignment]

# service -> Dateideskriptor; wird bewusst nie geschlossen — die Freigabe
# kommt vom Prozessende (Kernel). Hält das flock über die Lebensdauer offen.
_locks: dict[str, int] = {}


def assert_single_worker(service: str) -> None:
    """Siehe Modul-Docstring. Löst ``RuntimeError`` im zweiten Prozess aus."""
    if os.environ.get("PULSE_ALLOW_MULTIPLE_WORKERS") == "1":
        return
    if service in _locks:
        return  # gleicher Prozess (Tests) — ein Prozess, ein Zähler
    if fcntl is None:  # pragma: no cover — Windows ohne Container/WSL
        return
    pfad = os.path.join(tempfile.gettempdir(), f"pulse-singleworker-{service}.lock")
    fd = os.open(pfad, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise RuntimeError(
            f"another '{service}' process already holds the single-worker lock — "
            "running multiple workers/instances would silently multiply every "
            "in-process rate limit (brute-force budgets included). Run exactly "
            "one worker per service, or set PULSE_ALLOW_MULTIPLE_WORKERS=1 "
            "AFTER moving the rate limiters to Redis."
        ) from None
    _locks[service] = fd
