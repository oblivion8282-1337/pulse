# Watch-Party Host-Handoff Implementation Plan

> **ÜBERHOLT — der Auto-Handoff ist zurückgenommen worden.**
> Nachfolger: `2026-06-02-watch-party-host-sticky.md` daneben. Dort behält der
> Host die Party bis zur ausdrücklichen Abgabe (`watch_handoff`); es gibt
> **kein** automatisches Weiterreichen an den ältesten Zuschauer mehr.
> Der Code bestätigt den Sticky-Stand: `ws_watch.py` ruft `end_if_host` bzw.
> `end_or_grace_if_host`, nirgends das unten geplante `promote_or_end`.
>
> Dieses Blatt bleibt als Historie stehen — die Watcher-Registry und der
> Socket-Refcount daraus sind gebaut und in Betrieb, nur der Handoff-Teil nicht.
> Wer hier ohne diesen Hinweis anfing, baute eine Funktion nach, die bewusst
> entfernt wurde.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wenn der Host einer Watch-Party verschwindet (Disconnect / Channel-Leave / Kachel-Schließen / explizite Abgabe), wandert die Kontrolle automatisch zum ältesten verbliebenen Zuschauer statt die Party zu beenden; ist niemand mehr da, endet sie.

**Architecture:** Eine in-process **Watcher-Registry** im `ConnectionManager` (kein Redis — einziger Schreiber ist das Gateway selbst) trackt pro Channel, welche User die Party-Kachel gemountet haben (user-granular mit Socket-Refcount für Multi-Tab). Beim Host-Wegfall promotet eine `promote_or_end`-Funktion (unter `manager._lock`, mit Re-Check) den Redis-`host_user_id` auf den ältesten anderen Watcher oder löscht den State. Eine view-channel-gefilterte `watch_watchers`-Broadcast speist den Client-Picker.

**Tech Stack:** Python 3.14 / FastAPI / redis.asyncio / pytest-asyncio (Backend) · SvelteKit 5 Runes / TypeScript / Playwright (Frontend).

**Vorbedingungen / verifizierte Fakten:**
- `cleanup_on_disconnect` (`ws_watch.py:196`) ist **toter Code** — nur aus Tests gerufen, NIE aus dem Dispatcher. Wir wiren Disconnect-Handling erstmals.
- WS-Ops registrieren via `@register_ws_op("name")` in `ws_ops_handlers.py`; Implementierung in `ws_watch.py`. `WSOpContext` (`ws_ops_registry.py`) trägt `hosted_parties: set[str]`.
- Dispatcher-`finally` in `ws_ops.py:184` ruft heute KEIN watch-cleanup.
- `ConnectionManager` (`pubsub.py:61`) ist Mixin-komponiert: `class ConnectionManager(_ListenerMixin, _PermFilterMixin, _FriendCacheMixin)`, hält `_lock`, `_connections`, `user_socket_count`, `_fan_out`, `_filter_by_view_channel`.
- Bestehende Watch-Error-Codes: 4003/4004/4012/4013/4014/4015/4016/4017 belegt. **4018 ist frei** → `target not watching`.
- Frontend-Sender liegen in `gateway-senders.ts`, werden in `gateway-connection.ts` als Methoden gebunden und in `connection.ts` als `gateway.*` re-exportiert. Handler in `ws/handlers/watch.ts`, registriert via `index.ts::register()`.
- Test-Command Backend: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Tests nutzen Redis-Index `/1` über die `redis`-Fixture.
- Größen-Policy: Source ≤350 Z., Svelte-Components ≤250 Z. `WatchPartyTile.svelte` ist mit 413 Z. bereits drüber → Controller-Extraktion ist Pflichtbestandteil.

---

## Phase 1 — Backend: Watcher-Registry

### Task 1: `_WatchRegistryMixin` mit Join/Leave/Ordering

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/watch_registry.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/pubsub.py` (Mixin in `ConnectionManager` einhängen + `_watchers` initialisieren)
- Test: `services/chat-gateway/tests/test_watch_registry.py`

- [ ] **Step 1: Failing test schreiben**

```python
# services/chat-gateway/tests/test_watch_registry.py
"""Unit tests for the in-process watch-party watcher registry."""
from __future__ import annotations

import pytest

from dcc_chat_gateway.watch_registry import _WatchRegistryMixin


class _Reg(_WatchRegistryMixin):
    """Minimal host class — the mixin only needs _watchers + a no-op _lock."""

    def __init__(self) -> None:
        import asyncio

        self._lock = asyncio.Lock()
        self._init_watch_registry()


@pytest.mark.asyncio
async def test_join_then_next_host_orders_by_joined_at():
    reg = _Reg()
    await reg.watch_join("chan", "userA", object(), now_ms=1000)
    await reg.watch_join("chan", "userB", object(), now_ms=2000)
    # Oldest (userA) wins; exclude the departing host.
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
    # Closing one tab: user still present (other socket alive) → returns False.
    assert await reg.watch_leave("chan", "userA", ws1) is False
    assert await reg.next_host("chan", exclude_uid="zzz") == "userA"
    # Closing the last tab: user fully left → returns True.
    assert await reg.watch_leave("chan", "userA", ws2) is True
    assert await reg.next_host("chan", exclude_uid="zzz") is None


