# Watch-Party Host-sticky — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Watch-Party-Host behält die Party, bis er sie explizit abgibt; Auto-Handoff bei Host-Wegfall wird durch „Party endet" ersetzt — sofort bei Channel-Wechsel/Kachel-Unmount, nach 30 s Schonfrist bei einem echten WS-Disconnect.

**Architecture:** Backend-only (chat-gateway). Die Promotion-Logik (`promote_or_end`) bleibt erhalten, wird aber nur noch vom *expliziten* `watch_handoff` genutzt. Die Departure-Pfade rufen stattdessen neue Helfer: `end_if_host` (sofortiges Ende) bzw. `end_or_grace_if_host` (Schonfrist-Timer). Der Schonfrist-Timer ist ein in-process `asyncio.Task` in der Watcher-Registry (single-pod, kein Redis), der den Party-State nach Ablauf löscht — sofern der Host nicht via `watch_join` zurückkehrt (Timer-Abbruch).

**Tech Stack:** Python 3.14, FastAPI, redis.asyncio, pytest + pytest-asyncio (`REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest`), Playwright (E2E).

**Spec:** `docs/specs/2026-06-02-watch-party-host-sticky-design.md`

---

## File Structure

- **Modify** `services/chat-gateway/src/dcc_chat_gateway/watchkeys.py` — neue Konstante `WATCH_HOST_GRACE_S` (env-konfigurierbar, default 30).
- **Modify** `services/chat-gateway/src/dcc_chat_gateway/watch_registry.py` — Schonfrist-Timer-Maschinerie (`schedule_host_end`, `cancel_host_end`, `_host_end_after_grace`), `_init_watch_registry` erweitern, `watch_join` bricht Timer bei Host-Rückkehr ab.
- **Modify** `services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py` — neue Funktionen `end_if_host` + `end_or_grace_if_host`; `promote_or_end` unverändert (nur noch Handoff-Pfad).
- **Modify** `services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py` — Call-Sites: `handle_leave`→`end_if_host`, `cleanup_on_disconnect`→`end_or_grace_if_host`, `handle_stop`→`cancel_host_end`.
- **Modify** `services/chat-gateway/tests/test_watch.py` — Tests umschreiben + neue Tests.
- **Modify** `web/tests/e2e/_globalSetup.ts` — `WATCH_HOST_GRACE_S='1'` für schnelle E2E.
- **Modify** `web/tests/e2e/watch-party.spec.ts` — Disconnect-Test auf „endet (keine Promotion)" umschreiben, redundanten Solo-End-Test entfernen.
- **Modify** `CLAUDE.md` — Abschnitt „Watch-Party Host-Handoff" aktualisieren.

---

## Task 1: Grace-Konstante in watchkeys.py

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/watchkeys.py`

- [ ] **Step 1: `import os` ergänzen**

In `watchkeys.py` steht oben `import json` / `import time`. Ergänze `import os`:

```python
import json
import os
import time
```

- [ ] **Step 2: Konstante hinzufügen**

Direkt nach `WATCH_TTL_SECONDS = 6 * 3600` (Zeile ~33):

```python
WATCH_TTL_SECONDS = 6 * 3600

# Grace window after a host's WS drops before the party ends. Covers brief
# blips / sleep so the host keeps the party across a reconnect. Env-overridable
# so the E2E suite can run it short. Read at call time (see schedule_host_end)
# so tests can monkeypatch this module attribute.
WATCH_HOST_GRACE_S = float(os.environ.get("WATCH_HOST_GRACE_S", "30"))
```

- [ ] **Step 3: Verify import + value**

Run: `cd services/chat-gateway && uv run python -c "from dcc_chat_gateway import watchkeys; print(watchkeys.WATCH_HOST_GRACE_S)"`
Expected: `30.0`

- [ ] **Step 4: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/watchkeys.py
git commit -m "feat(watch-party): WATCH_HOST_GRACE_S constant (env-overridable, default 30s)"
```

---

