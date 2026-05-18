"""Tests for the force-mute admin endpoint:

  PUT /channels/{cid}/members/{uid}/voice-override

Covers: MUTE_MEMBERS gate, self-mute rejection, Redis persistence,
event publication, and the token-issue path respecting the override.

LiveKit's room-service is stubbed (the participant isn't really online
in the test). Redis runs from the dev container per the project README;
falls back to no-redis path checks where applicable.
"""

from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio
from redis.asyncio import Redis

import dcc_voice_signaling.routes as voice_routes


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


_PERM_CONNECT = 1 << 30
_PERM_SPEAK = 1 << 31
_PERM_USE_VIDEO = 1 << 33
_PERM_STREAM = 1 << 32
_PERM_MUTE_MEMBERS = 1 << 34
_PERM_DEAFEN_MEMBERS = 1 << 35


def _make_voice_channel_mock(perms_bf: int):
    """chat-gateway mock that answers the membership + permissions
    lookup the routes make."""
    async def _mock(method, path, *, bearer):
        if path.endswith("/permissions/me"):
            return httpx.Response(200, json={"permissions": str(perms_bf)})
        return httpx.Response(
            200, json={"id": "987654321", "guild_id": "1", "type": 1}
        )
    return _mock


@pytest_asyncio.fixture
async def redis_client(_isolate_voice_settings):
    """Per-test Redis connection on db /9 (segregated from /0 so dev data
    isn't disturbed). Flushed afterwards to keep the namespace clean."""
    r = Redis.from_url("redis://localhost:6380/9", decode_responses=False)
    await r.flushdb()
    yield r
    await r.flushdb()
    await r.aclose()


@pytest_asyncio.fixture
async def app_with_redis(_isolate_voice_settings, redis_client):
    """voice-signaling app pre-wired with a real Redis on db /9. Returns
    an httpx AsyncClient bound to the in-process ASGI app."""
    from dcc_voice_signaling.app import create_app

    app = create_app(skip_redis=True)
    app.state.redis = redis_client
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, redis_client


@pytest.fixture(autouse=True)
def _stub_livekit_update(monkeypatch):
    """The override endpoint best-effort-calls LiveKit's room-service
    to live-apply the permission change. Skip the real network in tests."""
    calls: list[dict] = []

    async def _noop(channel_id, user_id, *, can_publish, sources):
        calls.append(
            {
                "channel_id": channel_id,
                "user_id": user_id,
                "can_publish": can_publish,
                "sources": list(sources),
            }
        )

    monkeypatch.setattr(voice_routes, "_livekit_update_participant", _noop)
    return calls


@pytest.mark.asyncio
async def test_mute_requires_mute_members_perm(app_with_redis, auth_signer, monkeypatch):
    client, _redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    # Caller has CONNECT + SPEAK only — no MUTE_MEMBERS.
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_SPEAK),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"mute": True},
        headers=auth(access),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_mute_rejects_self(app_with_redis, auth_signer, monkeypatch):
    client, _redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_MUTE_MEMBERS),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/42/voice-override",
        json={"mute": True},
        headers=auth(access),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_mute_persists_in_redis_and_publishes_event(
    app_with_redis, auth_signer, monkeypatch
):
    client, redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_MUTE_MEMBERS),
    )
    # Subscribe to voice:events before the mute call — Redis publish to a
    # channel with no subscribers is a no-op so subscribing first lets us
    # actually receive the event.
    pubsub = redis.pubsub()
    await pubsub.subscribe("voice:events")
    # Discard the subscribe-confirmation frame.
    await pubsub.get_message(timeout=1.0)

    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"mute": True},
        headers=auth(access),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"muted": True, "deafened": False}

    # Redis key was set.
    raw = await redis.get("voice:override:channel-987654321:user-99")
    assert raw is not None
    assert json.loads(raw.decode())["muted"] is True

    # voice:events received an envelope.
    msg = await pubsub.get_message(timeout=1.0, ignore_subscribe_messages=True)
    assert msg is not None
    payload = json.loads(msg["data"].decode())
    assert payload == {
        "op": "voice_override",
        "channel_id": "987654321",
        "user_id": "99",
        "muted": True,
        "deafened": False,
    }
    await pubsub.unsubscribe("voice:events")
    await pubsub.aclose()