@pytest.mark.asyncio
async def test_leave_unknown_is_idempotent():
    reg = _Reg()
    assert await reg.watch_leave("chan", "ghost", object()) is False
    assert await reg.watchers("chan") == []
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_watch_registry.py -q`
Expected: FAIL — `ModuleNotFoundError: dcc_chat_gateway.watch_registry`.

- [ ] **Step 3: Mixin implementieren**

```python
# services/chat-gateway/src/dcc_chat_gateway/watch_registry.py
"""In-process watch-party watcher registry (ConnectionManager mixin).

Tracks which users currently have a watch-party tile mounted, per voice
channel. Single writer (the gateway itself) → no Redis, no TTL: this state
is only consulted at the moment a host departs, always on the pod the
departing socket lives on. Mirrors the per-socket ``hosted_parties`` pattern.

User-granularity with a socket ref-set so multi-tab is correct: a user stays
a watcher until their *last* socket leaves, and ``joined_at`` is the earliest
join (never reset on a later tab) so promotion order is stable.

Cross-pod is intentionally unsupported — the whole watch-party transport is
single-pod today.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class _WatcherEntry:
    joined_at: int
    sockets: set[Any] = field(default_factory=set)


class _WatchRegistryMixin:
    """Adds the watcher registry to ConnectionManager. Requires ``self._lock``
    (asyncio.Lock) on the host class. Call ``_init_watch_registry()`` once in
    the host ``__init__``."""

    _watchers: dict[str, dict[str, _WatcherEntry]]

    def _init_watch_registry(self) -> None:
        self._watchers = {}

    async def watch_join(
        self, channel_id: str, user_id: str, websocket: Any, *, now_ms: int | None = None
    ) -> None:
        ts = now_ms if now_ms is not None else _now_ms()
        async with self._lock:
            chan = self._watchers.setdefault(channel_id, {})
            entry = chan.get(user_id)
            if entry is None:
                entry = _WatcherEntry(joined_at=ts)
                chan[user_id] = entry
            entry.sockets.add(websocket)

    async def watch_leave(self, channel_id: str, user_id: str, websocket: Any) -> bool:
        """Remove one socket. Returns True iff the user fully left the channel
        (no sockets remain)."""
        async with self._lock:
            chan = self._watchers.get(channel_id)
            if chan is None:
                return False
            entry = chan.get(user_id)
            if entry is None:
                return False
            entry.sockets.discard(websocket)
            if entry.sockets:
                return False
            del chan[user_id]
            if not chan:
                del self._watchers[channel_id]
            return True

    async def next_host(self, channel_id: str, exclude_uid: str) -> str | None:
        """Oldest watcher (smallest joined_at) other than ``exclude_uid``."""
        async with self._lock:
            chan = self._watchers.get(channel_id)
            if not chan:
                return None
            best: tuple[int, str] | None = None
            for uid, entry in chan.items():
                if uid == exclude_uid:
                    continue
                if best is None or entry.joined_at < best[0]:
                    best = (entry.joined_at, uid)
            return best[1] if best else None

    async def watchers(self, channel_id: str) -> list[str]:
        """All user ids currently watching this channel (unordered snapshot)."""
        async with self._lock:
            chan = self._watchers.get(channel_id)
            return list(chan.keys()) if chan else []
```

- [ ] **Step 4: Mixin in ConnectionManager einhängen**

In `services/chat-gateway/src/dcc_chat_gateway/pubsub.py`: Import + Vererbung + Init.

Import oben bei den anderen Mixin-Imports ergänzen:
```python
from dcc_chat_gateway.watch_registry import _WatchRegistryMixin
```
Klassendefinition (Z.61) ändern:
```python
class ConnectionManager(
    _ListenerMixin, _PermFilterMixin, _FriendCacheMixin, _WatchRegistryMixin
):
```
In `__init__`, direkt nach `self._lock = asyncio.Lock()` (Z.131):
```python
        self._init_watch_registry()
```

- [ ] **Step 5: Tests laufen lassen — müssen grün sein**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_watch_registry.py -q`
Expected: PASS (4 Tests).

- [ ] **Step 6: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/watch_registry.py \
        services/chat-gateway/src/dcc_chat_gateway/pubsub.py \
        services/chat-gateway/tests/test_watch_registry.py
git commit -m "feat(watch-party): in-process watcher registry (ConnectionManager mixin)"
```

---

### Task 2: Watcher-Liste-Broadcast (view-channel-gefiltert)

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/watch_registry.py` (Methode `broadcast_watchers`)
- Test: `services/chat-gateway/tests/test_watch_registry.py` (ergänzen)

- [ ] **Step 1: Failing test ergänzen**

Ans Ende von `test_watch_registry.py` anhängen:
```python
@pytest.mark.asyncio
async def test_broadcast_watchers_fans_out_filtered_envelope():
    sent: list[tuple[list, dict]] = []

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            import asyncio

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
```

- [ ] **Step 2: Test laufen lassen — Fail**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_watch_registry.py::test_broadcast_watchers_fans_out_filtered_envelope -q`
Expected: FAIL — `AttributeError: 'broadcast_watchers'`.

- [ ] **Step 3: Methode implementieren**

In `watch_registry.py` ans Ende der Klasse `_WatchRegistryMixin`:
```python
    async def broadcast_watchers(self, channel_id: str) -> None:
        """Push the current watcher user-id list to everyone who can VIEW the
        channel. Direct in-process fan-out (no Redis) — consistent with the
        in-process registry. Safe to call after every join/leave."""
        user_ids = await self.watchers(channel_id)
        async with self._lock:
            raw_targets = list(self._connections)
        targets = await self._filter_by_view_channel(raw_targets, channel_id)
        envelope = {
            "op": "watch_watchers",
            "channel_id": channel_id,
            "user_ids": user_ids,
        }
        await self._fan_out(targets, envelope)
```

Note: `_filter_by_view_channel` und `_fan_out` existieren auf `ConnectionManager` (s. `pubsub_channel_handlers.py::handle_watch_events`). `_connections` ist ein `set[WebSocket]`.

- [ ] **Step 4: Test grün**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_watch_registry.py -q`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/watch_registry.py \
        services/chat-gateway/tests/test_watch_registry.py
git commit -m "feat(watch-party): view-channel-filtered watcher-list broadcast"
```

---

## Phase 2 — Backend: Promotion + WS-Ops

### Task 3: `promote_or_end` Promotions-Kern

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/watchkeys.py` (Helper `promoted_state`)
- Create: `services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py` (`promote_or_end`)
- Test: `services/chat-gateway/tests/test_watch.py` (neue Tests, s.u.)

Begründung Datei-Split: `ws_watch.py` ist bei 217 Z.; Promotion + Handoff + erweiterter Cleanup würden es über 350 drücken. Promotions-/Handoff-Logik kommt deshalb in `watch_handoff.py`.

- [ ] **Step 1: `promoted_state`-Helper in watchkeys.py (reiner State-Transform) + Test**

In `services/chat-gateway/src/dcc_chat_gateway/watchkeys.py` ergänzen (nach `now_ms`):
```python
def expected_position(state: dict, now_ms_val: int | None = None) -> float:
    """Server-side mirror of the frontend ``expectedPosition``: where the
    host clock says playback is right now."""
    pos = float(state.get("position") or 0.0)
    if not state.get("is_playing"):
        return pos
    now = now_ms_val if now_ms_val is not None else now_ms()
    elapsed = max(0.0, (now - int(state.get("updated_at") or 0)) / 1000.0)
    return pos + elapsed


def promoted_state(state: dict, new_host_id: str, now_ms_val: int | None = None) -> dict:
    """Return a copy of ``state`` with the host swapped, position refreshed to
    the extrapolated value, and updated_at bumped. is_playing is preserved so
    the new host's player resumes seamlessly."""
    now = now_ms_val if now_ms_val is not None else now_ms()
    out = dict(state)
    out["host_user_id"] = str(new_host_id)
    out["position"] = expected_position(state, now)
    out["updated_at"] = now
    return out
```

Failing test in `test_watch.py` (oben bei den Imports steht schon `from dcc_chat_gateway import watchkeys`):
```python
def test_promoted_state_swaps_host_and_refreshes_position():
    base = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 10.0,
        "is_playing": True,
        "updated_at": 1000,
        "started_at": 1000,
    }
    out = watchkeys.promoted_state(base, "222", now_ms_val=3000)
    assert out["host_user_id"] == "222"
    assert out["is_playing"] is True
    # 10s base + (3000-1000)/1000 = 2s elapsed → 12.0
    assert out["position"] == pytest.approx(12.0)
    assert out["updated_at"] == 3000
    # original untouched
    assert base["host_user_id"] == "111"
```

- [ ] **Step 2: Test Fail**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py::test_promoted_state_swaps_host_and_refreshes_position" -q`
Expected: FAIL — `AttributeError: promoted_state`.

- [ ] **Step 3: (Helper aus Step 1 ist die Implementierung) — Test grün**

Run: gleicher Befehl.
Expected: PASS.

- [ ] **Step 4: `promote_or_end` in watch_handoff.py + Test**