## Task 2: Schonfrist-Timer in der Watcher-Registry

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/watch_registry.py`
- Test: `services/chat-gateway/tests/test_watch.py`

- [ ] **Step 1: Failing tests schreiben**

Am Ende von `test_watch.py` anhängen (nach `test_handoff_by_non_host_errors_4015`). `asyncio`, `json`, `random`, `watchkeys`, `_reg_mgr`, `_state` sind dort bereits importiert/definiert:

```python
@pytest.mark.asyncio
async def test_grace_expires_ends_party(redis, monkeypatch):
    """Host gone, no reconnect within the grace → party ends."""
    monkeypatch.setattr(watchkeys, "WATCH_HOST_GRACE_S", 0)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)
    try:
        mgr.schedule_host_end(redis, cid, "111")
        await mgr._watch_end_timers[cid][1]  # await the scheduled task
        assert await redis.get(f"watch:channel-{cid}") is None
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_host_reconnect_within_grace_cancels_end(redis):
    """Host rejoins as a watcher before the grace expires → timer cancelled,
    party intact."""
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)
    try:
        mgr.schedule_host_end(redis, cid, "111")  # default 30s grace
        assert cid in mgr._watch_end_timers
        await mgr.watch_join(cid, "111", object())  # host returns
        assert cid not in mgr._watch_end_timers     # timer cancelled
        await asyncio.sleep(0)                       # let cancellation settle
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "111"          # party still there
    finally:
        await redis.delete(f"watch:channel-{cid}")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py::test_grace_expires_ends_party tests/test_watch.py::test_host_reconnect_within_grace_cancels_end -v`
Expected: FAIL — `AttributeError: '_Mgr' object has no attribute 'schedule_host_end'`

- [ ] **Step 3: `import asyncio` + `watchkeys` in watch_registry.py ergänzen**

Oben in `watch_registry.py` steht `import time` und `from dataclasses import ...` und `from typing import Any`. Ergänze:

```python
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from dcc_chat_gateway import watchkeys
```

(`watchkeys` importiert nur `dcc_shared.events` — kein Zyklus mit `watch_registry`.)

- [ ] **Step 4: `_init_watch_registry` erweitern + Klassen-Annotation**

Ändere die Annotation + Init:

```python
class _WatchRegistryMixin:
    """..."""

    _watchers: dict[str, dict[str, _WatcherEntry]]
    _watch_end_timers: dict[str, tuple[str, "asyncio.Task[Any]"]]

    def _init_watch_registry(self) -> None:
        self._watchers = {}
        self._watch_end_timers = {}
```

- [ ] **Step 5: Timer-Methoden hinzufügen**

Direkt nach `next_host` (vor `watchers`) einfügen:

```python
    def schedule_host_end(
        self, redis, channel_id: str, host_uid: str, *, delay: float | None = None
    ) -> None:
        """Host fully left via a connection drop. Schedule the party to end
        after a grace window unless the host reconnects (rejoins as a watcher)
        in time. Idempotent per channel — replaces any pending timer."""
        if delay is None:
            delay = watchkeys.WATCH_HOST_GRACE_S
        self.cancel_host_end(channel_id)
        task = asyncio.create_task(
            self._host_end_after_grace(redis, channel_id, str(host_uid), delay)
        )
        self._watch_end_timers[channel_id] = (str(host_uid), task)

    def cancel_host_end(self, channel_id: str, *, host_uid: str | None = None) -> None:
        """Cancel a pending grace timer. With ``host_uid`` only cancel when the
        timer is for that host (used on the host's own reconnect)."""
        entry = self._watch_end_timers.get(channel_id)
        if entry is None:
            return
        if host_uid is not None and entry[0] != str(host_uid):
            return
        entry[1].cancel()
        self._watch_end_timers.pop(channel_id, None)

    async def _host_end_after_grace(
        self, redis, channel_id: str, host_uid: str, delay: float
    ) -> None:
        try:
            await asyncio.sleep(delay)
            async with self._lock:
                chan = self._watchers.get(channel_id)
                if chan and host_uid in chan:
                    return  # host reconnected within the grace window
            state = await watchkeys.read_state(redis, channel_id)
            if state is None or str(state.get("host_user_id")) != host_uid:
                return  # already ended or host changed (explicit handoff)
            await watchkeys.delete_state(redis, channel_id)
        finally:
            entry = self._watch_end_timers.get(channel_id)
            if entry is not None and entry[1] is asyncio.current_task():
                self._watch_end_timers.pop(channel_id, None)
