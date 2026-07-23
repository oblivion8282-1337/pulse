"""WebSocket op handlers for watch parties.

Extracted from ``routes/ws.py`` to keep the dispatcher under the file-size
policy. Each handler is one async function called from the elif chain; they
all share the same shape (``websocket``, ``user``, ``msg``, plus per-op
extras) and own the full response — including error frames — themselves.

``hosted_parties`` is the per-connection set of ``(channel_id, party_id)`` this
socket has claimed by calling ``watch_start``; ``watched_parties`` is the set of
parties whose tile this socket has mounted. The dispatcher's finally block uses
the latter (via :func:`cleanup_on_disconnect`) to leave parties — promoting a
new host or ending the party when the host's last socket goes away. Several
parties can run in one voice channel, so every op carries a ``party_id``
alongside the ``channel_id`` (``watch_start`` mints a fresh one and acks it).

The session_factory parameter on :func:`handle_start` exists so the
dispatcher can pass *its* module-level ``SessionLocal`` symbol — which tests
monkeypatch — and keep the membership lookup honouring that override.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway import watchkeys
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE
from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.snowflake import next_id
from dcc_chat_gateway.watch_source import parse_source

log = logging.getLogger(__name__)

# Wider than typical WHEP/voice rooms — covers a 100h Twitch VOD.
_MAX_POSITION_S = 360_000

# Per-host heartbeat write debounce. Only needs to collapse genuine back-to-
# back bursts (reconnect double-send, UI race — those land within a few ms);
# it must stay comfortably below the host's ~1s heartbeat cadence (web
# `startHeartbeat`) so no regular beat is dropped even under timer throttling.
# 500ms gives a 500ms margin on the 1s interval while still killing bursts.
_HEARTBEAT_DEBOUNCE_MS = 500


def _channel_id(value: object) -> int | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _party_id(value: object) -> str | None:
    s = str(value or "").strip()
    return s if s.isdigit() else None


def _epoch(value: object) -> int | None:
    """Source-epoch a heartbeat/control was measured against. ``None`` when the
    client omits it (legacy client / pre-epoch party) → the freshness guard is
    skipped for that op rather than dropping everything."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _stale_epoch(state: dict, epoch: int | None) -> bool:
    """True when a control/heartbeat was measured against a source epoch the
    party has since moved past (advance/source_change bumped it). ``epoch is
    None`` (legacy client / pre-epoch party) never counts as stale — the
    freshness guard is skipped for that op rather than dropping everything."""
    return epoch is not None and int(state.get("source_epoch") or 0) != epoch


def _redis(websocket: WebSocket):
    return getattr(websocket.app.state, "redis", None)


def _manager(websocket: WebSocket):
    return getattr(websocket.app.state, "connection_manager", None)


async def _err(websocket: WebSocket, code: int, msg: str) -> None:
    await websocket.send_json({"op": "error", "code": code, "msg": msg})


async def _emit_mutate_error(websocket: WebSocket, result: object) -> None:
    """Shared error mapping for :func:`watchkeys.mutate_party` results, used by
    the host-only control ops (:func:`handle_control`, :func:`handle_source_change`).
    ``None`` = the party is gone, ``"NOT_HOST"`` = a handoff landed before the
    write committed. Any other result (success, a different error code) is the
    caller's to handle."""
    if result is None:
        await _err(websocket, 4016, "no active watch party")
    elif result == "NOT_HOST":
        await _err(websocket, 4015, "only the host can control")


