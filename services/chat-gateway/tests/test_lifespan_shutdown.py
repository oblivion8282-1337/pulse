"""Lifespan shutdown must stay bounded: a background task slow to act on its
cancel must not hold shutdown past ``_SHUTDOWN_TASK_TIMEOUT_S``.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from starlette.testclient import TestClient

import dcc_chat_gateway.app as chat_app


@pytest.mark.asyncio
async def test_shutdown_does_not_wait_out_a_slow_task(ws_app, caplog, monkeypatch):
    """Shutdown must abandon a task that outlasts the deadline, and name it.

    The stand-in ignores its first cancel and then takes ~4s against a 1s
    deadline. It does finish: a task that ignored cancels *forever* would wedge
    the event-loop teardown too, which no lifespan deadline can help with.
    """
    monkeypatch.setattr(chat_app, "_SHUTDOWN_TASK_TIMEOUT_S", 1)

    async def _slow_to_cancel(*_args, **_kwargs) -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            await asyncio.sleep(4)  # dawdles well past the deadline

    # jwks_poller_loop is stubbed inert by the autouse fixture; make it slow.
    monkeypatch.setattr(chat_app, "jwks_poller_loop", _slow_to_cancel)

    def _run() -> float:
        t0 = time.monotonic()
        with TestClient(ws_app):
            pass  # start, then shut down immediately
        return time.monotonic() - t0

    elapsed = await asyncio.wait_for(asyncio.to_thread(_run), timeout=20)

    # Without the deadline this waits out the full 4s (and, for a task that
    # never yields, forever).
    assert elapsed < 3.5, f"shutdown waited out the slow task: {elapsed:.1f}s"
    assert any(
        "ignored cancel" in r.message and "dcc-jwks-poller" in r.message
        for r in caplog.records
    ), f"shutdown must log the wedged task by name; got {[r.message for r in caplog.records]}"
