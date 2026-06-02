"""Unit tests for the in-process watch-party watcher registry."""

from __future__ import annotations

import asyncio

import pytest

from dcc_chat_gateway.watch_registry import _WatchRegistryMixin


class _Reg(_WatchRegistryMixin):
    """Minimal host class — the mixin only needs _watchers + a no-op _lock."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._init_watch_registry()


@pytest.mark.asyncio
async def test_join_then_next_host_orders_by_joined_at():
    reg = _Reg()
    await reg.watch_join("chan", "userA", object(), now_ms=1000)
    await reg.watch_join("chan", "userB", object(), now_ms=2000)
    assert await reg.next_host("chan", exclude_uid="userA") == "userB"
    assert await reg.next_host("chan", exclude_uid="userB") == "userA"
    assert await reg.next_host("chan", exclude_uid="userA") == "userB"


@pytest.mark.asyncio
async def test_rejoin_does_not_reset_joined_at():
    reg = _Reg()
    ws1, ws2 = object(), object()
    await reg.watch_join("chan", "userA", ws1, now_ms=1000)
    await reg.watch_join("chan", "userB", object(), now_ms=2000)
    # userA opens a second tab later — joined_at must stay 1000, so still oldest.
    await reg.watch_join("chan", "userA", ws2, now_ms=5000)
    assert await reg.next_host("chan", exclude_uid="userB") == "userA"


@pytest.mark.asyncio
async def test_multitab_refcount_user_stays_until_last_socket():
    reg = _Reg()
    ws1, ws2 = object(), object()
    await reg.watch_join("chan", "userA", ws1, now_ms=1000)
    await reg.watch_join("chan", "userA", ws2, now_ms=1000)
    assert await reg.watch_leave("chan", "userA", ws1) is False
    assert await reg.next_host("chan", exclude_uid="zzz") == "userA"
    assert await reg.watch_leave("chan", "userA", ws2) is True
    assert await reg.next_host("chan", exclude_uid="zzz") is None


@pytest.mark.asyncio
async def test_leave_unknown_is_idempotent():
    reg = _Reg()
    assert await reg.watch_leave("chan", "ghost", object()) is False
    assert await reg.watchers("chan") == []


@pytest.mark.asyncio
async def test_broadcast_watchers_fans_out_filtered_envelope():
    sent: list[tuple[list, dict]] = []

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._connections = {"wsA", "wsB"}
            self._init_watch_registry()

        async def _filter_by_view_channel(self, targets, cid):
            # Pretend wsB lacks VIEW_CHANNEL → filtered out.
            return [t for t in targets if t != "wsB"]

        async def _fan_out(self, targets, envelope):
            sent.append((list(targets), envelope))

    mgr = _Mgr()
    await mgr.watch_join("chan", "userA", object(), now_ms=1000)
    await mgr.broadcast_watchers("chan")
    assert len(sent) == 1
    targets, env = sent[0]
    assert targets == ["wsA"]
    assert env["op"] == "watch_watchers"
    assert env["channel_id"] == "chan"
    assert env["user_ids"] == ["userA"]
