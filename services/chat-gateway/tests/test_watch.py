"""Watch-Party tests.

Four sections:
  1. ``watch_source.parse_source`` — pure unit tests, no fixtures.
  2. ``GET /guilds/{id}/watch-state`` — REST re-sync endpoint.
  3. WebSocket ops — happy + negative paths against ``ws_app`` via TestClient
     (same harness as test_streaming::stream:events).
  4. Watch-Chat REST endpoints — ``POST`` + ``GET /channels/{id}/watch-party/{pid}/chat``.
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
from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
from dcc_shared.permissions import Permissions
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


# A fixed party id used by the non-WS tests (those that seed Redis directly).
# WS ``watch_start`` tests mint their own id and read it from the
# ``watch_started`` ack instead.
_PID = "9001"


async def _seed_party(r, cid, state):
    """Write a party state into the per-channel watch Hash (field = party_id)."""
    await r.hset(f"watch:channel-{cid}", state["party_id"], json.dumps(state))
    await r.expire(f"watch:channel-{cid}", 600)


async def _read_party(r, cid, pid=_PID):
    raw = await r.hget(f"watch:channel-{cid}", pid)
    return json.loads(raw) if raw is not None else None


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


def test_parse_twitch_vod_start_seconds():
    s = parse_source("https://www.twitch.tv/videos/1234567890?t=1h2m3s")
    assert s == {"type": "twitch", "embed_id": "1234567890", "start_seconds": 3723}
    s2 = parse_source("https://www.twitch.tv/videos/1234567890?t=90")
    assert s2 == {"type": "twitch", "embed_id": "1234567890", "start_seconds": 90}


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


def test_parse_native_mp4_webm():
    for url in (
        "https://example.com/movie.mp4",
        "https://cdn.example.com/path/to/clip.webm",
    ):
        assert parse_source(url) == {"type": "native", "url": url}


def test_parse_rejects_hls_m3u8():
    # HLS isn't playable by the plain <video> viewer on Chromium/Electron, so
    # the parser rejects it rather than accepting an un-playable source.
    assert parse_source("https://example.com/stream/index.m3u8") is None


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
        "party_id": _PID,
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "555",
        "position": 12.5,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await _seed_party(redis, vc["id"], state)
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


@pytest.mark.asyncio
async def test_guild_watch_state_hides_view_denied_channel(client, _auth_signer, redis):
    """Ein Member mit VIEW_CHANNEL-deny-Overwrite darf den Watch-State des
    privaten Channels nicht sehen — der Owner weiterhin schon."""
    owner, _ = await _register(_auth_signer)
    member, member_uid = await _register(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=_auth(owner))).json()
    vc = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "Voice", "type": 1}, headers=_auth(owner)
        )
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": str(member_uid)}, headers=_auth(owner)
    )
    r = await client.put(
        f"/channels/{vc['id']}/permissions/{OVERWRITE_TARGET_USER}/{member_uid}",
        json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
        headers=_auth(owner),
    )
    assert r.status_code == 200, r.text
    state = {
        "party_id": _PID,
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "555",
        "position": 0.0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await _seed_party(redis, vc["id"], state)
    try:
        r = await client.get(f"/guilds/{g['id']}/watch-state", headers=_auth(member))
        assert r.status_code == 200, r.text
        assert r.json()["watch_states"] == []
        r = await client.get(f"/guilds/{g['id']}/watch-state", headers=_auth(owner))
        assert vc["id"] in {s["channel_id"] for s in r.json()["watch_states"]}
    finally:
        await redis.delete(f"watch:channel-{vc['id']}")


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
                    # First direct reply is the watch_started ack carrying the
                    # freshly-minted party id.
                    ack = ws.receive_json()
                    assert ack["op"] == "watch_started"
                    assert ack["channel_id"] == cid
                    pid = ack["party_id"]
                    got = ws.receive_json()
                    # watch_start now also emits a watch_watchers frame (direct
                    # in-process broadcast) which can arrive before the
                    # Redis-routed watch_state. Skip any watch_watchers frames.
                    while got["op"] == "watch_watchers":
                        assert got["channel_id"] == cid
                        assert str(uid) in got["user_ids"]
                        got = ws.receive_json()
                    assert got["op"] == "watch_state"
                    assert got["channel_id"] == cid
                    assert got["state"]["source"]["embed_id"] == "abc12345678"
                    assert got["state"]["host_user_id"] == str(uid)
                    assert got["state"]["is_playing"] is True
                    # Carries the server clock so viewers calibrate their offset
                    # and extrapolate position against the shared server clock.
                    assert isinstance(got["server_now"], int)
                    assert got["server_now"] > 0
                    raw = r.hget(f"watch:channel-{cid}", pid)
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
async def test_watch_join_and_start_reject_view_denied(ws_app, _auth_signer):
    """Ein Member mit VIEW_CHANNEL-deny-Overwrite darf weder der Watch-Party
    beitreten (Watcher-Registry + Updates) noch eine hosten — gleicher
    4004-Fehler wie der Membership-Fail, damit die Existenz des versteckten
    Channels nicht bestätigt wird."""

    def _run():
        with TestClient(ws_app) as tc:
            owner_token, _, gid, cid = _setup_voice_channel(tc, _auth_signer)
            member_uid = random.randint(1, 1_000_000)
            member_token = _auth_signer.issue_access(member_uid, f"u{member_uid}")
            tc.post(
                f"/guilds/{gid}/members",
                json={"user_id": str(member_uid)},
                headers=_auth(owner_token),
            )
            r = tc.put(
                f"/channels/{cid}/permissions/{OVERWRITE_TARGET_USER}/{member_uid}",
                json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
                headers=_auth(owner_token),
            )
            assert r.status_code == 200, r.text
            with tc.websocket_connect(f"/ws?token={member_token}") as ws:
                skip_init_frames(ws)
                ws.send_json({"op": "watch_join", "channel_id": cid, "party_id": _PID})
                err = ws.receive_json()
                assert err["op"] == "error"
                assert err["code"] == 4004
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
async def test_watch_start_allows_second_party(ws_app, _auth_signer):
    """Several parties may run in one channel — a second watch_start on the
    same channel succeeds and gets its own, distinct party id."""
    import redis as sync_redis

    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            r = sync_redis.Redis.from_url(_REDIS_URL)
            try:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    skip_init_frames(ws)
                    ws.send_json(
                        {
                            "op": "watch_start",
                            "channel_id": cid,
                            "source_url": "https://youtu.be/abc12345678",
                        }
                    )
                    # First start: read its ack (party id), drain to its state.
                    ack1 = ws.receive_json()
                    assert ack1["op"] == "watch_started"
                    pid1 = ack1["party_id"]
                    got = ws.receive_json()
                    while got["op"] != "watch_state":
                        got = ws.receive_json()
                    # Second start on the same channel — different source.
                    ws.send_json(
                        {
                            "op": "watch_start",
                            "channel_id": cid,
                            "source_url": "https://youtu.be/xyz98765432",
                        }
                    )
                    ack2 = ws.receive_json()
                    while ack2["op"] in ("watch_watchers", "watch_state"):
                        ack2 = ws.receive_json()
                    assert ack2["op"] == "watch_started"
                    pid2 = ack2["party_id"]
                    assert pid2 != pid1  # distinct party id for the second party
            finally:
                r.delete(f"watch:channel-{cid}")
                r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_start_rejects_when_channel_full(ws_app, _auth_signer):
    """A channel already holding MAX_PARTIES_PER_CHANNEL parties rejects a
    fresh watch_start with 4014."""
    import redis as sync_redis

    def _run():
        with TestClient(ws_app) as tc:
            token, _, _, cid = _setup_voice_channel(tc, _auth_signer)
            r = sync_redis.Redis.from_url(_REDIS_URL)
            key = f"watch:channel-{cid}"
            try:
                # Pre-seed the channel hash to the cap with dummy parties.
                for i in range(watchkeys.MAX_PARTIES_PER_CHANNEL):
                    r.hset(
                        key,
                        str(i),
                        json.dumps(
                            {
                                "party_id": str(i),
                                "source": {"type": "youtube", "embed_id": "abc12345678"},
                                "host_user_id": "1",
                                "position": 0.0,
                                "is_playing": True,
                                "updated_at": watchkeys.now_ms(),
                                "started_at": watchkeys.now_ms(),
                            }
                        ),
                    )
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
                    while err["op"] == "watch_watchers":
                        err = ws.receive_json()
                    assert err["op"] == "error"
                    assert err["code"] == 4014
            finally:
                r.delete(key)
                r.close()

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
                ack = host_ws.receive_json()  # watch_started ack
                assert ack["op"] == "watch_started"
                pid = ack["party_id"]
                with tc.websocket_connect(f"/ws?token={other_token}") as other_ws:
                    skip_init_frames(other_ws)  # hello + ready (includes watch_states)
                    other_ws.send_json(
                        {
                            "op": "watch_control",
                            "channel_id": cid,
                            "party_id": pid,
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
                ack = ws.receive_json()  # watch_started ack carries the party id
                assert ack["op"] == "watch_started"
                pid = ack["party_id"]
                ws.send_json(
                    {
                        "op": "watch_control",
                        "channel_id": cid,
                        "party_id": pid,
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
async def test_watch_source_change_swaps_source(ws_app, _auth_signer):
    """Host switches the video live → same party_id, new source, position
    resets to the new ?t= start, playback resumes."""
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
                ack = ws.receive_json()  # watch_started ack carries the party id
                assert ack["op"] == "watch_started"
                pid = ack["party_id"]
                ws.send_json(
                    {
                        "op": "watch_source_change",
                        "channel_id": cid,
                        "party_id": pid,
                        "source_url": "https://youtu.be/xyz98765432?t=30",
                    }
                )
                # position=30 uniquely identifies the post-switch broadcast
                # (the start broadcast was position 0).
                got = _wait_for_watch_state(ws, channel_id=cid, position=30.0)
                assert got["state"]["party_id"] == pid  # same party
                assert got["state"]["source"]["embed_id"] == "xyz98765432"
                assert got["state"]["is_playing"] is True

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_source_change_only_host(ws_app, _auth_signer):
    """A non-host member cannot switch someone else's party source."""
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
                ack = host_ws.receive_json()  # watch_started ack
                assert ack["op"] == "watch_started"
                pid = ack["party_id"]
                with tc.websocket_connect(f"/ws?token={other_token}") as other_ws:
                    skip_init_frames(other_ws)  # hello + ready
                    other_ws.send_json(
                        {
                            "op": "watch_source_change",
                            "channel_id": cid,
                            "party_id": pid,
                            "source_url": "https://youtu.be/xyz98765432",
                        }
                    )
                    err = other_ws.receive_json()
                    assert err["op"] == "error"
                    assert err["code"] == 4015

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
                ack = host_ws.receive_json()  # watch_started ack
                assert ack["op"] == "watch_started"
                pid = ack["party_id"]
                with tc.websocket_connect(f"/ws?token={other_token}") as other_ws:
                    skip_init_frames(other_ws)  # hello + ready (watch_states in payload)
                    other_ws.send_json(
                        {"op": "watch_stop", "channel_id": cid, "party_id": pid}
                    )
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
                    ack = ws.receive_json()  # watch_started ack
                    assert ack["op"] == "watch_started"
                    pid = ack["party_id"]
                    _wait_for_watch_state(ws, channel_id=cid, is_playing=True)
                    assert r.hget(f"watch:channel-{cid}", pid) is not None
                    ws.send_json({"op": "watch_stop", "channel_id": cid, "party_id": pid})
                    _wait_for_watch_state(ws, channel_id=cid, state_is=None)
                    assert r.hget(f"watch:channel-{cid}", pid) is None
            finally:
                r.delete(f"watch:channel-{cid}")
                r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_watch_heartbeat_debounced(ws_app, _auth_signer):
    """Heartbeats inside the debounce window are dropped (no position write)."""
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
                ack = ws.receive_json()  # watch_started ack
                assert ack["op"] == "watch_started"
                pid = ack["party_id"]
                first = _wait_for_watch_state(ws, channel_id=cid, is_playing=True)
                first_updated = first["state"]["updated_at"]
                # Spam two heartbeats back-to-back — the start-event just reset
                # updated_at to "now", so both land inside the debounce window
                # (`_HEARTBEAT_DEBOUNCE_MS`) and must be dropped.
                ws.send_json(
                    {"op": "watch_heartbeat", "channel_id": cid, "party_id": pid, "position": 5}
                )
                ws.send_json(
                    {"op": "watch_heartbeat", "channel_id": cid, "party_id": pid, "position": 6}
                )
                # Send a control op to provoke a broadcast and verify updated_at
                # hasn't moved past the heartbeat-dropped writes.
                time.sleep(0.1)
                ws.send_json(
                    {
                        "op": "watch_control",
                        "channel_id": cid,
                        "party_id": pid,
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
        "party_id": _PID,
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": "777",
        "position": 0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    await _seed_party(redis, cid, state)
    try:
        def _connect():
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    states = {s["channel_id"]: s["state"] for s in payload["watch_states"]}
                    assert states[cid]["host_user_id"] == "777"
                    # ready seeds the client's server-clock offset on connect.
                    assert isinstance(payload["server_now"], int)
                    assert payload["server_now"] > 0

        await asyncio.to_thread(_connect)
    finally:
        await redis.delete(f"watch:channel-{cid}")


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
    host_ws = _ErrWS(redis, mgr)  # same instance is redis source + registry key
    await mgr.watch_join(cid, _PID, str(uid), host_ws, now_ms=1000)
    await mgr.watch_join(cid, _PID, "999", object(), now_ms=2000)
    await _seed_party(redis, cid, _state(host=str(uid)))

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        await ws_watch.cleanup_on_disconnect(host_ws, user, mgr, {(cid, _PID)})
        await mgr._watch_end_timers[(cid, _PID)][1]  # await the scheduled end
        assert await _read_party(redis, cid) is None
    finally:
        await redis.delete(f"watch:channel-{cid}")


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
    await mgr.watch_join(cid, _PID, str(uid), host_ws, now_ms=1000)
    await _seed_party(redis, cid, _state(host=str(uid)))

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    await ws_watch.cleanup_on_disconnect(host_ws, user, mgr, {(cid, _PID)})
    await mgr._watch_end_timers[(cid, _PID)][1]
    assert await _read_party(redis, cid) is None


@pytest.mark.asyncio
async def test_cleanup_on_disconnect_multitab_keeps_party(redis):
    """A sibling socket of the host is still watching → host stays, no end."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    tab1 = _ErrWS(redis, mgr)
    tab2 = _ErrWS(redis, mgr)
    await mgr.watch_join(cid, _PID, str(uid), tab1, now_ms=1000)
    await mgr.watch_join(cid, _PID, str(uid), tab2, now_ms=1000)
    await _seed_party(redis, cid, _state(host=str(uid)))

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        # tab1 disconnects — user still watches via tab2 → no promotion/end.
        await ws_watch.cleanup_on_disconnect(tab1, user, mgr, {(cid, _PID)})
        assert (cid, _PID) not in mgr._watch_end_timers  # no grace timer scheduled
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == str(uid)
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_detach_sibling_socket_keeps_party_when_main_leaves(redis):
    """Detach handover: the host's popup window joins as a sibling socket of the
    same user, then the main window leaves (reattach / main-window close). The
    party must survive on the popup anchor — NOT end. This is the server-side
    invariant the frontend detach fix relies on (suppress the inline tile's
    leave until the popup has joined, then either socket may leave safely)."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    main_ws = _ErrWS(redis, mgr)  # main window (anchor)
    popup_ws = _ErrWS(redis, mgr)  # detached popup, same user
    await mgr.watch_join(cid, _PID, str(uid), main_ws, now_ms=1000)
    await mgr.watch_join(cid, _PID, str(uid), popup_ws, now_ms=2000)
    await _seed_party(redis, cid, _state(host=str(uid)))

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        # Main window leaves deliberately while the popup still holds the party.
        await ws_watch.handle_leave(
            main_ws, user, {"channel_id": cid, "party_id": _PID}, watched_parties={(cid, _PID)}
        )
        assert (cid, _PID) not in mgr._watch_end_timers  # no grace timer
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == str(uid)  # party intact, still hosted by uid
        assert str(uid) in await mgr.watchers(cid, _PID)  # popup socket still a watcher
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_watch_leave_after_party_end_is_clean_noop(redis):
    """Phantom-anchor cleanup path: after a detached party has ended, the main
    window releases its held-back anchor with a late `watch_leave`. With no
    state left it must be a clean no-op — no error frame, registry entry gone,
    party stays ended."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    uid = random.randint(1, 1_000_000)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    main_ws = _ErrWS(redis, mgr)
    await mgr.watch_join(cid, _PID, str(uid), main_ws, now_ms=1000)  # phantom anchor
    # Party already ended → no state key in redis.

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    await ws_watch.handle_leave(
        main_ws, user, {"channel_id": cid, "party_id": _PID}, watched_parties={(cid, _PID)}
    )
    assert main_ws.errors == []  # no error frame
    assert await mgr.watchers(cid, _PID) == []  # anchor removed from registry
    assert await _read_party(redis, cid) is None  # still ended


# =============================================================================
# 4. Watch-Chat REST endpoints
# =============================================================================


def _make_party_state(host_uid: int, party_id: str = _PID) -> dict:
    ts = watchkeys.now_ms()
    return {
        "party_id": party_id,
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
    await _seed_party(redis, cid, _make_party_state(uid))
    try:
        r = await client.post(
            f"/channels/{cid}/watch-party/{_PID}/chat",
            json={"content": "hello watch party"},
            headers=_auth(token),
        )
        assert r.status_code == 201, r.text
        data = r.json()
        assert "id" in data
        assert "created_at" in data
        # Message stored in Redis list.
        raw = await redis.lrange(f"watch:chat:channel-{cid}-{_PID}", 0, -1)
        assert len(raw) == 1
        entry = json.loads(raw[0])
        assert entry["content"] == "hello watch party"
        assert entry["author_id"] == str(uid)
    finally:
        await redis.delete(f"watch:channel-{cid}", f"watch:chat:channel-{cid}-{_PID}")


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
        f"/channels/{vc['id']}/watch-party/{_PID}/chat",
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
    await _seed_party(redis, cid, _make_party_state(owner_uid))
    try:
        r = await client.post(
            f"/channels/{cid}/watch-party/{_PID}/chat",
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
        f"/channels/{tc2['id']}/watch-party/{_PID}/chat",
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
    chat_key = f"watch:chat:channel-{cid}-{_PID}"
    entries = [
        json.dumps({"id": str(i), "author_id": str(uid), "content": f"msg{i}", "created_at": "2026-01-01T00:00:00"})
        for i in range(3)
    ]
    for e in entries:  # lpush newest-first: push 0→1→2 so msg2 sits at list head
        await redis.lpush(chat_key, e)
    await redis.expire(chat_key, 600)
    try:
        r = await client.get(f"/channels/{cid}/watch-party/{_PID}/chat", headers=_auth(token))
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
    r = await client.get(f"/channels/{vc['id']}/watch-party/{_PID}/chat", headers=_auth(outsider))
    assert r.status_code == 403


# =============================================================================
# 5. Host-Handoff — promotion core + explicit handoff
# =============================================================================


def _reg_mgr():
    """A bare ConnectionManager-shaped object carrying just the watcher
    registry (real mixin) + a no-op broadcast — enough for promotion tests."""
    from dcc_chat_gateway.watch_registry import _WatchRegistryMixin

    class _Mgr(_WatchRegistryMixin):
        def __init__(self):
            self._lock = asyncio.Lock()
            self._init_watch_registry()

        async def broadcast_watchers(self, cid, pid):
            pass

    return _Mgr()


def _state(host: str = "111", party_id: str = _PID, **over) -> dict:
    base = {
        "party_id": party_id,
        "source": {"type": "youtube", "embed_id": "abc12345678"},
        "host_user_id": host,
        "position": 0.0,
        "is_playing": True,
        "updated_at": watchkeys.now_ms(),
        "started_at": watchkeys.now_ms(),
    }
    base.update(over)
    return base


class _ErrWS:
    """Minimal websocket stand-in that records error frames + exposes
    app.state.{redis,connection_manager}."""

    def __init__(self, redis, mgr):
        state = type("S", (), {"redis": redis, "connection_manager": mgr})()
        self.app = type("A", (), {"state": state})()
        self.errors: list[tuple[int, str]] = []

    async def send_json(self, payload):
        if payload.get("op") == "error":
            self.errors.append((payload["code"], payload["msg"]))


def test_promoted_state_swaps_host_and_refreshes_position():
    base = _state(host="111", position=10.0, updated_at=1000)
    out = watchkeys.promoted_state(base, "222", now_ms_val=3000)
    assert out["host_user_id"] == "222"
    assert out["is_playing"] is True
    assert out["position"] == pytest.approx(12.0)  # 10 + (3000-1000)/1000
    assert out["updated_at"] == 3000
    assert base["host_user_id"] == "111"  # original untouched


@pytest.mark.asyncio
async def test_promote_or_end_promotes_oldest_other_watcher(redis):
    from dcc_chat_gateway.routes.watch_handoff import promote_or_end

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    host_ws = object()
    await mgr.watch_join(cid, _PID, "111", host_ws, now_ms=1000)
    await mgr.watch_join(cid, _PID, "222", object(), now_ms=2000)
    await mgr.watch_join(cid, _PID, "333", object(), now_ms=3000)
    await _seed_party(redis, cid, _state(host="111", position=5.0))
    try:
        await mgr.watch_leave(cid, _PID, "111", host_ws)
        await promote_or_end(redis, mgr, cid, _PID, "111")
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "222"
        assert new["is_playing"] is True
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_promote_or_end_deletes_when_no_watchers_left(redis):
    from dcc_chat_gateway.routes.watch_handoff import promote_or_end

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await _seed_party(redis, cid, _state(host="111"))
    await promote_or_end(redis, mgr, cid, _PID, "111")
    assert await _read_party(redis, cid) is None


@pytest.mark.asyncio
async def test_promote_or_end_noop_for_non_host_departure(redis):
    from dcc_chat_gateway.routes.watch_handoff import promote_or_end

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await mgr.watch_join(cid, _PID, "111", object(), now_ms=1000)
    await mgr.watch_join(cid, _PID, "222", object(), now_ms=2000)
    await _seed_party(redis, cid, _state(host="111"))
    try:
        await promote_or_end(redis, mgr, cid, _PID, "222")  # viewer leaves
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


@pytest.fixture
def _handoff_member_ok():
    """Patch handle_handoff's membership + VIEW_CHANNEL gate to pass, so the
    handoff-logic tests exercise the host/target branches. The membership gate
    itself is covered by ``test_handoff_non_member_errors_4004``."""
    from dcc_chat_gateway.routes import watch_handoff

    async def _ok(session, c, u):
        return type("Chan", (), {"type": 1, "guild_id": 1})()  # CHANNEL_TYPE_VOICE

    async def _all_perms(session, user, gid, channel_id):
        return int(Permissions.VIEW_CHANNEL)

    orig_m = watch_handoff.channel_membership
    orig_p = watch_handoff.resolve_permissions
    watch_handoff.channel_membership = _ok
    watch_handoff.resolve_permissions = _all_perms
    yield
    watch_handoff.channel_membership = orig_m
    watch_handoff.resolve_permissions = orig_p


@pytest.mark.asyncio
async def test_handoff_to_valid_target_swaps_host(redis, _handoff_member_ok):
    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await mgr.watch_join(cid, _PID, "111", object(), now_ms=1000)
    await mgr.watch_join(cid, _PID, "222", object(), now_ms=2000)
    await _seed_party(redis, cid, _state(host="111"))
    ws = _ErrWS(redis, mgr)
    user = AuthenticatedUser(id=111, username="u111", is_admin=False, payload={})
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "party_id": _PID, "target_user_id": "222"},
            session_factory=lambda: _FakeSession(),
        )
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "222"
        assert ws.errors == []
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handoff_to_non_watcher_errors_4018(redis, _handoff_member_ok):
    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await mgr.watch_join(cid, _PID, "111", object(), now_ms=1000)
    await _seed_party(redis, cid, _state(host="111"))
    ws = _ErrWS(redis, mgr)
    user = AuthenticatedUser(id=111, username="u111", is_admin=False, payload={})
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "party_id": _PID, "target_user_id": "999"},
            session_factory=lambda: _FakeSession(),
        )
        assert ws.errors and ws.errors[0][0] == 4018
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handoff_by_non_host_errors_4015(redis, _handoff_member_ok):
    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await mgr.watch_join(cid, _PID, "111", object(), now_ms=1000)
    await mgr.watch_join(cid, _PID, "222", object(), now_ms=2000)
    await _seed_party(redis, cid, _state(host="111"))
    ws = _ErrWS(redis, mgr)
    user = AuthenticatedUser(id=222, username="u222", is_admin=False, payload={})
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "party_id": _PID, "target_user_id": "111"},
            session_factory=lambda: _FakeSession(),
        )
        assert ws.errors and ws.errors[0][0] == 4015
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handoff_non_member_errors_4004(redis):
    """A non-member must hit the membership gate (4004) before any party state
    is read — so party existence is not leaked via 4015/4016."""
    from dcc_chat_gateway.routes import watch_handoff
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await mgr.watch_join(cid, _PID, "111", object(), now_ms=1000)
    await _seed_party(redis, cid, _state(host="111"))
    ws = _ErrWS(redis, mgr)
    user = AuthenticatedUser(id=222, username="u222", is_admin=False, payload={})

    async def _not_member(session, c, u):
        return None

    orig_m = watch_handoff.channel_membership
    watch_handoff.channel_membership = _not_member
    try:
        await watch_handoff.handle_handoff(
            ws, user, {"channel_id": cid, "party_id": _PID, "target_user_id": "111"},
            session_factory=lambda: _FakeSession(),
        )
        assert ws.errors and ws.errors[0][0] == 4004
    finally:
        watch_handoff.channel_membership = orig_m
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_handle_join_registers_and_broadcasts(redis):
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    broadcasts: list[tuple[str, str]] = []

    mgr = _reg_mgr()

    async def _rec(cid, pid):
        broadcasts.append((cid, pid))

    mgr.broadcast_watchers = _rec  # type: ignore[method-assign]

    cid_int = random.randint(10**18, 10**19 - 1)
    cid = str(cid_int)
    uid = random.randint(1, 1_000_000)

    ws = _ErrWS(redis, mgr)
    watched: set[tuple[str, str]] = set()
    # handle_join now refuses to register a watcher for a party that isn't
    # active in Redis — seed it first.
    await _seed_party(redis, cid, _state(host="111"))

    async def _ok(session, c, u):
        return type("Chan", (), {"type": 1, "guild_id": 1})()  # CHANNEL_TYPE_VOICE == 1

    async def _all_perms(session, user, gid, channel_id):
        return int(Permissions.VIEW_CHANNEL)

    orig = ws_watch.channel_membership
    orig_perms = ws_watch.resolve_permissions
    ws_watch.channel_membership = _ok
    ws_watch.resolve_permissions = _all_perms
    try:
        await ws_watch.handle_join(
            ws, AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={}),
            {"channel_id": cid, "party_id": _PID},
            session_factory=lambda: _FakeSession(),
            watched_parties=watched,
        )
    finally:
        ws_watch.channel_membership = orig
        ws_watch.resolve_permissions = orig_perms
        await redis.delete(f"watch:channel-{cid}")
    assert (cid, _PID) in watched
    assert str(uid) in await mgr.watchers(cid, _PID)
    assert broadcasts == [(cid, _PID)]


@pytest.mark.asyncio
async def test_heartbeat_rejects_out_of_range_position(redis):
    """A heartbeat above _MAX_POSITION_S must be dropped (same bound as
    handle_control) — it cannot move the stored position."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    # updated_at far in the past so the debounce wouldn't block a valid write.
    await _seed_party(
        redis, cid, _state(host="111", position=5.0, updated_at=watchkeys.now_ms() - 60_000)
    )
    ws = _ErrWS(redis, _reg_mgr())
    user = AuthenticatedUser(id=111, username="u111", is_admin=False, payload={})
    try:
        await ws_watch.handle_heartbeat(
            ws,
            user,
            {"channel_id": cid, "party_id": _PID, "position": ws_watch._MAX_POSITION_S + 1},
        )
        new = await _read_party(redis, cid)
        assert new["position"] == 5.0  # unchanged — heartbeat dropped
        # Sanity: a within-bounds heartbeat does move it.
        await ws_watch.handle_heartbeat(
            ws, user, {"channel_id": cid, "party_id": _PID, "position": 42.0}
        )
        moved = await _read_party(redis, cid)
        assert moved["position"] == 42.0
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_heartbeat_drops_stale_source_epoch(redis):
    """A heartbeat carrying an OLD source epoch (measured against a since-
    replaced clip) must NOT stamp its position onto the new clip — the "second
    queued clip starts in the middle" bug. A matching / absent epoch applies."""
    from dcc_chat_gateway.routes import ws_watch
    from dcc_chat_gateway.security import AuthenticatedUser

    cid = str(random.randint(10**18, 10**19 - 1))
    # Party is now on its second clip (epoch 1), freshly reset to position 0.
    await _seed_party(
        redis,
        cid,
        _state(host="111", position=0.0, source_epoch=1, updated_at=watchkeys.now_ms() - 60_000),
    )
    ws = _ErrWS(redis, _reg_mgr())
    user = AuthenticatedUser(id=111, username="u111", is_admin=False, payload={})
    base = {"channel_id": cid, "party_id": _PID}
    try:
        # Stale beat from the old clip (epoch 0) at position 200 → dropped.
        await ws_watch.handle_heartbeat(ws, user, {**base, "position": 200.0, "source_epoch": 0})
        assert (await _read_party(redis, cid))["position"] == 0.0

        # Current-epoch beat applies.
        await ws_watch.handle_heartbeat(ws, user, {**base, "position": 7.0, "source_epoch": 1})
        assert (await _read_party(redis, cid))["position"] == 7.0

        # Legacy client (no epoch) is not penalised — guard skipped. Re-seed with
        # an old updated_at so the heartbeat debounce doesn't mask the result.
        await _seed_party(
            redis,
            cid,
            _state(host="111", position=0.0, source_epoch=1, updated_at=watchkeys.now_ms() - 60_000),
        )
        await ws_watch.handle_heartbeat(ws, user, {**base, "position": 9.0})
        assert (await _read_party(redis, cid))["position"] == 9.0
    finally:
        await redis.delete(f"watch:channel-{cid}")


# =============================================================================
# 5. Host-sticky grace timer (registry) — schedule / cancel / expire
# =============================================================================


@pytest.mark.asyncio
async def test_grace_expires_ends_party(redis, monkeypatch):
    """Host gone, no reconnect within the grace → party ends."""
    monkeypatch.setattr(watchkeys, "WATCH_HOST_GRACE_S", 0)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await _seed_party(redis, cid, _state(host="111"))
    try:
        mgr.schedule_host_end(redis, cid, _PID, "111")
        await mgr._watch_end_timers[(cid, _PID)][1]  # await the scheduled task
        assert await _read_party(redis, cid) is None
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_host_reconnect_within_grace_cancels_end(redis):
    """Host rejoins as a watcher before the grace expires → timer cancelled,
    party intact."""
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await _seed_party(redis, cid, _state(host="111"))
    try:
        mgr.schedule_host_end(redis, cid, _PID, "111")  # default 30s grace
        assert (cid, _PID) in mgr._watch_end_timers
        await mgr.watch_join(cid, _PID, "111", object())  # host returns
        assert (cid, _PID) not in mgr._watch_end_timers  # timer cancelled
        await asyncio.sleep(0)  # let cancellation settle
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "111"  # party still there
    finally:
        await redis.delete(f"watch:channel-{cid}")


# =============================================================================
# 6. Departure helpers — end_if_host (immediate) / end_or_grace_if_host (grace)
# =============================================================================


@pytest.mark.asyncio
async def test_end_if_host_deletes_for_host(redis):
    from dcc_chat_gateway.routes.watch_handoff import end_if_host

    cid = str(random.randint(10**18, 10**19 - 1))
    await _seed_party(redis, cid, _state(host="111"))
    await end_if_host(redis, cid, _PID, "111")
    assert await _read_party(redis, cid) is None


@pytest.mark.asyncio
async def test_end_if_host_noop_for_viewer(redis):
    from dcc_chat_gateway.routes.watch_handoff import end_if_host

    cid = str(random.randint(10**18, 10**19 - 1))
    await _seed_party(redis, cid, _state(host="111"))
    try:
        await end_if_host(redis, cid, _PID, "222")  # viewer leaving
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_end_or_grace_if_host_schedules_for_host(redis, monkeypatch):
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    monkeypatch.setattr(watchkeys, "WATCH_HOST_GRACE_S", 0)
    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await _seed_party(redis, cid, _state(host="111"))
    try:
        await end_or_grace_if_host(redis, mgr, cid, _PID, "111")
        await mgr._watch_end_timers[(cid, _PID)][1]
        assert await _read_party(redis, cid) is None
    finally:
        await redis.delete(f"watch:channel-{cid}")


@pytest.mark.asyncio
async def test_end_or_grace_if_host_noop_for_viewer(redis):
    from dcc_chat_gateway.routes.watch_handoff import end_or_grace_if_host

    cid = str(random.randint(10**18, 10**19 - 1))
    mgr = _reg_mgr()
    await _seed_party(redis, cid, _state(host="111"))
    try:
        await end_or_grace_if_host(redis, mgr, cid, _PID, "222")  # viewer
        assert (cid, _PID) not in mgr._watch_end_timers
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")


# =============================================================================
# 7. handle_leave — host ends immediately (no grace), viewer leaves cleanly
# =============================================================================


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
    await mgr.watch_join(cid, _PID, str(uid), host_ws, now_ms=1000)
    await mgr.watch_join(cid, _PID, "999", object(), now_ms=2000)
    await _seed_party(redis, cid, _state(host=str(uid)))

    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    try:
        await ws_watch.handle_leave(
            host_ws, user, {"channel_id": cid, "party_id": _PID}, watched_parties={(cid, _PID)}
        )
        assert (cid, _PID) not in mgr._watch_end_timers  # no grace timer
        assert await _read_party(redis, cid) is None  # ended now
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
    await mgr.watch_join(cid, _PID, "111", host_ws, now_ms=1000)
    await mgr.watch_join(cid, _PID, "222", viewer_ws, now_ms=2000)
    await _seed_party(redis, cid, _state(host="111"))

    user = AuthenticatedUser(id=222, username="u222", is_admin=False, payload={})
    try:
        await ws_watch.handle_leave(
            viewer_ws, user, {"channel_id": cid, "party_id": _PID}, watched_parties={(cid, _PID)}
        )
        new = await _read_party(redis, cid)
        assert new["host_user_id"] == "111"
    finally:
        await redis.delete(f"watch:channel-{cid}")
