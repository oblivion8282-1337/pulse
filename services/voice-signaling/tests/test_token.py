"""Tests for the /token endpoint."""

from __future__ import annotations

import httpx
import jwt
import pytest

import dcc_voice_signaling.routes as voice_routes


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_token_requires_auth(client):
    r = await client.post("/token", json={"channel_id": "12345"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_token_happy_path(client, auth_signer):
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["room"] == "channel-987654321"
    assert body["ws_url"] == "ws://livekit.test:7880"
    assert body["token"].count(".") == 2

    # Decode the LiveKit token to verify the grants — we know the secret.
    payload = jwt.decode(
        body["token"],
        "testsecrettestsecrettestsecrettestsecret",
        algorithms=["HS256"],
        options={"verify_aud": False},
    )
    assert payload["sub"] == "user-42"
    assert payload["video"]["room"] == "channel-987654321"
    assert payload["video"]["roomJoin"] is True


@pytest.mark.asyncio
async def test_token_rejects_invalid_kind(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    r = await client.post(
        "/token",
        json={"channel_id": "1", "kind": "video"},
        headers=auth(access),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_token_rejects_unknown_field(client, auth_signer):
    access = auth_signer.issue_access(7, "bob")
    r = await client.post(
        "/token",
        json={"channel_id": "1", "leakField": "x"},
        headers=auth(access),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_token_requires_channel_membership(client, auth_signer, monkeypatch):
    """With ``CHAT_GATEWAY_URL`` configured, the route must consult chat-gateway
    and reject non-members. We monkeypatch ``_chat_gateway_request`` to avoid
    actually hitting the network."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")

    async def _forbidden(method, path, *, bearer):
        return httpx.Response(403, json={"detail": "not a member"})

    monkeypatch.setattr(voice_routes, "_chat_gateway_request", _forbidden)
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_token_rejects_non_voice_channel(client, auth_signer, monkeypatch):
    """chat-gateway returns 200 for a text channel — the route must reject it."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")

    async def _text_channel(method, path, *, bearer):
        return httpx.Response(200, json={"id": "1", "guild_id": "1", "type": 0})

    monkeypatch.setattr(voice_routes, "_chat_gateway_request", _text_channel)
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/token",
        json={"channel_id": "1"},
        headers=auth(access),
    )
    assert r.status_code == 400


def _make_gateway_mock(perms_bf: int):
    """Build a chat-gateway request mock that answers the two endpoints
    voice-signaling expects:
      * GET /channels/{id}       → voice channel
      * GET /channels/{id}/permissions/me → ``perms_bf`` as string
    """
    async def _mock(method, path, *, bearer):
        if path.endswith("/permissions/me"):
            return httpx.Response(200, json={"permissions": str(perms_bf)})
        return httpx.Response(200, json={"id": "987654321", "guild_id": "1", "type": 1})
    return _mock


def _decode_grants(token: str) -> dict:
    """LiveKit access-tokens are unsigned to us — decode without verifying
    (the test only inspects the embedded grants)."""
    import base64
    import json

    body = token.split(".")[1]
    body += "=" * ((4 - len(body) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(body))
    return payload.get("video", {})


@pytest.mark.asyncio
async def test_token_passes_with_voice_channel(client, auth_signer, monkeypatch):
    """Happy path: chat-gateway confirms voice channel membership."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")

    # Full publish perms — SPEAK + USE_VIDEO + STREAM all set.
    perms = (1 << 31) | (1 << 32) | (1 << 33)
    monkeypatch.setattr(voice_routes, "_chat_gateway_request", _make_gateway_mock(perms))
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 200, r.text
    grants = _decode_grants(r.json()["token"])
    assert grants.get("canPublish") is True
    sources = grants.get("canPublishSources") or []
    assert "microphone" in sources
    assert "camera" in sources
    assert "screen_share" in sources


@pytest.mark.asyncio
async def test_token_microphone_only_when_no_video_perm(
    client, auth_signer, monkeypatch
):
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")
    perms = 1 << 31  # SPEAK only
    monkeypatch.setattr(voice_routes, "_chat_gateway_request", _make_gateway_mock(perms))
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(auth_signer.issue_access(42, "alice")),
    )
    assert r.status_code == 200
    grants = _decode_grants(r.json()["token"])
    sources = grants.get("canPublishSources") or []
    assert sources == ["microphone"]


@pytest.mark.asyncio
async def test_token_subscribe_only_when_no_publish_perms(
    client, auth_signer, monkeypatch
):
    """No SPEAK / USE_VIDEO / STREAM → token grants no publish at all.
    Subscribe is always on."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")
    monkeypatch.setattr(voice_routes, "_chat_gateway_request", _make_gateway_mock(0))
    r = await client.post(
        "/token",
        json={"channel_id": "987654321"},
        headers=auth(auth_signer.issue_access(42, "alice")),
    )
    assert r.status_code == 200
    grants = _decode_grants(r.json()["token"])
    # canPublish gets serialised when False (Pydantic-style) — present
    # as ``False`` (proto3 strips defaults though; absent == False).
    assert not grants.get("canPublish", False)
    assert grants.get("canSubscribe", True) is True