```python
# services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py
"""Watch-party host promotion + explicit handoff.

Split out of ws_watch.py to keep both files under the size policy. The
promotion path runs under ``manager._lock`` and re-reads ``host_user_id``
after acquiring it, so two near-simultaneous departures can't double-promote.
"""
from __future__ import annotations

import logging

from dcc_chat_gateway import watchkeys

log = logging.getLogger(__name__)


async def promote_or_end(redis, manager, channel_id: str, departing_uid: str) -> None:
    """The departing user just left the watcher set. If they were the host,
    promote the oldest remaining watcher; if none remain, end the party."""
    if redis is None:
        return
    async with manager._lock:
        state = await watchkeys.read_state(redis, channel_id)
        if state is None:
            return
        if str(state.get("host_user_id")) != str(departing_uid):
            return  # departing user was a viewer — nothing to promote
    # next_host takes its own lock; compute outside the block above.
    next_uid = await manager.next_host(channel_id, exclude_uid=str(departing_uid))
    if next_uid is None:
        await watchkeys.delete_state(redis, channel_id)
        return
    new_state = watchkeys.promoted_state(state, next_uid)
    await watchkeys.write_state(redis, channel_id, new_state)
    log.info(
        "watch-party promoted channel=%s from=%s to=%s",
        channel_id,
        departing_uid,
        next_uid,
    )
```

Failing tests in `test_watch.py` — füge sie nach den bestehenden cleanup-Tests ein. Sie nutzen einen kleinen Fake-Manager mit der echten Registry-Mixin:
```python
@pytest.mark.asyncio
async def test_promote_or_end_promotes_oldest_other_watcher(redis):
    import asyncio

    from dcc_chat_gateway.routes.watch_handoff import promote_or_end
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _Mgr()
    await mgr.watch_join(cid, "111", object(), now_ms=1000)  # host
    await mgr.watch_join(cid, "222", object(), now_ms=2000)
    await mgr.watch_join(cid, "333", object(), now_ms=3000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 5.0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)
    try:
        # Host (111) leaves the registry, then promotion runs.
        await mgr.watch_leave(cid, "111", next(iter(mgr._watchers[cid]["111"].sockets)))
        await promote_or_end(redis, mgr, cid, "111")
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "222"  # oldest remaining
        assert new["is_playing"] is True
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_promote_or_end_deletes_when_no_watchers_left(redis):
    import asyncio

    from dcc_chat_gateway.routes.watch_handoff import promote_or_end
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _Mgr()
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)
    await promote_or_end(redis, mgr, cid, "111")
    assert await redis.get(f"watch:channel-{cid}") is None


@pytest.mark.asyncio
async def test_promote_or_end_noop_for_non_host_departure(redis):
    import asyncio

    from dcc_chat_gateway.routes.watch_handoff import promote_or_end
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _Mgr()
    await mgr.watch_join(cid, "111", object(), now_ms=1000)
    await mgr.watch_join(cid, "222", object(), now_ms=2000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)
    try:
        # Viewer 222 leaves — host unchanged.
        await promote_or_end(redis, mgr, cid, "222")
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")
```

- [ ] **Step 5: Tests laufen — grün**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py" -q -k "promote_or_end or promoted_state"`
Expected: PASS (4 Tests).

- [ ] **Step 6: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/watchkeys.py \
        services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py \
        services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): promote_or_end host-promotion core"
```

---

### Task 4: WS-Ops `watch_join` / `watch_leave` + Registry-Verdrahtung

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py` (`handle_join`, `handle_leave`)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_registry.py` (`WSOpContext.watched_parties`)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_handlers.py` (Op-Registrierungen + `watch_start` join intern)
- Test: `services/chat-gateway/tests/test_watch.py`

- [ ] **Step 1: `watched_parties` an WSOpContext**

In `ws_ops_registry.py`, in der `WSOpContext`-Dataclass nach `hosted_parties`:
```python
    # Channel ids of watch parties this socket currently watches (tile mounted).
    watched_parties: set[str] = field(default_factory=set)
```

- [ ] **Step 2: Failing test (join adds to registry + broadcasts)**

In `test_watch.py` — nutzt das vorhandene `ws_app`/WS-Test-Harness. Schau dir vorhandene WS-Tests in der Datei an (z.B. `test_watch_start_via_ws...`) und spiegle das Muster. Minimaler Direkt-Handler-Test ist robuster:
```python
@pytest.mark.asyncio
async def test_handle_join_registers_and_broadcasts(redis):
    import asyncio

    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    broadcasts: list[str] = []

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

        async def broadcast_watchers(self, cid):
            broadcasts.append(cid)

    cid_int = random.randint(10**18, 10**19 - 1)
    cid = str(cid_int)
    uid = random.randint(1, 1_000_000)
    mgr = _Mgr()

    class _State:
        def __init__(self):
            self.redis = redis
            self.connection_manager = mgr

    class _App:
        state = _State()

    class _WS:
        app = _App()

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    watched: set[str] = set()

    # Membership check is monkeypatched to pass.
    async def _ok(session, c, u):
        class _Chan:
            type = 2  # CHANNEL_TYPE_VOICE
            guild_id = 1
        return _Chan()

    import dcc_chat_gateway.routes.ws_watch as wm
    orig = wm.channel_membership
    wm.channel_membership = _ok
    try:
        await ws_watch.handle_join(
            _WS(), user, {"channel_id": cid},
            session_factory=lambda: _FakeSession(),
            watched_parties=watched,
        )
    finally:
        wm.channel_membership = orig
    assert cid in watched
    assert str(uid) in await mgr.watchers(cid)
    assert broadcasts == [cid]
```

Falls in `test_watch.py` noch kein `_FakeSession` existiert, ergänze einen Async-Context-Manager-Stub:
```python
class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False
```

- [ ] **Step 3: Test Fail**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py::test_handle_join_registers_and_broadcasts" -q`
Expected: FAIL — `AttributeError: handle_join`.

- [ ] **Step 4: `handle_join` / `handle_leave` implementieren**

In `ws_watch.py` ergänzen (nach `handle_heartbeat`, vor `cleanup_on_disconnect`). Importe oben sind schon vorhanden (`channel_membership`, `CHANNEL_TYPE_VOICE`, `_channel_id`, `_redis`, `_err`):
```python
def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def handle_join(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
    watched_parties: set[str],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        await _err(websocket, 4012, "channel_id required")
        return
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
    cid = str(cid_int)
    mgr = _manager(websocket)
    if mgr is None:
        return
    await mgr.watch_join(cid, str(user.id), websocket)
    watched_parties.add(cid)
    await mgr.broadcast_watchers(cid)


async def handle_leave(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    watched_parties: set[str],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        return
    cid = str(cid_int)
    watched_parties.discard(cid)
    mgr = _manager(websocket)
    if mgr is None:
        return
    fully_left = await mgr.watch_leave(cid, str(user.id), websocket)
    await mgr.broadcast_watchers(cid)
    if fully_left:
        from dcc_chat_gateway.routes.watch_handoff import promote_or_end

        await promote_or_end(_redis(websocket), mgr, cid, str(user.id))
```

- [ ] **Step 5: `watch_start` joint den Host intern + Op-Registrierungen**

In `ws_watch.py::handle_start`, am Ende (nach `hosted_parties.add(cid)`), den Host in die Registry aufnehmen. Signatur von `handle_start` um `watched_parties` erweitern:

`handle_start(...)`-Signatur ändern zu:
```python
async def handle_start(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
    hosted_parties: set[str],
    watched_parties: set[str],
) -> None:
```
Am Ende von `handle_start` (nach `hosted_parties.add(cid)`):
```python
    mgr = _manager(websocket)
    if mgr is not None:
        await mgr.watch_join(cid, str(user.id), websocket)
        watched_parties.add(cid)
        await mgr.broadcast_watchers(cid)
```

