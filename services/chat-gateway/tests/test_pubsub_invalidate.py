"""Targeted tests for ConnectionManager cache invalidation + the
``_filter_by_view_channel`` broadcast filter.

Why a separate file: ``test_ws_permissions.py`` already exercises the
end-to-end "open WS → mutate role → drop frame" path. These tests poke
at the manager's internal state directly to catch:

* The ``_ws_perms`` resurrection bug — a defaultdict would silently
  re-create entries for sockets already removed.
* DM-vs-deleted-channel disambiguation — both produced ``Channel.get is
  None`` before; the deleted case used to leak race-window broadcasts.
* Parallel permission resolution — the filter now ``asyncio.gather``s
  rather than awaiting each target sequentially.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from dcc_chat_gateway.models import (
    Channel,
    DirectMessageChannel,
    Guild,
    GuildMember,
    Role,
)
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS


class _FakeWS:
    """Stand-in for ``fastapi.WebSocket`` — the manager only needs hashable
    identity + ``send_json``; we exercise the cache + filter, not fan-out."""

    def __init__(self, name: str = "ws") -> None:
        self.name = name
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    def __repr__(self) -> str:  # pragma: no cover — debugging aid only
        return f"<_FakeWS {self.name}>"


async def _register(manager, ws, user_id: int) -> AuthenticatedUser:
    user = AuthenticatedUser(
        id=user_id,
        username=f"u{user_id}",
        is_admin=False,
        payload={},
    )
    ok = await manager.register(ws, user)  # type: ignore[arg-type]
    assert ok, "register should succeed below the connection cap"
    return user


async def _seed_guild_with_channel(session_factory, owner_id: int) -> tuple[int, int]:
    """Create one guild + one text channel + the owner as a member with the
    @everyone role. Returns (guild_id, channel_id)."""
    gid = next_id()
    cid = next_id()
    async with session_factory() as s:
        s.add(Guild(id=gid, name="g", owner_id=owner_id))
        await s.flush()
        s.add(GuildMember(guild_id=gid, user_id=owner_id))
        s.add(
            Role(
                id=next_id(),
                guild_id=gid,
                name="@everyone",
                permissions=DEFAULT_EVERYONE_PERMISSIONS,
                position=0,
                is_everyone=True,
            )
        )
        s.add(Channel(id=cid, guild_id=gid, name="general", type=0, position=0))
        await s.commit()
    return gid, cid


async def _seed_dm_channel(session_factory, user_a: int, user_b: int) -> int:
    a, b = sorted((user_a, user_b))
    cid = next_id()
    async with session_factory() as s:
        s.add(
            DirectMessageChannel(
                id=cid,
                user_a_id=a,
                user_b_id=b,
            )
        )
        await s.commit()
    return cid


# ---- bug #1: _ws_perms resurrection after remove_socket -------------------


@pytest.mark.asyncio
async def test_remove_socket_clears_perms_cache(app, session_factory):
    """Populate the cache via ``_resolve_channel_perms``, drop the socket,
    and verify the entry is gone *and* a subsequent resolve doesn't put
    one back (which would be the defaultdict-resurrection bug)."""
    manager = app.state.connection_manager
    owner_id = 4242
    _, cid = await _seed_guild_with_channel(session_factory, owner_id)

    ws = _FakeWS("owner-ws")
    await _register(manager, ws, owner_id)

    value = await manager._resolve_channel_perms(ws, cid)
    assert value >= 0, "session factory wired up → real resolve"
    assert ws in manager._ws_perms
    assert cid in manager._ws_perms[ws]

    await manager.remove_socket(ws)  # type: ignore[arg-type]
    assert ws not in manager._ws_perms

    # Another resolve on the removed socket must NOT re-insert an entry.
    # The manager treats it as an unknown ws → returns 0 early.
    value2 = await manager._resolve_channel_perms(ws, cid)
    assert value2 == 0
    assert ws not in manager._ws_perms, (
        "removed ws was resurrected in _ws_perms — defaultdict bug regressed"
    )


@pytest.mark.asyncio
async def test_invalidate_for_member_does_not_resurrect_removed_ws(
    app, session_factory
):
    """``_invalidate_for_member`` used to call ``self._ws_perms[ws].clear()``
    via the defaultdict, which silently inserted an empty dict for any
    ws no longer in the cache. Verify it now no-ops via ``.get(ws)``."""
    manager = app.state.connection_manager
    owner_id = 7777
    _, cid = await _seed_guild_with_channel(session_factory, owner_id)

    ws = _FakeWS("survivor")
    await _register(manager, ws, owner_id)
    await manager._resolve_channel_perms(ws, cid)
    assert ws in manager._ws_perms

    # Simulate: socket removed, then a member_roles_updated arrives for the
    # same user. Must not resurrect ws in _ws_perms.
    await manager.remove_socket(ws)  # type: ignore[arg-type]
    manager._invalidate_for_member(owner_id)
    assert ws not in manager._ws_perms


# ---- bug #2: DM vs deleted-channel disambiguation -------------------------


@pytest.mark.asyncio
async def test_filter_drops_targets_when_channel_deleted(app, session_factory):
    """A guild channel that no longer exists in the DB must produce an
    empty broadcast list — the pre-fix behaviour was to fall through
    unfiltered (race window between channel-delete and _subs cleanup)."""
    manager = app.state.connection_manager
    owner_id = 9000
    _, cid = await _seed_guild_with_channel(session_factory, owner_id)

    ws = _FakeWS("target")
    await _register(manager, ws, owner_id)
    # Populate _subs to mirror the real race: the channel was subscribed,
    # then deleted out from under us before _subs[cid] got cleaned up.
    await manager.subscribe(ws, str(cid))  # type: ignore[arg-type]

    # Delete the channel row.
    async with session_factory() as s:
        ch = await s.get(Channel, cid)
        await s.delete(ch)
        await s.commit()

    # No DirectMessageChannel row exists for cid either → filter returns [].
    kept = await manager._filter_by_view_channel([ws], str(cid))  # type: ignore[arg-type]
    assert kept == [], (
        "deleted/unknown channel must drop broadcast — was leaking to all targets"
    )


@pytest.mark.asyncio
async def test_filter_dm_channel_passes_through(app, session_factory):
    """DM channels live in a separate table; the resolver doesn't apply
    here, so all targets pass through unfiltered."""
    manager = app.state.connection_manager
    user_a = 11_111
    user_b = 22_222
    cid = await _seed_dm_channel(session_factory, user_a, user_b)

    ws_a = _FakeWS("a")
    ws_b = _FakeWS("b")
    await _register(manager, ws_a, user_a)
    await _register(manager, ws_b, user_b)

    kept = await manager._filter_by_view_channel([ws_a, ws_b], str(cid))  # type: ignore[arg-type]
    assert set(kept) == {ws_a, ws_b}


# ---- bug #3: parallel permission resolves ---------------------------------


@pytest.mark.asyncio
async def test_filter_parallel_resolves_targets(app, session_factory, monkeypatch):
    """Five sockets, cold cache → the filter must resolve concurrently.

    We measure wall-clock time with an artificial delay injected into
    ``can_view_channel``. Sequential: 5 × delay; parallel: ≈ 1 × delay.
    Pass threshold = 2.5 × delay (well below 5 × but above the noise floor).
    """
    manager = app.state.connection_manager
    owner_id = 33_000
    gid, cid = await _seed_guild_with_channel(session_factory, owner_id)

    # Register 5 sockets, each for a distinct user that is a member of the
    # guild. The resolver walks the role snapshot for each of them; under
    # sequential filtering this becomes 5 × DB round-trips serially.
    sockets: list[_FakeWS] = []
    for i in range(5):
        uid = owner_id + 100 + i
        ws = _FakeWS(f"t{i}")
        user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
        ok = await manager.register(ws, user)  # type: ignore[arg-type]
        assert ok
        async with session_factory() as s:
            s.add(GuildMember(guild_id=gid, user_id=uid))
            await s.commit()
        sockets.append(ws)

    delay = 0.05

    original = manager.can_view_channel

    async def slow_can_view(ws, channel_id):  # type: ignore[no-untyped-def]
        await asyncio.sleep(delay)
        return await original(ws, channel_id)

    monkeypatch.setattr(manager, "can_view_channel", slow_can_view)

    t0 = time.perf_counter()
    kept = await manager._filter_by_view_channel(sockets, str(cid))  # type: ignore[arg-type]
    elapsed = time.perf_counter() - t0

    assert set(kept) == set(sockets)
    # Sequential lower bound = N × delay = 0.25 s. Parallel ≈ delay = 0.05 s.
    # Threshold 2.5 × delay catches the regression while tolerating CI noise.
    assert elapsed < 2.5 * delay, (
        f"filter took {elapsed:.3f}s for {len(sockets)} targets at {delay}s each — "
        "appears sequential, not parallel"
    )
