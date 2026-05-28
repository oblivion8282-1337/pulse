"""Watch-Party tests.

Four sections:
  1. ``watch_source.parse_source`` — pure unit tests, no fixtures.
  2. ``GET /guilds/{id}/watch-state`` — REST re-sync endpoint.
  3. WebSocket ops — happy + negative paths against ``ws_app`` via TestClient
     (same harness as test_streaming::stream:events).
  4. Watch-Chat REST endpoints — ``POST`` + ``GET /channels/{id}/watch-party/chat``.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time

import pytest
import pytest_asyncio
from dcc_chat_gateway import watchkeys
from dcc_chat_gateway.watch_source import parse_source
from redis.asyncio import Redis
from starlette.testclient import TestClient
from .conftest import receive_skipping, skip_init_frames

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


# =============================================================================
# 1. parse_source
# =============================================================================


def test_parse_youtu_be_short():
    s = parse_source("https://youtu.be/abc12345678")
    assert s == {"type": "youtube", "embed_id": "abc12345678"}


def test_parse_youtube_watch_v():
    s = parse_source("https://www.youtube.com/watch?v=abc12345678")
    assert s == {"type": "youtube", "embed_id": "abc12345678"}


def test_parse_youtube_embed_and_shorts():
    a = parse_source("https://www.youtube.com/embed/abc12345678")
    b = parse_source("https://youtube.com/shorts/abc12345678")
    assert a == b == {"type": "youtube", "embed_id": "abc12345678"}


def test_parse_youtube_nocookie():
    s = parse_source("https://www.youtube-nocookie.com/embed/abc12345678")
    assert s == {"type": "youtube", "embed_id": "abc12345678"}


def test_parse_youtube_start_seconds():
    s = parse_source("https://youtu.be/abc12345678?t=42")
    assert s == {"type": "youtube", "embed_id": "abc12345678", "start_seconds": 42}


def test_parse_youtube_start_clock():
    s = parse_source("https://www.youtube.com/watch?v=abc12345678&t=1h2m3s")
    assert s == {"type": "youtube", "embed_id": "abc12345678", "start_seconds": 3723}


def test_parse_twitch_vod():
    s = parse_source("https://www.twitch.tv/videos/1234567890")
    assert s == {"type": "twitch", "embed_id": "1234567890"}


def test_parse_twitch_live_channel():
    s = parse_source("https://www.twitch.tv/xqc")
    assert s == {"type": "twitch_live", "channel": "xqc"}
    # Bare-host variant + numeric/underscore channel names.
    assert parse_source("https://twitch.tv/some_streamer") == {
        "type": "twitch_live",
        "channel": "some_streamer",
    }
    assert parse_source("https://m.twitch.tv/Lirik") == {
        "type": "twitch_live",
        "channel": "Lirik",
    }


def test_parse_twitch_rejects_reserved_and_multipath():
    # Reserved keywords must NOT become channel embeds.
    for path in ("directory", "p", "user", "login", "settings", "team"):
        assert parse_source(f"https://www.twitch.tv/{path}") is None
    # Multi-segment paths (clips, /v/, /clip/) aren't supported v1.
    assert parse_source("https://twitch.tv/some_streamer/clip/foo") is None
    assert parse_source("https://www.twitch.tv/xqc/v/1234") is None
    # Invalid channel-name characters.
    assert parse_source("https://www.twitch.tv/has-a-dash") is None
    assert parse_source("https://www.twitch.tv/has.a.dot") is None
    # Way too long.
    assert parse_source("https://www.twitch.tv/" + "a" * 26) is None


def test_parse_native_mp4_webm_m3u8():
    for url in (
        "https://example.com/movie.mp4",
        "https://cdn.example.com/path/to/clip.webm",
        "https://example.com/stream/index.m3u8",
    ):
        assert parse_source(url) == {"type": "native", "url": url}


def test_parse_rejects_http():
    assert parse_source("http://example.com/movie.mp4") is None


def test_parse_rejects_unknown_host():
    # Vimeo isn't in v1, Spotify isn't either — must be rejected.
    assert parse_source("https://vimeo.com/12345") is None
    assert parse_source("https://open.spotify.com/track/xyz") is None


def test_parse_rejects_bogus_input():
    assert parse_source("") is None
    assert parse_source(None) is None  # type: ignore[arg-type]
    assert parse_source("not a url") is None
    assert parse_source("https://" + "a" * 3000) is None  # too long


# =============================================================================
# 2. REST: GET /guilds/{id}/watch-state
# =============================================================================


@pytest.mark.asyncio
async def test_guild_watch_state_reflects_redis(client, _auth_signer, redis):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "555",
        "position": 12.5,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{vc['id']}", json.dumps(state), ex=600)
    try:
        r = await client.get(f"/guilds/{g['id']}/watch-state", headers=_auth(token))
        assert r.status_code == 200, r.text
        states = {s["channel_id"]: s["state"] for s in r.json()["watch_states"]}
        assert states[vc["id"]]["host_user_id"] == "555"
        assert states[vc["id"]]["source"]["embed_id"] == "abc12345678"
    finally:
        await redis.delete(f"watch:channel-{vc['id']}")


@pytest.mark.asyncio
async def test_guild_watch_state_empty_when_no_party(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
    )
    r = await client.get(f"/guilds/{g['id']}/watch-state", headers=_auth(token))
    assert r.status_code == 200
    assert r.json()["watch_states"] == []


@pytest.mark.asyncio
async def test_guild_watch_state_non_member_403(client, _auth_signer):
    owner, _ = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    r = await client.get(f"/guilds/{g['id']}/watch-state", headers=_auth(outsider))
    assert r.status_code == 403


# =============================================================================
# 3. WebSocket ops
# =============================================================================


def _drain_until(ws, predicate, *, max_drained: int = 10):
    """Read up to ``max_drained`` messages and return the first one matching
    ``predicate(msg)``. Pub/sub-driven broadcasts (watch_state, voice_state,
    stream_state, guild_event) can interleave or arrive in a different order
    than the WS-op-driven response that wrote them, so tests asserting on a
    specific broadcast should filter — not assume position N in the queue.

    Hangs are caught by the test-level ``--timeout=30`` in pyproject.toml;
    out-of-order or extra messages by this helper."""
    for _ in range(max_drained):
        msg = ws.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError(
        f"no matching message after draining {max_drained}; last seen op was "
        f"{msg.get('op') if isinstance(msg, dict) else msg!r}"
    )


def _wait_for_watch_state(
    ws,
    *,
    channel_id: str,
    is_playing: bool | None = None,
    position: float | None = None,
    state_is: object = object(),  # sentinel — pass ``None`` to assert the party ended
):
    """Drain until a ``watch_state`` for ``channel_id`` matches the filter."""
    _none_sentinel = state_is  # noqa: F841 — kept for the closure

    def _match(msg: dict) -> bool:
        if msg.get("op") != "watch_state":
            return False
        if msg.get("channel_id") != channel_id:
            return False
        state = msg.get("state")
        if state_is is None:
            return state is None
        if state is None:
            return False
        if is_playing is not None and state.get("is_playing") != is_playing:
            return False
        if position is not None and state.get("position") != position:
            return False
        return True

    return _drain_until(ws, _match)


def _setup_voice_channel(tc: TestClient, _auth_signer) -> tuple[str, int, str, str]:
    """Register a user, create guild + voice channel. Returns (token, uid,
    guild_id, channel_id)."""
    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
    vc = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "Voice", "type": 1},
        headers=_auth(token),
    ).json()
    return token, uid, g["id"], vc["id"]


def _setup_text_channel(tc: TestClient, _auth_signer) -> tuple[str, str]:
    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    g = tc.post("/guilds", json={"name": "g"}, headers=_auth(token)).json()
    tcc = tc.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general", "type": 0},
        headers=_auth(token),
    ).json()
    return token, tcc["id"]


@pytest.mark.asyncio
async def test_watch_start_writes_state_and_broadcasts(ws_app, _auth_signer):
    """Host starts a party → Redis has the state (verified while the socket
    is still open) and the broadcast carries it. Disconnect cleanup is
    covered separately."""
    import redis as sync_redis

    def _run():
        with TestClient(ws_app) as tc:
            token, uid, _, cid = _setup_voice_channel(tc, _auth_signer)
            r = sync_redis.Redis.from_url(_REDIS_URL)
            try:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    ws.send_json(
                        {
                            "op": "watch_start",
                            "channel_id": cid,
                            "source_url": "https://youtu.be/abc12345678",
                        }
                    )
                    got = ws.receive_json()
                    assert got["op"] == "watch_state"
                    assert got["channel_id"] == cid
                    assert got["state"]["source"]["embed_id"] == "abc12345678"
                    assert got["state"]["host_user_id"] == str(uid)
                    assert got["state"]["is_playing"] is True
                    raw = r.get(f"watch:channel-{cid}")
                    assert raw is not None
                    data = json.loads(raw)
                    assert data["host_user_id"] == str(uid)
            finally:
                r.delete(f"watch:channel-{cid}")
                r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_start_rejects_unsupported_source(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                receive_skipping(ws)  # skip hello + ready
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://vimeo.com/12345",
                    }
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4013

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_start_rejects_text_channel(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            token, cid = _setup_text_channel(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4004

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_start_rejects_non_member(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            outsider_uid = random.randint(1, 1_000_000)
            outsider_token = _auth_signer.issue_access(outsider_uid, f"u{outsider_uid}")
            with tc.websocket_connect(f"/ws?token={outsider_token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4004

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_start_rejects_already_active(ws_app, _auth_signer):
    """Second watch_start on the same channel must fail with 4014."""
    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                skip_init_frames(ws)
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                ws.receive_json()  # watch_state broadcast
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/xyz98765432",
                    }
                )
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4014

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_control_only_host(ws_app, _auth_signer):
    """A second member of the channel cannot control someone else's party."""
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, gid, cid = _setup_voice_channel(tc, _auth_signer)
            other_uid = random.randint(1, 1_000_000)
            other_token = _auth_signer.issue_access(other_uid, f"u{other_uid}")
            # Add `other` to the guild so they're a member of the voice channel.
            tc.post(
                f"/guilds/{gid}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_token),
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as host_ws:
                skip_init_frames(host_ws)  # hello + ready
                host_ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                host_ws.receive_json()  # watch_state broadcast
                with tc.websocket_connect(f"/ws?token={other_token}") as other_ws:
                    skip_init_frames(other_ws)  # hello + ready (includes watch_states)
                    other_ws.send_json(
                        {
                            "op": "watch_control",
                            "channel_id": cid,
                            "action": "pause",
                            "position": 5,
                        }
                    )
                    err = other_ws.receive_json()
                    assert err["op"] == "error"
                    assert err["code"] == 4015

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_control_pause_updates_state(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                receive_skipping(ws)  # skip hello + ready
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                ws.send_json(
                    {
                        "op": "watch_control",
                        "channel_id": cid,
                        "action": "pause",
                        "position": 42.5,
                    }
                )
                # Filter for the paused-state broadcast — skips the start
                # broadcast (is_playing=True) that lands first.
                got = _wait_for_watch_state(
                    ws, channel_id=cid, is_playing=False, position=42.5
                )
                assert got["state"]["position"] == 42.5

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_stop_only_host(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, gid, cid = _setup_voice_channel(tc, _auth_signer)
            other_uid = random.randint(1, 1_000_000)
            other_token = _auth_signer.issue_access(other_uid, f"u{other_uid}")
            tc.post(
                f"/guilds/{gid}/members",
                json={"user_id": str(other_uid)},
                headers=_auth(owner_token),
            )
            with tc.websocket_connect(f"/ws?token={owner_token}") as host_ws:
                skip_init_frames(host_ws)  # hello + ready
                host_ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                host_ws.receive_json()  # watch_state broadcast
                with tc.websocket_connect(f"/ws?token={other_token}") as other_ws:
                    skip_init_frames(other_ws)  # hello + ready (watch_states in payload)
                    other_ws.send_json({"op": "watch_stop", "channel_id": cid})
                    err = other_ws.receive_json()
                    assert err["op"] == "error"
                    assert err["code"] == 4015

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_stop_deletes_state(ws_app, _auth_signer):
    import redis as sync_redis

    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            r = sync_redis.Redis.from_url(_REDIS_URL)
            try:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    ws.send_json(
                        {
                            "op": "watch_start",
                            "channel_id": cid,
                            "source_url": "https://youtu.be/abc12345678",
                        }
                    )
                    _wait_for_watch_state(ws, channel_id=cid, is_playing=True)
                    assert r.get(f"watch:channel-{cid}") is not None
                    ws.send_json({"op": "watch_stop", "channel_id": cid})
                    _wait_for_watch_state(ws, channel_id=cid, state_is=None)
                    assert r.get(f"watch:channel-{cid}") is None
            finally:
                r.delete(f"watch:channel-{cid}")
                r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_heartbeat_debounced(ws_app, _auth_signer):
    """Two heartbeats within 2s → only the first propagates."""
    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                receive_skipping(ws)  # skip hello + ready
                ws.send_json(
                    {
                        "op": "watch_start",
                        "channel_id": cid,
                        "source_url": "https://youtu.be/abc12345678",
                    }
                )
                first = _wait_for_watch_state(ws, channel_id=cid, is_playing=True)
                first_updated = first["state"]["updated_at"]
                # Spam two heartbeats back-to-back — only the second would
                # write because the start-event reset updated_at to "now".
                # With the 2s debounce both must be dropped.
                ws.send_json({"op": "watch_heartbeat", "channel_id": cid, "position": 5})
                ws.send_json({"op": "watch_heartbeat", "channel_id": cid, "position": 6})
                # Send a control op to provoke a broadcast and verify updated_at
                # hasn't moved past the heartbeat-dropped writes.
                time.sleep(0.1)
                ws.send_json(
                    {
                        "op": "watch_control",
                        "channel_id": cid,
                        "action": "seek",
                        "position": 99,
                    }
                )
                after = _wait_for_watch_state(ws, channel_id=cid, position=99)
                # The control op did update updated_at and position — but
                # crucially, position is 99 (from control), not 5 or 6 (from
                # the dropped heartbeats).
                assert after["state"]["position"] == 99
                assert after["state"]["updated_at"] >= first_updated

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ready_carries_watch_states(ws_app, _auth_signer, redis):
    """Pre-write a state to Redis, then a fresh WS connection's ready payload
    should include it."""
    captured_cid: list[str] = []
    captured_token: list[str] = []

    def _setup():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            captured_cid.append(cid)
            captured_token.append(token)

    await asyncio.to_thread(_setup)
    cid = captured_cid[0]
    token = captured_token[0]
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "777",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)
    try:
        def _connect():
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    states = {s["channel_id"]: s["state"] for s in payload["watch_states"]}
                    assert states[cid]["host_user_id"] == "777"

        await asyncio.to_thread(_connect)
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_cleanup_on_disconnect_deletes_hosted_party(redis):
    """Unit-test the cleanup helper directly. Asserting the same path via the
    WS layer races with TestClient's portal cancellation — the production
    finally block has no such cancellation pressure on graceful disconnect."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": str(uid),
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)

    class _Mgr:
        def user_socket_count(self, _uid):
            return 1  # last socket about to close

    class _State:
        def __init__(self, r):
            self.redis = r

    class _App:
        def __init__(self, r):
            self.state = _State(r)

    class _WS:
        def __init__(self, r):
            self.app = _App(r)

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    await ws_watch.cleanup_on_disconnect(_WS(redis), user, _Mgr(), {cid})
    assert await redis.get(f"watch:channel-{cid}") is None


@pytest.mark.asyncio
async def test_cleanup_skips_when_user_has_other_sockets(redis):
    """Another socket of the same user is still connected → party survives."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    state = {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": str(uid),
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await redis.set(f"watch:channel-{cid}", json.dumps(state), ex=600)

    class _Mgr:
        def user_socket_count(self, _uid):
            return 2  # sibling socket still alive

    class _State:
        def __init__(self, r):
            self.redis = r

    class _App:
        def __init__(self, r):
            self.state = _State(r)

    class _WS:
        def __init__(self, r):
            self.app = _App(r)

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        await ws_watch.cleanup_on_disconnect(_WS(redis), user, _Mgr(), {cid})
        assert await redis.get(f"watch:channel-{cid}") is not None
    finally:
        await redis.delete(f"watch:channel-{cid}")


# =============================================================================
# 4. Watch-Chat REST endpoints
# =============================================================================


def _make_party_state(host_uid: int) -> dict:
    ts = watchkeys.now_ms()
    return {
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": str(host_uid),
        "position": 0.0,
        "is_playing": True,
        "updated_at": ts,
        "started_at": ts,
    }


@pytest.mark.asyncio
async def test_post_watch_chat_201_with_active_party(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    cid = vc["id"]
    await redis.set(f"watch:channel-{cid}", json.dumps(_make_party_state(uid)), ex=600)
    try:
        r = await client.post(
            f"/channels/{cid}/watch-party/chat",
            json={"content": "hello watch party"},
            headers=_auth(token),
        )
        assert r.status_code == 201, r.text
        data = r.json()
        assert "id" in data
        assert "created_at" in data
        # Message stored in Redis list.
        raw = await redis.lrange(f"watch:chat:channel-{cid}", 0, -1)
        assert len(raw) == 1
        entry = json.loads(raw[0])
        assert entry["content"] == "hello watch party"
        assert entry["author_id"] == str(uid)
    finally:
        await redis.delete(f"watch:channel-{cid}", f"watch:chat:channel-{cid}")


@pytest.mark.asyncio
async def test_post_watch_chat_410_no_active_party(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    r = await client.post(
        f"/channels/{vc['id']}/watch-party/chat",
        json={"content": "hello"},
        headers=_auth(token),
    )
    assert r.status_code == 410


@pytest.mark.asyncio
async def test_post_watch_chat_403_non_member(client, _auth_signer, redis):
    owner, owner_uid = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(owner)
        )
    ).json()
    cid = vc["id"]
    await redis.set(f"watch:channel-{cid}", json.dumps(_make_party_state(owner_uid)), ex=600)
    try:
        r = await client.post(
            f"/channels/{cid}/watch-party/chat",
            json={"content": "hello"},
            headers=_auth(outsider),
        )
        assert r.status_code == 403
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_post_watch_chat_400_text_channel(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    tc2 = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "general", "type": 0}, headers=_auth(token)
        )
    ).json()
    r = await client.post(
        f"/channels/{tc2['id']}/watch-party/chat",
        json={"content": "hello"},
        headers=_auth(token),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_get_watch_chat_returns_chronological(client, _auth_signer, redis):
    token, uid = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(token))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(token)
        )
    ).json()
    cid = vc["id"]
    # Pre-seed Redis chat list (newest first, like LPUSH).
    chat_key = f"watch:chat:channel-{cid}"
    entries = [
        json.dumps({"id": str(i), "author_id": str(uid), "content": f"msg{i}", "created_at": "2026-01-01T00:00:00"})
        for i in range(3)
    ]
    for e in entries:  # lpush newest-first: push 0→1→2 so msg2 sits at list head
        await redis.lpush(chat_key, e)
    await redis.expire(chat_key, 600)
    try:
        r = await client.get(f"/channels/{cid}/watch-party/chat", headers=_auth(token))
        assert r.status_code == 200, r.text
        msgs = r.json()
        assert len(msgs) == 3
        assert [m["content"] for m in msgs] == ["msg0", "msg1", "msg2"]
    finally:
        await redis.delete(chat_key)


@pytest.mark.asyncio
async def test_get_watch_chat_non_member_403(client, _auth_signer):
    owner, _ = await _register(_auth_signer)
    outsider, _ = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(owner)
        )
    ).json()
    r = await client.get(f"/channels/{vc['id']}/watch-party/chat", headers=_auth(outsider))
    assert r.status_code == 403