In `ws_ops_handlers.py`: `handle_watch_start` um `watched_parties` erweitern und neue Ops registrieren:
```python
@register_ws_op("watch_start")
async def handle_watch_start(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_start(
        ctx.websocket,
        ctx.user,
        msg,
        session_factory=SessionLocal,
        hosted_parties=ctx.hosted_parties,
        watched_parties=ctx.watched_parties,
    )


@register_ws_op("watch_join")
async def handle_watch_join(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_join(
        ctx.websocket, ctx.user, msg,
        session_factory=SessionLocal,
        watched_parties=ctx.watched_parties,
    )


@register_ws_op("watch_leave")
async def handle_watch_leave(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await ws_watch.handle_leave(
        ctx.websocket, ctx.user, msg, watched_parties=ctx.watched_parties
    )
```

Außerdem die existierende `test_cleanup_on_disconnect_*`-Aufrufe (Task 6) und ggf. bestehende `handle_start`-Aufrufer prüfen (`grep -rn "handle_start(" services/chat-gateway`). Falls Tests `handle_start` direkt rufen, `watched_parties=set()` ergänzen.

- [ ] **Step 6: Test grün + Regression**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py" -q`
Expected: Neue join-Tests PASS. (cleanup-Tests evtl. noch rot — in Task 6 angefasst; falls rot, dort fixen.)

- [ ] **Step 7: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py \
        services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_registry.py \
        services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_handlers.py \
        services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): watch_join/watch_leave ops + registry wiring"
```

---

### Task 5: Op `watch_handoff` (explizit, mit/ohne Target)

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py` (`handle_handoff`)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_handlers.py` (Op-Registrierung)
- Test: `services/chat-gateway/tests/test_watch.py`

- [ ] **Step 1: Failing tests**

```python
@pytest.mark.asyncio
async def test_handoff_to_valid_target_swaps_host(redis):
    import asyncio

    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

        async def broadcast_watchers(self, cid):
            pass

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _Mgr()
    await mgr.watch_join(cid, "111", object(), now_ms=1000)
    await mgr.watch_join(cid, "222", object(), now_ms=2000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)

    errors: list[tuple[int, str]] = []

    class _WS:
        class app:
            class state:
                pass
        async def send_json(self, payload):
            if payload.get("op") == "error":
                errors.append((payload["code"], payload["msg"]))

    ws = _WS()
    ws.app.state.redis = redis
    ws.app.state.connection_manager = mgr
    user = AuthenticatedUser(id=111, username="u111", is_admin=False, payload={})
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "target_user_id": "222"}
        )
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "222"
        assert errors == []
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handoff_to_non_watcher_errors_4018(redis):
    import asyncio

    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

        async def broadcast_watchers(self, cid):
            pass

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _Mgr()
    await mgr.watch_join(cid, "111", object(), now_ms=1000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)
    errors: list[tuple[int, str]] = []

    class _WS:
        class app:
            class state:
                pass
        async def send_json(self, payload):
            if payload.get("op") == "error":
                errors.append((payload["code"], payload["msg"]))

    ws = _WS()
    ws.app.state.redis = redis
    ws.app.state.connection_manager = mgr
    user = AuthenticatedUser(id=111, username="u111", is_admin=False, payload={})
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "target_user_id": "999"}
        )
        assert errors and errors[0][0] == 4018
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "111"  # unchanged
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handoff_by_non_host_errors_4015(redis):
    import asyncio

    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

        async def broadcast_watchers(self, cid):
            pass

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _Mgr()
    await mgr.watch_join(cid, "111", object(), now_ms=1000)
    await mgr.watch_join(cid, "222", object(), now_ms=2000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "111",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)
    errors: list[tuple[int, str]] = []

    class _WS:
        class app:
            class state:
                pass
        async def send_json(self, payload):
            if payload.get("op") == "error":
                errors.append((payload["code"], payload["msg"]))

    ws = _WS()
    ws.app.state.redis = redis
    ws.app.state.connection_manager = mgr
    user = AuthenticatedUser(id=222, username="u222", is_admin=False, payload={})
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "target_user_id": "111"}
        )
        assert errors and errors[0][0] == 4015
    finally:
        await redis.delete(f"watch:channel-{cid}")
```

- [ ] **Step 2: Tests Fail**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py" -q -k handoff`
Expected: FAIL — `AttributeError: handle_handoff`.

- [ ] **Step 3: `handle_handoff` implementieren**

In `watch_handoff.py` ergänzen:
```python
from typing import Any

from fastapi import WebSocket


def _redis(websocket: WebSocket):
    return getattr(websocket.app.state, "redis", None)


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str) -> None:
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


def _channel_id(value: object) -> str | None:
    s = str(value or "").strip()
    if not s or not s.isdigit():
        return None
    return s


async def handle_handoff(
    websocket: WebSocket, user, msg: dict[str, Any]
) -> None:
    cid = _channel_id(msg.get("channel_id"))
    if cid is None:
        await _err(websocket, 4012, "channel_id required")
        return
    redis = _redis(websocket)
    mgr = _manager(websocket)
    if redis is None or mgr is None:
        return
    state = await watchkeys.read_state(redis, cid)
    if state is None:
        await _err(websocket, 4016, "no active watch party")
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can hand off")
        return
    target = msg.get("target_user_id")
    if target:
        target = str(target)
        if target not in await mgr.watchers(cid):
            await _err(websocket, 4018, "target not watching")
            return
        new_state = watchkeys.promoted_state(state, target)
        await watchkeys.write_state(redis, cid, new_state)
        return
    # No target → promote next oldest (host stays a viewer in the registry).
    await promote_or_end(redis, mgr, cid, str(user.id))
```

Hinweis: `promote_or_end`s Schritt-2-Check (`host_user_id == departing`) gilt: bei „no target" ist `departing = current host`, also wird promotet. Der abgebende Host bleibt über seine weiterhin gemountete Kachel in der Registry → kann später erneut promotet werden.

- [ ] **Step 4: Op registrieren**

In `ws_ops_handlers.py` (Import oben ergänzen `from dcc_chat_gateway.routes import watch_handoff`):
```python
@register_ws_op("watch_handoff")
async def handle_watch_handoff(ctx: WSOpContext, msg: dict[str, Any]) -> None:
    await watch_handoff.handle_handoff(ctx.websocket, ctx.user, msg)
```

- [ ] **Step 5: Tests grün**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py" -q -k handoff`
Expected: PASS (3 Tests).

- [ ] **Step 6: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py \
        services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_handlers.py \
        services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): explicit watch_handoff op (target + auto)"
```

---

### Task 6: Dispatcher-Cleanup verdrahten + tote `cleanup_on_disconnect` ersetzen

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py` (`cleanup_on_disconnect` neu)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops.py` (Aufruf im `finally`)
- Test: `services/chat-gateway/tests/test_watch.py` (bestehende cleanup-Tests umschreiben)

- [ ] **Step 1: `cleanup_on_disconnect` neu schreiben**

Ersetze die bestehende Funktion (`ws_watch.py:196-216`) komplett:
```python
async def cleanup_on_disconnect(
    websocket: WebSocket,
    user: AuthenticatedUser,
    manager,
    watched_parties: set[str],
) -> None:
    """Socket closing: leave every party this socket watched, promoting a new
    host (or ending the party) wherever this socket's user was the host and is
    now fully gone. Runs BEFORE ``manager.remove_socket`` so the registry's
    socket set is still accurate."""
    if not watched_parties:
        return
    from dcc_chat_gateway.routes.watch_handoff import promote_or_end

    redis = _redis(websocket)
    for cid in list(watched_parties):
        try:
            fully_left = await manager.watch_leave(cid, str(user.id), websocket)
            await manager.broadcast_watchers(cid)
            if fully_left:
                await promote_or_end(redis, manager, cid, str(user.id))
        except Exception:
            log.exception("watch-party disconnect cleanup failed for channel %s", cid)