```

- [ ] **Step 6: `watch_join` bricht Timer bei Host-Rückkehr ab**

In `watch_join`, nach dem `async with self._lock:`-Block, eine Zeile ergänzen:

```python
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
        # Host returned within the grace window → cancel the pending party-end.
        self.cancel_host_end(channel_id, host_uid=user_id)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py::test_grace_expires_ends_party tests/test_watch.py::test_host_reconnect_within_grace_cancels_end -v`
Expected: PASS (2 passed)

- [ ] **Step 8: Registry-Tests laufen lassen (keine Regression)**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch_registry.py -q`
Expected: PASS (all)

- [ ] **Step 9: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/watch_registry.py services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): grace-period timer in watcher registry (schedule/cancel/expire)"
```

---

## Task 3: Departure-Helfer in watch_handoff.py

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py`
- Test: `services/chat-gateway/tests/test_watch.py`

- [ ] **Step 1: Failing tests schreiben**

Am Ende von `test_watch.py` anhängen:

```python
@pytest.mark.asyncio
async def test_end_if_host_deletes_for_host(redis):
    from dcc_chat_gateway.routes.watch_handoff import end_if_host

    cid = str(random.randint(10**18, 10**19 - 1))
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)
    await end_if_host(redis, cid, "111")
    assert await redis.get(f"watch:channel-{cid}") is None


@pytest.mark.asyncio
async def test_end_if_host_noop_for_viewer(redis):
    from dcc_chat_gateway.routes.watch_handoff import end_if_host

    cid = str(random.randint(10**18, 10**19 - 1))
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)
    try:
        await end_if_host(redis, cid, "222")  # viewer leaving
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_end_or_grace_if_host_schedules_for_host(redis, monkeypatch):
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    monkeypatch.setattr(watchkeys, "WATCH_HOST_GRACE_S", 0)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)
    try:
        await end_or_grace_if_host(redis, mgr, cid, "111")
        await mgr._watch_end_timers[cid][1]
        assert await redis.get(f"watch:channel-{cid}") is None
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_end_or_grace_if_host_noop_for_viewer(redis):
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)
    try:
        await end_or_grace_if_host(redis, mgr, cid, "222")  # viewer
        assert cid not in mgr._watch_end_timers
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py -k "end_if_host or end_or_grace" -v`
Expected: FAIL — `ImportError: cannot import name 'end_if_host'`

- [ ] **Step 3: Funktionen implementieren**

In `watch_handoff.py`, direkt **vor** `async def promote_or_end(...)` einfügen:

```python
async def end_if_host(redis, channel_id: str, departing_uid: str) -> None:
    """Host left deliberately (tile unmount / channel switch) → end the party
    now. No-op if the departing user is a viewer."""
    if redis is None:
        return
    state = await watchkeys.read_state(redis, channel_id)
    if state is None or str(state.get("host_user_id")) != str(departing_uid):
        return
    await watchkeys.delete_state(redis, channel_id)


async def end_or_grace_if_host(redis, manager, channel_id: str, departing_uid: str) -> None:
    """Host's WS dropped → start the grace timer (party ends after
    WATCH_HOST_GRACE_S unless the host reconnects). No-op for a viewer."""
    if redis is None:
        return
    state = await watchkeys.read_state(redis, channel_id)
    if state is None or str(state.get("host_user_id")) != str(departing_uid):
        return
    manager.schedule_host_end(redis, channel_id, str(departing_uid))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py -k "end_if_host or end_or_grace" -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Bestehende promote/handoff-Tests prüfen (unverändert grün)**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py -k "promote_or_end or handoff" -q`
Expected: PASS (all — `promote_or_end` ist unverändert)

- [ ] **Step 6: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/watch_handoff.py services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): end_if_host + end_or_grace_if_host departure helpers"
```

---

## Task 4: Departure-Pfade in ws_watch.py umverdrahten

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py`
- Test: `services/chat-gateway/tests/test_watch.py`

- [ ] **Step 1: Bestehende Disconnect-Tests umschreiben + neue handle_leave-Tests**

In `test_watch.py`:

**(a)** `test_cleanup_on_disconnect_promotes_to_remaining_watcher` (≈Zeile 643) **komplett ersetzen** durch:

```python
@pytest.mark.asyncio
async def test_cleanup_on_disconnect_schedules_end_not_promote(redis, monkeypatch):
    """Host socket closes with another watcher present → grace timer ends the
    party; it is NOT promoted to the remaining watcher."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    monkeypatch.setattr(watchkeys, "WATCH_HOST_GRACE_S", 0)
    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    host_ws = _ErrWS(redis, mgr)
    await mgr.watch_join(cid, str(uid), host_ws, now_ms=1000)
    await mgr.watch_join(cid, "999", object(), now_ms=2000)
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host=str(uid))), ex=600)

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        await ws_watch.cleanup_on_disconnect(host_ws, user, mgr, {cid})
        await mgr._watch_end_timers[cid][1]  # await the scheduled end
        assert await redis.get(f"watch:channel-{cid}") is None
    finally:
        await redis.delete(f"watch:channel-{cid}")
```

**(b)** `test_cleanup_on_disconnect_ends_when_solo` (≈Zeile 666) **ersetzen** durch (Ende läuft jetzt über die Schonfrist):

```python
@pytest.mark.asyncio
async def test_cleanup_on_disconnect_ends_when_solo(redis, monkeypatch):
    """Host socket closes with no other watcher → party ends after grace."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    monkeypatch.setattr(watchkeys, "WATCH_HOST_GRACE_S", 0)
    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    host_ws = _ErrWS(redis, mgr)
    await mgr.watch_join(cid, str(uid), host_ws, now_ms=1000)
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host=str(uid))), ex=600)

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    await ws_watch.cleanup_on_disconnect(host_ws, user, mgr, {cid})
    await mgr._watch_end_timers[cid][1]
    assert await redis.get(f"watch:channel-{cid}") is None
```

**(c)** `test_cleanup_on_disconnect_multitab_keeps_party` bleibt **unverändert** (kein fully_left → kein Timer). Optional eine Assertion ergänzen direkt vor dem `finally`: `assert cid not in mgr._watch_end_timers`.

**(d)** Zwei **neue** Tests am Ende von `test_watch.py` anhängen:

```python
@pytest.mark.asyncio
async def test_handle_leave_host_ends_immediately(redis):
    """Host watch_leave (channel switch / tile close) ends the party at once —
    no grace timer, no promotion to the other watcher."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    host_ws = _ErrWS(redis, mgr)
    await mgr.watch_join(cid, str(uid), host_ws, now_ms=1000)
    await mgr.watch_join(cid, "999", object(), now_ms=2000)
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host=str(uid))), ex=600)

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        await ws_watch.handle_leave(host_ws, user, {"channel_id": cid}, watched_parties={cid})
        assert cid not in mgr._watch_end_timers                  # no grace timer
        assert await redis.get(f"watch:channel-{cid}") is None   # ended now
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handle_leave_viewer_keeps_party(redis):
    """A viewer leaving via watch_leave does not touch the party."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    host_ws = _ErrWS(redis, mgr)
    viewer_ws = _ErrWS(redis, mgr)
    await mgr.watch_join(cid, "111", host_ws, now_ms=1000)
    await mgr.watch_join(cid, "222", viewer_ws, now_ms=2000)
    await redis.set(f"watch:channel-{cid}", json.dumps(_state(host="111")), ex=600)

    user = AuthenticatedUser(id=222, username="u222", is_admin=False, payload={})
    try:
        await ws_watch.handle_leave(viewer_ws, user, {"channel_id": cid}, watched_parties={cid})
        new = json.loads(await redis.get(f"watch:channel-{cid}"))
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")
```

- [ ] **Step 2: Run tests to verify the rewritten/new ones fail**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py -k "schedules_end_not_promote or handle_leave_host_ends or handle_leave_viewer" -v`
Expected: FAIL — `handle_leave` ruft noch `promote_or_end` (kein Timer / promotet "999"); `schedules_end_not_promote` findet keinen Timer.

- [ ] **Step 3: `handle_leave` umverdrahten**

In `ws_watch.py::handle_leave`, den `if fully_left:`-Block ersetzen:

```python
    fully_left = await mgr.watch_leave(cid, str(user.id), websocket)
    await mgr.broadcast_watchers(cid)
    if fully_left:
        from dcc_chat_gateway.routes.watch_handoff import end_if_host

        await end_if_host(_redis(websocket), cid, str(user.id))