@pytest.mark.asyncio
async def test_deafen_requires_deafen_members_perm(
    app_with_redis, auth_signer, monkeypatch
):
    """MUTE_MEMBERS alone is not enough — deafen needs its own bit."""
    client, _redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_MUTE_MEMBERS),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"deafen": True},
        headers=auth(access),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_deafen_only_does_not_touch_livekit_mute_path(
    app_with_redis, auth_signer, monkeypatch, _stub_livekit_update
):
    """Deafen is client-side; the live LiveKit permission call shouldn't
    fire when only ``deafen`` is patched (a stray live call would risk
    overriding the user's actual publish grant)."""
    client, _redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_DEAFEN_MEMBERS),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"deafen": True},
        headers=auth(access),
    )
    assert r.status_code == 200
    assert r.json() == {"muted": False, "deafened": True}
    assert _stub_livekit_update == []  # no LiveKit calls


@pytest.mark.asyncio
async def test_mute_and_deafen_combined_in_one_patch(
    app_with_redis, auth_signer, monkeypatch
):
    """Single PUT can set both fields when the caller holds both bits."""
    client, redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(
            _PERM_CONNECT | _PERM_MUTE_MEMBERS | _PERM_DEAFEN_MEMBERS
        ),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"mute": True, "deafen": True},
        headers=auth(access),
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {"muted": True, "deafened": True}
    raw = await redis.get("voice:override:channel-987654321:user-99")
    state = json.loads(raw.decode())
    assert state == {"muted": True, "deafened": True}


@pytest.mark.asyncio
async def test_partial_update_preserves_other_field(
    app_with_redis, auth_signer, monkeypatch
):
    """Toggling deafen without touching mute leaves the existing mute
    state intact (merge semantics)."""
    client, redis = app_with_redis
    # Pre-seed: muted but not deafened.
    await redis.set(
        "voice:override:channel-987654321:user-99",
        json.dumps({"muted": True, "deafened": False}),
    )
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_DEAFEN_MEMBERS),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"deafen": True},
        headers=auth(access),
    )
    assert r.status_code == 200
    assert r.json() == {"muted": True, "deafened": True}


@pytest.mark.asyncio
async def test_empty_patch_is_400(app_with_redis, auth_signer, monkeypatch):
    client, _redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_MUTE_MEMBERS),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={},
        headers=auth(access),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_unmute_clears_redis_when_no_other_flags(
    app_with_redis, auth_signer, monkeypatch
):
    client, redis = app_with_redis
    # Pre-seed an override so unmute has something to clear.
    await redis.set(
        "voice:override:channel-987654321:user-99",
        json.dumps({"muted": True}),
    )
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request",
        _make_voice_channel_mock(_PERM_CONNECT | _PERM_MUTE_MEMBERS),
    )
    access = auth_signer.issue_access(42, "alice")
    r = await client.put(
        "/channels/987654321/members/99/voice-override",
        json={"mute": False},
        headers=auth(access),
    )
    assert r.status_code == 200
    assert await redis.get("voice:override:channel-987654321:user-99") is None


@pytest.mark.asyncio
async def test_token_respects_override(app_with_redis, auth_signer, monkeypatch):
    """If an override is in Redis, the next token-issue omits microphone."""
    client, redis = app_with_redis
    # User 99 is force-muted.
    await redis.set(
        "voice:override:channel-987654321:user-99",
        json.dumps({"muted": True}),
    )
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    full_perms = _PERM_CONNECT | _PERM_SPEAK | _PERM_USE_VIDEO | _PERM_STREAM
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request", _make_voice_channel_mock(full_perms)
    )
    access = auth_signer.issue_access(99, "muted_user")
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 200, r.text
    # Decode the grants without verifying.
    import base64
    body = r.json()["token"].split(".")[1]
    body += "=" * ((4 - len(body) % 4) % 4)
    grants = json.loads(base64.urlsafe_b64decode(body)).get("video", {})
    sources = grants.get("canPublishSources") or []
    assert "microphone" not in sources
    assert "camera" in sources
    assert "screen_share" in sources


@pytest.mark.asyncio
async def test_token_without_override_grants_microphone(
    app_with_redis, auth_signer, monkeypatch
):
    client, _redis = app_with_redis
    monkeypatch.setattr(
        voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test"
    )
    full_perms = _PERM_CONNECT | _PERM_SPEAK | _PERM_USE_VIDEO | _PERM_STREAM
    monkeypatch.setattr(
        voice_routes, "_chat_gateway_request", _make_voice_channel_mock(full_perms)
    )
    access = auth_signer.issue_access(99, "unmuted")
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 200
    import base64
    body = r.json()["token"].split(".")[1]
    body += "=" * ((4 - len(body) % 4) % 4)
    grants = json.loads(base64.urlsafe_b64decode(body)).get("video", {})
    sources = grants.get("canPublishSources") or []
    assert "microphone" in sources