```

- [ ] **Step 2: Aufruf in den Dispatcher-`finally`**

In `ws_ops.py`, im `finally`-Block (Z.184), VOR `await manager.remove_socket(websocket)` (Z.196). Ersetze den Kommentarblock Z.191-195 durch:
```python
        # Watch parties: leave the watcher registry for every party this
        # socket watched and promote a new host (or end the party) where this
        # user was the host. Must run before remove_socket so the registry's
        # socket set still includes this connection.
        try:
            await ws_watch.cleanup_on_disconnect(
                websocket, user, manager, ctx.watched_parties
            )
        except Exception:  # noqa: BLE001
            log.exception("watch cleanup_on_disconnect failed for user=%s", user.id)
```
Import oben in `ws_ops.py` ergänzen (bei den anderen `from dcc_chat_gateway.routes import ...`):
```python
from dcc_chat_gateway.routes import ws_watch
```

- [ ] **Step 3: Bestehende cleanup-Tests umschreiben**

Die alten Tests (`test_cleanup_on_disconnect_deletes_hosted_party`, `test_cleanup_skips_when_user_has_other_sockets`, `test_watch.py:627-706`) rufen die alte Signatur `cleanup_on_disconnect(_WS(redis), user, _Mgr(), {cid})` mit einem `_Mgr` der nur `user_socket_count` hat. Ersetze beide durch Versionen, die die echte Registry-Mixin nutzen:

```python
@pytest.mark.asyncio
async def test_cleanup_on_disconnect_promotes_or_ends(redis):
    import asyncio

    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self, r):
            self._lock = asyncio.Lock()
            self._init_watch_registry()
            self._r = r

        async def broadcast_watchers(self, cid):
            pass

    cid = str(random.randint(10**18, 10**19 - 1))
    uid = random.randint(1, 1_000_000)
    mgr = _Mgr(redis)
    host_ws, viewer_ws = object(), object()
    await mgr.watch_join(cid, str(uid), host_ws, now_ms=1000)
    await mgr.watch_join(cid, "999", viewer_ws, now_ms=2000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": str(uid),
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)

    class _State:
        def __init__(self, r):
            self.redis = r

    class _App:
        def __init__(self, r):
            self.state = _State(r)

    class _WS:
        def __init__(self, r, ws_obj):
            self.app = _App(r)
            self._ws = ws_obj

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        # The disconnecting socket IS host_ws. cleanup uses the websocket arg
        # as the registry key, so pass host_ws as the websocket.
        await ws_watch.cleanup_on_disconnect(
            _WrapWS(redis, host_ws), user, mgr, {cid}
        )
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "999"  # promoted to remaining viewer
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_cleanup_on_disconnect_ends_when_solo(redis):
    import asyncio

    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

        async def broadcast_watchers(self, cid):
            pass

    cid = str(random.randint(10**18, 10**19 - 1))
    uid = random.randint(1, 1_000_000)
    mgr = _Mgr()
    host_ws = object()
    await mgr.watch_join(cid, str(uid), host_ws, now_ms=1000)
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": str(uid),
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)

    class _State:
        def __init__(self, r):
            self.redis = r

    class _App:
        def __init__(self, r):
            self.state = _State(r)

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    await ws_watch.cleanup_on_disconnect(_WrapWS(redis, host_ws), user, mgr, {cid})
    assert await redis.get(f"watch:channel-{cid}") is None
```

Helper `_WrapWS` (einmal in `test_watch.py` definieren, falls nicht vorhanden) — die `cleanup_on_disconnect` nutzt `websocket` sowohl für `_redis(websocket)` als auch als Registry-Socket-Key. Damit `manager.watch_leave(cid, uid, websocket)` denselben Key trifft wie der Join, muss `websocket is host_ws` gelten. Lösung: Join mit dem **echten** WS-Objekt durchführen. Definiere:
```python
class _WrapWS:
    """A websocket stand-in whose identity IS ``ws_obj`` for registry keying,
    but that also exposes ``.app.state.redis``."""
    def __init__(self, r, ws_obj):
        self.app = type("A", (), {"state": type("S", (), {"redis": r})()})()
        self._identity = ws_obj
    def __hash__(self):
        return hash(self._identity)
    def __eq__(self, other):
        return other is self._identity or other is self
```
Und im Test den Join mit demselben Wrapper durchführen statt mit `host_ws`:
```python
    wrap = _WrapWS(redis, host_ws)
    await mgr.watch_join(cid, str(uid), wrap, now_ms=1000)
    ...
    await ws_watch.cleanup_on_disconnect(wrap, user, mgr, {cid})
```
(Passe die beiden Tests entsprechend an: erst `wrap` bauen, damit join und cleanup denselben Socket-Key verwenden.)

**Lösche** die alten `test_cleanup_on_disconnect_deletes_hosted_party` und `test_cleanup_skips_when_user_has_other_sockets`.

- [ ] **Step 4: Tests grün**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest "services/chat-gateway/tests/test_watch.py" -q`
Expected: PASS (alle, inkl. neuer cleanup-Tests).

- [ ] **Step 5: Voll-Suite chat-gateway (Regression: Dispatcher unverändert funktional)**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py \
        services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops.py \
        services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): wire disconnect cleanup → promote_or_end (replaces dead code)"
```

---

## Phase 3 — Frontend: Protokoll-Plumbing

### Task 7: Senders + ClientEvent-Types + Gateway-Methoden

**Files:**
- Modify: `web/src/lib/ws/gateway-senders.ts`
- Modify: `web/src/lib/ws/handlers/types.ts` (ClientEvent + ServerEvent)
- Modify: `web/src/lib/ws/gateway-connection.ts`
- Modify: `web/src/lib/ws/connection.ts`

- [ ] **Step 1: ClientEvent + ServerEvent erweitern**

In `web/src/lib/ws/handlers/types.ts`:
- Bei den ClientEvent-Branches (nach `watch_heartbeat`, Z.253):
```typescript
  | { op: 'watch_join'; channel_id: string }
  | { op: 'watch_leave'; channel_id: string }
  | { op: 'watch_handoff'; channel_id: string; target_user_id?: string }
```
- Bei den ServerEvent-Branches (nach `watch_state`, Z.161):
```typescript
  | { op: 'watch_watchers'; channel_id: string; user_ids: string[] }
```

- [ ] **Step 2: Senders**

In `gateway-senders.ts` nach `sendWatchHeartbeat`:
```typescript
export function sendWatchJoin(send: SendRaw, channelId: string): boolean {
  return send({ op: 'watch_join', channel_id: channelId });
}
export function sendWatchLeave(send: SendRaw, channelId: string): boolean {
  return send({ op: 'watch_leave', channel_id: channelId });
}
export function sendWatchHandoff(
  send: SendRaw, channelId: string, targetUserId?: string,
): boolean {
  return send({ op: 'watch_handoff', channel_id: channelId, target_user_id: targetUserId });
}
```

- [ ] **Step 3: Gateway-Connection-Methoden**

In `gateway-connection.ts` nach `sendWatchHeartbeat` (Z.427):
```typescript
  sendWatchJoin = (channelId: string): boolean => senders.sendWatchJoin(this._raw, channelId);
  sendWatchLeave = (channelId: string): boolean => senders.sendWatchLeave(this._raw, channelId);
  sendWatchHandoff = (channelId: string, targetUserId?: string): boolean =>
    senders.sendWatchHandoff(this._raw, channelId, targetUserId);
