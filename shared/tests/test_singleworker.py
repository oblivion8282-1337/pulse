"""dcc_shared.singleworker — Fail-Fast-Guard gegen Multi-Worker-Verwässerung.

Security-Scan 2026-09-18: Die In-Prozess-Rate-Limiter der Services ver-
vielfachen ihre Budgets still, wenn derselbe Service mehrfach auf einem Host
läuft. Der Guard muss das im zweiten Prozess LAUT machen — und im eigenen
Prozess idempotent bleiben (Tests bauen die App mehrfach)."""

from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

from dcc_shared import singleworker

_SVC = "singleworker-testdienst"


@pytest.fixture(autouse=True)
def _aufräumen():
    yield
    fd = singleworker._locks.pop(_SVC, None)
    if fd is not None:
        import os

        os.close(fd)


def test_idempotent_im_eigenen_prozess():
    """Ein Prozess = ein Zähler: der zweite Aufruf darf nicht werfen."""
    singleworker.assert_single_worker(_SVC)
    singleworker.assert_single_worker(_SVC)


def test_zweiter_prozess_verweigert_den_start():
    """Der eigentliche Zweck: ein fremder Prozess mit dem Lock → RuntimeError,
    statt still alle Brute-Force-Budgets zu vervielfachen."""
    kind = subprocess.Popen(
        [
            sys.executable,
            "-c",
            textwrap.dedent(f"""
                from dcc_shared.singleworker import assert_single_worker
                assert_single_worker("{_SVC}")
                print("locked", flush=True)
                import time; time.sleep(60)
            """),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert kind.stdout is not None
        assert kind.stdout.readline().strip() == "locked", "Kind-Prozess hält das Lock"
        with pytest.raises(RuntimeError, match="single-worker"):
            singleworker.assert_single_worker(_SVC)
    finally:
        kind.terminate()
        kind.wait(timeout=10)


def test_ausstieg_ueber_env(monkeypatch):
    monkeypatch.setenv("PULSE_ALLOW_MULTIPLE_WORKERS", "1")
    singleworker.assert_single_worker(_SVC)  # bewusster Ausstieg: kein Wurf
