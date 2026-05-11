"""Tests for the /token endpoint."""

from __future__ import annotations

import jwt
import pytest


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