```

- [ ] **Step 4: `gateway`-Facade**

In `connection.ts` nach `sendWatchHeartbeat` (Z.70):
```typescript
  sendWatchJoin: (cid: string) => _active().sendWatchJoin(cid),
  sendWatchLeave: (cid: string) => _active().sendWatchLeave(cid),
  sendWatchHandoff: (cid: string, target?: string) => _active().sendWatchHandoff(cid, target),
```

- [ ] **Step 5: Typecheck**

Run: `cd web && pnpm check`
Expected: 0 Errors / 0 Warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/ws/gateway-senders.ts web/src/lib/ws/handlers/types.ts \
        web/src/lib/ws/gateway-connection.ts web/src/lib/ws/connection.ts
git commit -m "feat(web/watch-party): watch_join/leave/handoff senders + watch_watchers type"
```

---

### Task 8: `watchWatchers`-Store + Handler

**Files:**
- Create: `web/src/lib/stores/watchWatchers.svelte.ts`
- Modify: `web/src/lib/ws/handlers/watch.ts`
- Modify: `web/src/lib/stores/multi-server-reset.ts` (Store mit zurücksetzen — wie `watchPartyPresence`)

- [ ] **Step 1: Store anlegen**

```typescript
// web/src/lib/stores/watchWatchers.svelte.ts
/**
 * Watch-party watcher lists, per channel — who currently has the party tile
 * mounted. Fed by the `watch_watchers` WS push (view-channel-filtered server
 * side). Used by the host's "hand off control" picker and a "X watching"
 * count. Ephemeral: cleared when the party ends or on channel/server switch.
 */
class WatchWatchersStore {
  byChannel = $state<Record<string, string[]>>({});

  apply(channelId: string, userIds: string[]): void {
    this.byChannel = { ...this.byChannel, [channelId]: userIds };
  }

  watchersIn(channelId: string): string[] {
    return this.byChannel[channelId] ?? [];
  }

  clearChannel(channelId: string): void {
    if (this.byChannel[channelId] === undefined) return;
    const { [channelId]: _drop, ...rest } = this.byChannel;
    this.byChannel = rest;
  }

  clear(): void {
    this.byChannel = {};
  }
}

export const watchWatchers = new WatchWatchersStore();
```

- [ ] **Step 2: Handler registrieren**

In `web/src/lib/ws/handlers/watch.ts`:
```typescript
import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
import { watchChat } from '$lib/stores/watchChat.svelte';
import { watchWatchers } from '$lib/stores/watchWatchers.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('watch_state', (evt) => {
    watchPartyPresence.apply(evt.channel_id, evt.state);
    if (evt.state === null) {
      watchChat.clear(evt.channel_id);
      watchWatchers.clearChannel(evt.channel_id);
    }
  });
  registerWsHandler('watch_watchers', (evt) => {
    watchWatchers.apply(evt.channel_id, evt.user_ids);
  });
}
```

- [ ] **Step 3: Multi-Server-Reset**

In `web/src/lib/stores/multi-server-reset.ts`: dort wo `watchPartyPresence.clear()` o.ä. aufgerufen wird (`grep -n watch multi-server-reset.ts`), `watchWatchers.clear()` daneben ergänzen (Import oben hinzufügen).

- [ ] **Step 4: Typecheck**

Run: `cd web && pnpm check`
Expected: 0 Errors / 0 Warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/stores/watchWatchers.svelte.ts web/src/lib/ws/handlers/watch.ts \
        web/src/lib/stores/multi-server-reset.ts
git commit -m "feat(web/watch-party): watchWatchers store + watch_watchers handler"
```

---

## Phase 4 — Frontend: Tile-Integration + Controller-Refactor

### Task 9: Sync/Host-Controller aus dem Tile extrahieren

**Files:**
- Create: `web/src/lib/watch/partyController.svelte.ts`
- Modify: `web/src/lib/components/WatchPartyTile.svelte`

Ziel: `WatchPartyTile.svelte` (413 Z.) unter 250 Z. bringen, indem die Host/Viewer-Sync-Orchestrierung (beide `$effect`s, `syncHard`/`syncSoft`, `scheduleBroadcast`, Heartbeat-Verwaltung, `handleEvent`, `DriftCorrector`-Wiring, `SYNC_QUIET_MS`/`prevParty`/`viewerPaused`-State) in einen Controller wandert. Der Controller exponiert `onReady(handle)` / `onEvent(evt)` / `dispose()` und nimmt im Konstruktor `() => party`, `channelId`, `() => isHost`, `() => isPassive`.

- [ ] **Step 1: Controller schreiben**

Verschiebe die Logik 1:1 (Verhalten unverändert — die Sync-Engine wird NICHT angefasst). Skelett:
```typescript
// web/src/lib/watch/partyController.svelte.ts
/**
 * Watch-party host/viewer sync orchestration, extracted from WatchPartyTile so
 * the component stays under the 250-line cap. Behaviour is unchanged — this is
 * a pure move of the two $effects + broadcast debounce + heartbeat wiring.
 *
 * Construct one per mounted tile, call onReady/onEvent from the player, and
 * dispose() on destroy.
 */
import { gateway } from '$lib/ws/connection';
import {
  DriftCorrector, expectedPosition, startHeartbeat,
  type PlayerEvent, type PlayerHandle,
} from '$lib/watch/sync';
import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';

const SEEK_DETECTION_THRESHOLD_S = 2.0;
const SYNC_QUIET_MS = 2000;
const BROADCAST_DEBOUNCE_MS = 300;

export class PartyController {
  #player: PlayerHandle | undefined;
  #corrector = new DriftCorrector();
  #prevParty: WatchPartyState | undefined;
  #viewerPaused = false;
  #syncingUntil = 0;
  #stopHeartbeat: (() => void) | undefined;
  #pending: { action: 'play' | 'pause' | 'seek'; position: number } | undefined;
  #broadcastTimer: number | undefined;

  constructor(
    private channelId: string,
    private getParty: () => WatchPartyState,
    private getIsHost: () => boolean,
    private getIsPassive: () => boolean,
  ) {}

  onReady(handle: PlayerHandle): void {
    this.#player = handle;
  }