```

- [ ] **Step 4: `cleanup_on_disconnect` umverdrahten**

In `ws_watch.py::cleanup_on_disconnect`, den Import + Aufruf ersetzen:

```python
    if not watched_parties:
        return
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    redis = _redis(websocket)
    for cid in list(watched_parties):
        try:
            fully_left = await manager.watch_leave(cid, str(user.id), websocket)
            await manager.broadcast_watchers(cid)
            if fully_left:
                await end_or_grace_if_host(redis, manager, cid, str(user.id))
        except Exception:
            log.exception("watch-party disconnect cleanup failed for channel %s", cid)
```

- [ ] **Step 5: `handle_stop` bricht eine ggf. laufende Schonfrist ab**

In `ws_watch.py::handle_stop`, nach `hosted_parties.discard(cid)` (am Ende) ergänzen:

```python
    await watchkeys.delete_state(redis, cid)
    hosted_parties.discard(cid)
    mgr = _manager(websocket)
    if mgr is not None:
        mgr.cancel_host_end(cid)
```

- [ ] **Step 6: Run the targeted tests to verify they pass**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py -k "cleanup_on_disconnect or handle_leave_host_ends or handle_leave_viewer" -v`
Expected: PASS (all — incl. `multitab_keeps_party`, `ends_when_solo`, `schedules_end_not_promote`)

- [ ] **Step 7: Volle Watch-Test-Datei laufen lassen**

Run: `cd services/chat-gateway && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest tests/test_watch.py tests/test_watch_registry.py -q`
Expected: PASS (all)

- [ ] **Step 8: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/ws_watch.py services/chat-gateway/tests/test_watch.py
git commit -m "feat(watch-party): host-sticky — leave ends now, disconnect uses 30s grace"
```

---

## Task 5: E2E anpassen

**Files:**
- Modify: `web/tests/e2e/_globalSetup.ts`
- Modify: `web/tests/e2e/watch-party.spec.ts`

- [ ] **Step 1: Grace für E2E auf 1 s setzen**

In `web/tests/e2e/_globalSetup.ts`, im `baseEnv`-Objekt (nach `RATE_LIMIT_LOGIN: '1000/minute'`), ergänzen:

```javascript
    RATE_LIMIT_REGISTER: '1000/minute',
    RATE_LIMIT_LOGIN: '1000/minute',
    // Host-disconnect grace: 30s in prod, 1s in E2E so the "party ends after a
    // host disconnect" assertion resolves fast.
    WATCH_HOST_GRACE_S: '1'
```

- [ ] **Step 2: Disconnect-Test umschreiben + redundanten Solo-Test entfernen**

In `web/tests/e2e/watch-party.spec.ts`, den Test `test('host disconnect promotes the oldest remaining watcher', ...)` (≈Zeile 403) **ersetzen** durch:

```javascript
  test('host disconnect ends the party after the grace window (no promotion)', async () => {
    // After the handoff Bob is host (via 'watch'); Alice is still a watcher
    // (via 'host'). Closing Bob's socket starts the 1s grace timer; with no
    // reconnect the party ENDS — it is NOT promoted to Alice.
    await wsClose(bobPage, 'watch');
    await expect
      .poll(async () =>
        (await getGuildWatchState(alicePage, guildId)).find(
          (e) => e.channel_id === voiceChannelId
        )
      )
      .toBeFalsy();
  });