async def handle_start(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
    hosted_parties: set[tuple[str, str]],
    watched_parties: set[tuple[str, str]],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    source_url = msg.get("source_url")
    if cid_int is None or not isinstance(source_url, str):
        await _err(websocket, 4012, "invalid watch_start payload")
        return
    source = parse_source(source_url)
    if source is None:
        await _err(websocket, 4013, "unsupported source")
        return
    cid = str(cid_int)
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
        perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
        # VIEW_CHANNEL gate: a member overwrite-excluded from this voice
        # channel must not host a party there. Same error as the membership
        # fail so a hidden channel's existence isn't confirmed.
        if not has_permission(perms, Permissions.VIEW_CHANNEL):
            await _err(websocket, 4004, "channel not accessible")
            return
        # Native URLs (direct https:// media links) additionally require
        # MANAGE_CHANNELS — mitigates DNS-rebinding SSRF by limiting who can
        # direct viewers' browsers at arbitrary hostnames.
        if source.get("type") == "native":
            if not has_permission(perms, Permissions.MANAGE_CHANNELS):
                await _err(websocket, 4003, "missing permission: MANAGE_CHANNELS")
                return
    redis = _redis(websocket)
    if redis is None:
        await _err(websocket, 4017, "watch service unavailable")
        return
    # Per-channel cap: several parties may coexist, but not unboundedly.
    if await watchkeys.count_parties(redis, cid) >= watchkeys.MAX_PARTIES_PER_CHANNEL:
        await _err(websocket, 4014, "too many watch parties in this channel")
        return
    pid = str(next_id())
    ts = watchkeys.now_ms()
    state = {
        "party_id": pid,
        "source": source,
        "host_user_id": str(user.id),
        "position": float(source.get("start_seconds") or 0),
        "is_playing": True,
        "updated_at": ts,
        "started_at": ts,
        # Bumped on every source swap (advance/source_change). Heartbeats and
        # controls echo the epoch they measured against so the server can drop
        # ones that belong to a since-replaced clip.
        "source_epoch": 0,
    }
    await watchkeys.write_party(redis, cid, state)
    hosted_parties.add((cid, pid))
    # Ack the freshly-minted party id back to the host so its client can open
    # the tile (the broadcast that write_party fires doesn't say "this one is
    # yours"). Sent before the watcher registration so the client has the id
    # before any watcher push references it.
    await websocket.send_json({"op": "watch_started", "channel_id": cid, "party_id": pid})
    # The host is implicitly a watcher (their tile is mounted) — add them to
    # the registry so a later host departure can promote, and tell viewers.
    mgr = _manager(websocket)
    if mgr is not None:
        await mgr.watch_join(cid, pid, str(user.id), websocket)
        watched_parties.add((cid, pid))
        await mgr.broadcast_watchers(cid, pid)


async def handle_join(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
    watched_parties: set[tuple[str, str]],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    if cid_int is None or pid is None:
        await _err(websocket, 4012, "channel_id and party_id required")
        return
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
        # VIEW_CHANNEL gate — without it an overwrite-excluded member could
        # join the watcher registry and receive party/watcher updates from a
        # channel they cannot see. Same error as the membership fail so a
        # hidden channel's existence isn't confirmed.
        perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
        if not has_permission(perms, Permissions.VIEW_CHANNEL):
            await _err(websocket, 4004, "channel not accessible")
            return
    cid = str(cid_int)
    redis = _redis(websocket)
    # Reject joins for a party that isn't active — keeps bogus party_ids from
    # leaking registry entries until the socket disconnects.
    if redis is not None and (await watchkeys.read_party(redis, cid, pid)) is None:
        await _err(websocket, 4016, "no active watch party")
        return
    mgr = _manager(websocket)
    if mgr is None:
        return
    await mgr.watch_join(cid, pid, str(user.id), websocket)
    watched_parties.add((cid, pid))
    await mgr.broadcast_watchers(cid, pid)


async def handle_leave(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    watched_parties: set[tuple[str, str]],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    if cid_int is None or pid is None:
        return
    cid = str(cid_int)
    # If this socket never mounted the party, there is nothing to remove from
    # the registry — skip the watch_leave / broadcast_watchers fan-out (the
    # latter is O(connections) with per-recipient permission checks and is
    # otherwise triggerable by leave-spam for a party the socket never joined).
    if (cid, pid) not in watched_parties:
        return
    watched_parties.discard((cid, pid))
    mgr = _manager(websocket)
    if mgr is None:
        return
    fully_left = await mgr.watch_leave(cid, pid, str(user.id), websocket)
    await mgr.broadcast_watchers(cid, pid)
    if fully_left:
        from dcc_chat_gateway.routes.watch_handoff import end_if_host

        await end_if_host(_redis(websocket), cid, pid, str(user.id))


async def handle_stop(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    hosted_parties: set[tuple[str, str]],
    watched_parties: set[tuple[str, str]],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    if cid_int is None or pid is None:
        await _err(websocket, 4012, "channel_id and party_id required")
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        return
    state = await watchkeys.read_party(redis, cid, pid)
    if state is None:
        # Idempotent stop.
        hosted_parties.discard((cid, pid))
        watched_parties.discard((cid, pid))
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can stop")
        return
    await watchkeys.delete_party(redis, cid, pid)
    hosted_parties.discard((cid, pid))
    watched_parties.discard((cid, pid))
    mgr = _manager(websocket)
    if mgr is not None:
        # Der Host war via handle_start als Watcher registriert. Da wir oben
        # (cid,pid) aus watched_parties verwerfen, räumt cleanup_on_disconnect
        # den Host-Socket NICHT mehr aus dem _watchers-Registry — ohne dieses
        # watch_leave bleiben der (geschlossene) Host-Socket und der
        # _watchers-Eintrag der Party dauerhaft im Speicher hängen.
        await mgr.watch_leave(cid, pid, str(user.id), websocket)
        mgr.cancel_host_end(cid, pid)


async def handle_control(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    action = msg.get("action")
    position = msg.get("position")
    if cid_int is None or pid is None or action not in ("play", "pause", "seek"):
        await _err(websocket, 4012, "invalid watch_control payload")
        return
    if not isinstance(position, (int, float)) or position < 0 or position > _MAX_POSITION_S:
        await _err(websocket, 4012, "invalid position")
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        return
    epoch = _epoch(msg.get("source_epoch"))

    def _apply(state: dict) -> str | None:
        # Re-check the host inside the WATCH — a handoff could have landed
        # between the client sending this and the write committing.
        if str(state.get("host_user_id")) != str(user.id):
            return "NOT_HOST"
        # Stale-source guard: this control was measured against a clip that has
        # since been replaced (advance/source_change bumped the epoch). Drop it
        # so its position/playback can't apply to the new clip.
        if _stale_epoch(state, epoch):
            return "STALE"
        state["position"] = float(position)
        state["is_playing"] = action != "pause"
        state["updated_at"] = watchkeys.now_ms()
        return None

    result = await watchkeys.mutate_party(redis, cid, pid, _apply)
    await _emit_mutate_error(websocket, result)


async def handle_source_change(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
) -> None:
    """Host swaps the party's video without restarting it — the party_id,
    watcher list, chat and handoff state all survive. Position resets to the
    new source's start point (``?t=`` or 0), playback resumes. Mirrors
    :func:`handle_start`'s source validation + the host check from
    :func:`handle_control`."""
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    source_url = msg.get("source_url")
    if cid_int is None or pid is None or not isinstance(source_url, str):
        await _err(websocket, 4012, "invalid watch_source_change payload")
        return
    source = parse_source(source_url)
    if source is None:
        await _err(websocket, 4013, "unsupported source")
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        await _err(websocket, 4017, "watch service unavailable")
        return
    # Cheap pre-check: gate the host + party existence before the (possibly
    # DB-hitting) native permission check below. The authoritative host re-check
    # happens inside the atomic write.
    state = await watchkeys.read_party(redis, cid, pid)
    if state is None:
        await _err(websocket, 4016, "no active watch party")
        return
    if str(state.get("host_user_id")) != str(user.id):
        await _err(websocket, 4015, "only the host can control")
        return
    # Native URLs (direct media links) need MANAGE_CHANNELS — re-checked here
    # so a host can't sidestep the SSRF gate by starting with a YouTube URL and
    # then switching the live party to an arbitrary native host. Same gate as
    # handle_start.
    if source.get("type") == "native":
        async with session_factory() as session:
            channel = await channel_membership(session, cid_int, user.id)
            if channel is None or channel.type != CHANNEL_TYPE_VOICE:
                await _err(websocket, 4004, "channel not accessible")
                return
            perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
            if not has_permission(perms, Permissions.MANAGE_CHANNELS):
                await _err(websocket, 4003, "missing permission: MANAGE_CHANNELS")
                return

    def _apply(st: dict) -> str | None:
        if str(st.get("host_user_id")) != str(user.id):
            return "NOT_HOST"
        st["source"] = source
        st["position"] = float(source.get("start_seconds") or 0)
        st["is_playing"] = True
        st["updated_at"] = watchkeys.now_ms()
        # New source → new epoch (see handle_start / queue_advance): stale
        # heartbeats/controls for the old clip get dropped by their guard.
        st["source_epoch"] = int(st.get("source_epoch") or 0) + 1
        return None

    result = await watchkeys.mutate_party(redis, cid, pid, _apply)
    await _emit_mutate_error(websocket, result)


async def handle_heartbeat(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    # Heartbeats are best-effort. Drop silently on malformed input rather than
    # spamming error frames — the host emits one every ~3s during playback.
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    position = msg.get("position")
    # Same position bounds as handle_control — an out-of-range heartbeat must
    # not be able to set a position the control op would reject.
    if (
        cid_int is None
        or pid is None
        or not isinstance(position, (int, float))
        or position < 0
        or position > _MAX_POSITION_S
    ):
        return
    cid = str(cid_int)
    redis = _redis(websocket)
    if redis is None:
        return
    ts = watchkeys.now_ms()
    epoch = _epoch(msg.get("source_epoch"))

    def _apply(state: dict) -> str | None:
        # Host + debounce + epoch evaluated against the state as seen inside the
        # WATCH, so a heartbeat can't resurrect a queue item by writing back a
        # stale snapshot (lost update). Best-effort: any abort code is ignored.
        if str(state.get("host_user_id")) != str(user.id):
            return "SKIP"
        # Stale-source guard: a heartbeat measured against the previous clip
        # (its position belongs to that video) must not stamp itself onto the
        # freshly-reset new clip — the "second clip starts in the middle" bug.
        if _stale_epoch(state, epoch):
            return "SKIP"
        if ts - int(state.get("updated_at") or 0) < _HEARTBEAT_DEBOUNCE_MS:
            return "SKIP"
        state["position"] = float(position)
        state["updated_at"] = ts
        return None

    await watchkeys.mutate_party(redis, cid, pid, _apply)



async def cleanup_on_disconnect(
    websocket: WebSocket,
    user: AuthenticatedUser,
    manager,
    watched_parties: set[tuple[str, str]],
) -> None:
    """Socket closing: leave every party this socket watched, promoting a new
    host (or ending the party) wherever this socket's user was the host and is
    now fully gone. Runs BEFORE ``manager.remove_socket`` so the registry's
    socket set is still accurate."""
    if not watched_parties:
        return
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    redis = _redis(websocket)
    for cid, pid in list(watched_parties):
        try:
            fully_left = await manager.watch_leave(cid, pid, str(user.id), websocket)
            await manager.broadcast_watchers(cid, pid)
            if fully_left:
                await end_or_grace_if_host(redis, manager, cid, pid, str(user.id))
        except Exception:
            log.exception(
                "watch-party disconnect cleanup failed for channel %s party %s", cid, pid
            )