  /** Call from a $effect in the component so it re-runs on party changes. */
  syncViewer(): void {
    const p = this.#player;
    if (!p || this.getIsHost() || this.getIsPassive()) return;
    const cur = this.getParty();
    const prev = this.#prevParty;
    this.#prevParty = cur;
    if (!prev) {
      this.#viewerPaused = !cur.is_playing;
      this.#syncHard(p, cur);
      return;
    }
    const playingFlipped = prev.is_playing !== cur.is_playing;
    const expectedFromPrev = expectedPosition(prev, cur.updated_at);
    const positionJumped =
      Math.abs(cur.position - expectedFromPrev) > SEEK_DETECTION_THRESHOLD_S;
    if (playingFlipped || positionJumped) {
      this.#viewerPaused = !cur.is_playing;
      this.#syncHard(p, cur);
      return;
    }
    if (!this.#viewerPaused) this.#syncSoft(p, cur);
  }

  /** Call from a $effect: starts/stops the host heartbeat based on role. */
  syncHeartbeat(): void {
    const p = this.#player;
    if (!p || !this.getIsHost() || this.getIsPassive()) {
      this.#stopHeartbeat?.();
      this.#stopHeartbeat = undefined;
      return;
    }
    if (this.#stopHeartbeat) return;
    this.#stopHeartbeat = startHeartbeat(
      (pos) => gateway.sendWatchHeartbeat(this.channelId, pos), p,
    );
  }

  onEvent(e: PlayerEvent): void {
    if (this.getIsHost()) {
      if (this.getIsPassive()) return;
      if (e.type === 'play') this.#scheduleBroadcast('play', e.position);
      else if (e.type === 'pause') this.#scheduleBroadcast('pause', e.position);
      else if (e.type === 'seek') this.#scheduleBroadcast('seek', e.position);
      return;
    }
    if (this.getIsPassive()) return;
    const now = Date.now();
    if ((e.type === 'play' || e.type === 'pause') && now < this.#syncingUntil) return;
    if (e.type === 'pause') this.#viewerPaused = true;
    else if (e.type === 'play') {
      this.#viewerPaused = false;
      if (this.#player) this.#syncHard(this.#player, this.getParty());
    }
  }

  dispose(): void {
    this.#stopHeartbeat?.();
    if (this.#broadcastTimer !== undefined) clearTimeout(this.#broadcastTimer);
    if (this.#player) this.#corrector.dispose(this.#player);
    this.#player?.destroy();
  }

  #syncHard(p: PlayerHandle, s: WatchPartyState): void {
    const action = this.#corrector.applyHard(p, s);
    if (action !== 'none') this.#syncingUntil = Date.now() + SYNC_QUIET_MS;
  }
  #syncSoft(p: PlayerHandle, s: WatchPartyState): void {
    const action = this.#corrector.applySoft(p, s);
    if (action !== 'none') this.#syncingUntil = Date.now() + SYNC_QUIET_MS;
  }
  #scheduleBroadcast(action: 'play' | 'pause' | 'seek', position: number): void {
    this.#pending = { action, position };
    if (this.#broadcastTimer !== undefined) clearTimeout(this.#broadcastTimer);
    this.#broadcastTimer = window.setTimeout(() => {
      if (this.#pending) {
        gateway.sendWatchControl(this.channelId, this.#pending.action, this.#pending.position);
        this.#pending = undefined;
      }
      this.#broadcastTimer = undefined;
    }, BROADCAST_DEBOUNCE_MS);
  }
}
```
(Die DEV-`console.log`s aus dem Tile werden bei der Verschiebung NICHT mitgenommen — sie waren reines Debug. **Achtung:** der ungegatete `console.log('[wp] SEEK')` in `sync.ts:136` bleibt hier außen vor; das ist Quick-Win #7, separater Task.)

- [ ] **Step 2: Tile auf Controller umstellen**

In `WatchPartyTile.svelte` `<script>`: entferne die verschobenen Symbole (`player`-Sync-Logik, `syncHard`/`syncSoft`/`scheduleBroadcast`/`handleEvent`-Bodies, `corrector`, `prevParty`, `viewerPaused`, `syncingUntil`, die Konstanten). Behalte `let player = $state<PlayerHandle|undefined>()` für die Markup-Snippets nicht nötig — der Controller hält ihn. Stattdessen:
```typescript
  import { PartyController } from '$lib/watch/partyController.svelte';
  // ... existing imports (isHost/isPassive derived bleiben) ...

  const controller = new PartyController(
    channelId,
    () => party,
    () => isHost,
    () => isPassive,
  );
  function handleReady(handle: PlayerHandle): void { controller.onReady(handle); }
  function handleEvent(e: PlayerEvent): void { controller.onEvent(e); }

  $effect(() => { controller.syncViewer(); });
  $effect(() => { controller.syncHeartbeat(); });
  onDestroy(() => controller.dispose());
```
`isHost`/`isPassive`/`hostName`/`sourceLabel`/`stop()`/`handleDetach()`/`chatOpen` bleiben im Component. Die Markup-Snippets (`media`, `nameExtra`, `controlsExtra`, `chatPanel`) bleiben unverändert.

- [ ] **Step 3: Größe + Typecheck prüfen**

Run: `wc -l web/src/lib/components/WatchPartyTile.svelte && cd web && pnpm check`
Expected: Tile < 250 Z.; `pnpm check` 0/0.

- [ ] **Step 4: Build (Verhalten kompiliert)**

Run: `cd web && pnpm build`
Expected: erfolgreicher Build.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/watch/partyController.svelte.ts web/src/lib/components/WatchPartyTile.svelte
git commit -m "refactor(web/watch-party): extract PartyController, tile back under size cap"
```

---

### Task 10: Join/Leave-Lifecycle + Neuer-Host-Toast + Handoff-Picker

**Files:**
- Modify: `web/src/lib/components/WatchPartyTile.svelte`
- Modify: `web/messages/en.json` + `web/messages/de.json` (Paraglide-Quellen — exakten Pfad via `grep -rl watch_party_tile_host_label web/messages` bestätigen)

- [ ] **Step 1: Paraglide-Messages ergänzen**

In den Message-Quelldateien (z.B. `web/messages/{de,en}.json`) neue Keys hinzufügen — DE-Beispiel:
```json
"watch_party_tile_now_controlling": "Du steuerst jetzt die Watchparty",
"watch_party_tile_handoff_aria": "Kontrolle abgeben",
"watch_party_tile_handoff_auto": "Automatisch (Nächster)",
"watch_party_tile_handoff_to": "Übergeben an {name}"
```
EN analog. (Falls das Projekt eine andere i18n-Struktur nutzt — `grep -rn "watch_party_tile_host_label" web/` zeigt das Format; spiegle es exakt.)

- [ ] **Step 2: Join/Leave-Lifecycle im Tile**

In `WatchPartyTile.svelte` `<script>`, beim Controller-Setup ergänzen (onDestroy schon vorhanden):
```typescript
  import { onMount } from 'svelte';
  // ...
  onMount(() => {
    gateway.sendWatchJoin(channelId);
    return () => gateway.sendWatchLeave(channelId);
  });
```
(Beachte: `gateway` ist bereits importiert. `onMount`s Cleanup feuert bei Unmount — deckt Kachel-schließen, Channel-wechsel, Party-Ende.)

- [ ] **Step 3: Neuer-Host-Toast**

```typescript
  let prevHostId: string | undefined;
  $effect(() => {
    const h = party.host_user_id;
    const me = auth.user?.id;
    if (me && h === me && prevHostId !== undefined && prevHostId !== me) {
      toast.success(m.watch_party_tile_now_controlling());
    }
    prevHostId = h;
  });
```
(`toast` und `auth` sind bereits importiert; `m` ebenfalls.)

- [ ] **Step 4: Handoff-Picker im `controlsExtra`-Snippet**

Import `watchWatchers` + ein DropdownMenu aus `$lib/components/ui/`. Prüfe das vorhandene Muster: `grep -rl "DropdownMenu" web/src/lib/components | head`. Falls vorhanden, nutze bits-ui-DropdownMenu; sonst ein einfaches `<details>`/Popover. Im `controlsExtra`-Snippet, host-only, neben dem Stop-Button:
```svelte
  {#snippet controlsExtra()}
    {#if isHost}
      {@const others = watchWatchers.watchersIn(channelId).filter((id) => id !== auth.user?.id)}
      <div class="relative">
        <button
          type="button"
          onclick={() => (handoffOpen = !handoffOpen)}
          class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-black/75 md:p-1.5"
          aria-label={m.watch_party_tile_handoff_aria()}
          title={m.watch_party_tile_handoff_aria()}
          data-testid="watch-party-handoff"
        >
          <UsersIcon class="size-5 md:size-3.5" />
        </button>
        {#if handoffOpen}
          <div
            class="absolute bottom-full right-0 mb-2 min-w-44 rounded-lg bg-black/90 p-1 text-sm text-white shadow-lg backdrop-blur-sm"
            data-testid="watch-party-handoff-menu"
          >
            <button
              type="button"
              class="block w-full rounded px-3 py-2 text-left hover:bg-white/10 disabled:opacity-40"
              disabled={others.length === 0}
              onclick={() => { gateway.sendWatchHandoff(channelId); handoffOpen = false; }}
            >
              {m.watch_party_tile_handoff_auto()}
            </button>
            {#each others as uid (uid)}
              <button
                type="button"
                class="block w-full truncate rounded px-3 py-2 text-left hover:bg-white/10"
                onclick={() => { gateway.sendWatchHandoff(channelId, uid); handoffOpen = false; }}
              >
                {m.watch_party_tile_handoff_to({ name: userCache.displayName(uid) })}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button type="button" onclick={stop} ...existing stop button unchanged... />
    {/if}
  {/snippet}
```
Ergänze oben: `import UsersIcon from '@lucide/svelte/icons/users';`, `let handoffOpen = $state(false);`, und ein `$effect`, das die Namen der Watcher vorlädt:
```typescript
  $effect(() => {
    for (const uid of watchWatchers.watchersIn(channelId)) userCache.queue(uid);
  });
```

- [ ] **Step 5: Größe, Typecheck, Build**

Run: `wc -l web/src/lib/components/WatchPartyTile.svelte && cd web && pnpm check && pnpm build`
Expected: Tile möglichst ≤250 (wenn knapp drüber wegen Picker-Markup, ist das vertretbar — Snippets sind Markup; im Zweifel den Picker in eine `WatchPartyHandoffMenu.svelte`-Subkomponente auslagern). `pnpm check` 0/0, Build grün.

> Falls das Tile mit dem Picker-Markup >250 Z. wird: Picker in `web/src/lib/components/WatchPartyHandoffMenu.svelte` auslagern (Props: `channelId`, `others: string[]`), Tile bindet sie im `controlsExtra`-Snippet ein.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/components/WatchPartyTile.svelte web/messages/
git commit -m "feat(web/watch-party): join/leave lifecycle, new-host toast, handoff picker"
```

---

## Phase 5 — E2E + Verifikation

### Task 11: E2E-Test Auto-Promote + Handoff

**Files:**
- Modify: `web/tests/e2e/watch-party.spec.ts`

- [ ] **Step 1: Test ergänzen (WS-Ebene, wie die bestehenden Tests in der Datei)**

Schau dir die bestehenden Tests `watch_start via WS ...` (Z.261) an und spiegle deren WS-Helper. Neuer Test:
```typescript
  test('host disconnect promotes oldest remaining watcher', async () => {
    // alice hosts, bob joins (watch_join), alice's WS closes → REST watch-state
    // shows host_user_id === bob.
    // 1. alice: watch_start on the voice channel.
    // 2. bob: open WS, watch_join.
    // 3. alice: close WS.
    // 4. poll GET /guilds/{gid}/watch-state until host_user_id === bob (timeout 5s).
    // Use the same wsConnect/restGet helpers the file already defines.
  });

  test('explicit watch_handoff transfers control to a specific watcher', async () => {
    // alice hosts, bob joins; alice sends watch_handoff{target_user_id: bob}.
    // REST watch-state shows host_user_id === bob.
  });
```
Implementiere beide mit den vorhandenen Helfern der Spec-Datei (sie startet auth+chat als Child-Procs via globalSetup; nutze die existierenden `register`/`ws`-Utilities aus dem Datei-Kopf). Konkret: für „host disconnect" das `ws.close()` des Alice-Sockets, dann `expect.poll(() => restGet('/guilds/'+gid+'/watch-state'))` bis `host_user_id === bobId`.

- [ ] **Step 2: E2E laufen**

Run: `cd web && pnpm exec playwright test watch-party`
Expected: PASS (bestehende + 2 neue).

- [ ] **Step 3: Commit**

```bash
git add web/tests/e2e/watch-party.spec.ts
git commit -m "test(web/watch-party): e2e auto-promote on host disconnect + explicit handoff"
```

---

### Task 12: Voll-Verifikation + CLAUDE.md-Notiz

**Files:**
- Modify: `CLAUDE.md` (kurze Zeile im HQ/Watch-Bereich — die nicht-offensichtliche Watcher-Registry + Promotion)

- [ ] **Step 1: Komplette Backend-Suite**

Run: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`
Expected: PASS (alle Services).

- [ ] **Step 2: Frontend check + build + e2e**

Run: `cd web && pnpm check && pnpm build && pnpm exec playwright test`
Expected: 0/0, Build grün, E2E PASS.

- [ ] **Step 3: CLAUDE.md ergänzen**

Im Watch-Party-Abschnitt (bzw. HQ-Streaming-Nähe) eine Zeile ergänzen, z.B.:
> **Watch-Party Host-Handoff** (2026-06-02): Beim Host-Wegfall (Disconnect/Channel-Leave/Kachel-zu/`watch_handoff`) promotet der Server den ältesten verbliebenen *Watcher* zum Host; keiner mehr da → Party endet. Watcher-Menge = **in-process** im `ConnectionManager` (`_WatchRegistryMixin`, user-granular mit Socket-Refcount, kein Redis — einziger Schreiber ist das Gateway). Promotion in `routes/watch_handoff.py::promote_or_end` (unter `_lock`, Re-Check). Client: `WatchPartyTile`-Mount→`watch_join`/Unmount→`watch_leave`; `watch_watchers`-Broadcast speist den Handoff-Picker. **Achtung:** `cleanup_on_disconnect` war bis dahin toter Code (Party lingerte zur 6h-TTL) — jetzt verdrahtet.

- [ ] **Step 4: Manueller Sichttest (dokumentieren, nicht automatisiert)**

Notiere im Commit/PR: 3-Personen-Test — Host startet YouTube-Party, zwei Viewer öffnen die Kachel, Host schließt den Tab; Kontrolle wandert sichtbar (Host-Label wechselt, neuer Host bekommt Toast), Wiedergabe läuft ohne Sprung weiter. Picker: Host übergibt gezielt an Person 2.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): Watch-Party Host-Handoff — in-process watcher registry + promotion"
```

---

## Offene Punkte / bewusst nicht im Plan

- **Quick-Wins #4/#7/#8** (Heartbeat-Bound, `sync.ts:136` Prod-Log, HLS) — eigene, unabhängige Tasks; NICHT Teil dieses Plans.
- **Doppel-Heartbeat bei Multi-Tab-Host** (beide Tabs senden Heartbeats) — separater kleiner Punkt; die Registry löst nur den Host-*Identitäts*-Konflikt, nicht das doppelte Senden.
- **Cross-Pod-Watcher** — Single-Pod-Annahme der gesamten Watch-Schiene; bewusst nicht adressiert.
</content>