```

Und den darauffolgenden Test `test('closing the last watcher ends the party', ...)` (≈Zeile 417, bis zur schließenden `});` des Tests) **vollständig entfernen** — er ist jetzt redundant (die Party ist nach dem Disconnect-Test bereits beendet, und das Solo-Ende deckt pytest ab).

- [ ] **Step 3: Watch-Party-E2E laufen lassen**

Run: `cd web && pnpm exec playwright test watch-party`
Expected: PASS (alle verbliebenen Tests im File, inkl. `explicit watch_handoff transfers host` + der neue Disconnect-Test)

- [ ] **Step 4: Commit**

```bash
git add web/tests/e2e/_globalSetup.ts web/tests/e2e/watch-party.spec.ts
git commit -m "test(watch-party): E2E — host disconnect ends party (1s grace), drop redundant solo test"
```

---

## Task 6: Doku + Voll-Verifikation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md-Abschnitt aktualisieren**

In `CLAUDE.md` den ersten Satz des Abschnitts **„Watch-Party Host-Handoff"** ersetzen. Suche den Block, der mit
`**Watch-Party Host-Handoff** (2026-06-02): Beim Host-Wegfall (Disconnect / Channel-Leave / Kachel-zu / `watch_handoff`) promotet der Server den **ältesten verbliebenen Watcher** zum Host;`
beginnt, und ersetze den einleitenden Teil (bis `… kein Redis: einziger Schreiber ist das Gateway; Cross-Pod bewusst nicht).`) sinngemäß durch:

```
**Watch-Party Host-sticky** (2026-06-02, geändert): Der Host **behält** die Party,
bis er sie *explizit* abgibt (`watch_handoff`). **Kein Auto-Handoff mehr** bei
Host-Wegfall. Stattdessen: Channel-Wechsel / Kachel-Unmount (`watch_leave`,
host) **beendet sofort** (`end_if_host`); ein echter WS-Disconnect
(`cleanup_on_disconnect`, host) startet eine **30 s Schonfrist** gegen Blips
(`end_or_grace_if_host` → `_WatchRegistryMixin.schedule_host_end`, in-process
`asyncio.Task`) — kommt der Host via `watch_join` zurück, wird der Timer
abgebrochen, sonst endet die Party. `WATCH_HOST_GRACE_S` (env, default 30;
E2E=1). Zuschauer-Abgang ändert nichts. `promote_or_end` existiert weiter, wird
aber **nur noch** vom expliziten `handle_handoff` genutzt (Target- bzw.
next-oldest-Pfad). Watcher-Menge = **in-process** im `ConnectionManager`
(`watch_registry._WatchRegistryMixin`, user-granular mit Socket-Refcount →
Multi-Tab-korrekt, kein Redis: einziger Schreiber ist das Gateway; Cross-Pod
bewusst nicht). **UX-Hinweis:** Das PARTY-Badge zum Öffnen hängt an der
Host-Voice-Präsenz — bei Disconnect ist es während der Schonfrist weg; wer schon
zuschaut, schaut nahtlos weiter, neue Zuschauer haben in dem Fenster keinen
Einstieg (bewusst akzeptiert).
```

(Die nachfolgenden Zeilen des Abschnitts — `Ops:`, `watch_watchers`-Broadcast, partyController, `PULSE_INSTANCE_MODE=cloud`-Hinweis — bleiben unverändert. Lies den Abschnitt vor der Bearbeitung, um die exakte Grenze zu treffen.)

- [ ] **Step 2: Volle Backend-Tests**

Run: `cd /home/michael/Dokumente/Pulse && REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`
Expected: PASS (keine Regression über alle Services)

- [ ] **Step 3: Frontend-Checks (kein FE-Code geändert, aber Policy)**

Run: `cd web && pnpm check && pnpm build`
Expected: 0 Errors / 0 Warnings

- [ ] **Step 4: Volle E2E**

Run: `cd web && pnpm exec playwright test`
Expected: PASS (alle Specs)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(watch-party): CLAUDE.md — Host-sticky (kein Auto-Handoff, 30s Disconnect-Schonfrist)"
```

---

## Verifikations-Checkliste (Spec-Abgleich)

- [x] Kein Auto-Promotion auf Departure-Pfaden → Task 4 (handle_leave/cleanup verdrahtet auf end_*).
- [x] `promote_or_end` nur noch für expliziten Handoff → unverändert (Task 3 Step 5 prüft).
- [x] Channel-Wechsel/Kachel-Unmount (host) endet sofort → `end_if_host` (Task 3/4).
- [x] Disconnect (host) 30 s Schonfrist → `end_or_grace_if_host` + Timer (Task 2/3/4).
- [x] Host-Rückkehr <30 s bricht Timer ab → `watch_join`→`cancel_host_end` (Task 2).
- [x] Zuschauer-Abgang = noop → Task 3 (noop-Tests) + Task 4 (viewer-keeps-party).
- [x] Multi-Tab korrekt (kein Timer wenn Sibling-Socket bleibt) → Task 4(c).
- [x] Env-konfigurierbare Schonfrist (Tests) → Task 1 + Task 5.
- [x] UX-Verhalten dokumentiert → Task 6 (CLAUDE.md) + Spec.
- [x] E2E auf neues Verhalten angepasst → Task 5.
