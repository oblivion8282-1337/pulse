"""Tests for POST /reports."""

from __future__ import annotations

import random

import pytest

import dcc_chat_gateway.ratelimit as _rl


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _uid() -> int:
    return random.randint(1, 1_000_000)


async def _token(signer) -> tuple[str, int]:
    uid = _uid()
    return signer.issue_access(uid, f"user{uid}"), uid


# ---------------------------------------------------------------------------
# Unauthenticated
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_report_requires_auth(client):
    r = await client.post(
        "/reports",
        json={
            "target_user_id": "123456789",
            "reason_code": "spam",
            "body": "This user is spamming the channel repeatedly.",
        },
    )
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_report_happy_path(client, _auth_signer):
    token, uid = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_user_id": "99999",
            "reason_code": "harassment",
            "body": "This user has been harassing me in voice channels repeatedly.",
        },
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert "id" in body
    assert body["status"] == "received"


@pytest.mark.asyncio
async def test_create_report_with_message_target(client, _auth_signer):
    token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_message_id": "888777666555",
            "target_channel_id": "111222333444",
            "reason_code": "illegal",
            "body": "This message contains illegal content that must be reviewed.",
        },
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "received"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_report_empty_targets_422(client, _auth_signer):
    """All three targets are None → 422."""
    token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={"reason_code": "spam", "body": "Spamming everywhere all the time."},
        headers=auth(token),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_report_body_too_short_422(client, _auth_signer):
    token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_user_id": "111",
            "reason_code": "other",
            "body": "short",  # < 10 chars
        },
        headers=auth(token),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_report_invalid_reason_code_422(client, _auth_signer):
    token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_user_id": "111",
            "reason_code": "unknown_code",
            "body": "Some report body that is long enough to pass validation.",
        },
        headers=auth(token),
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_report_rate_limit(client, _auth_signer):
    """11th report in the same hour must be 429."""
    _rl.reset()
    token, uid = await _token(_auth_signer)
    payload = {
        "target_user_id": "99999",
        "reason_code": "spam",
        "body": "This user is spamming the channel again and again right now.",
    }
    for _ in range(10):
        r = await client.post("/reports", json=payload, headers=auth(token))
        assert r.status_code == 201, r.text
    r = await client.post("/reports", json=payload, headers=auth(token))
    assert r.status_code == 429


# ---------------------------------------------------------------------------
# Reporter receives the report id
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Live-push: report_new fan-out to moderators
# ---------------------------------------------------------------------------


async def _make_guild_with_channel(client, owner_token: str) -> tuple[str, str]:
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=auth(owner_token))
    ).json()
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(owner_token),
        )
    ).json()
    return g["id"], ch["id"]


@pytest.mark.asyncio
async def test_create_report_publishes_report_new(client, app, _auth_signer):
    """A channel-target report publishes exactly one report_new envelope for
    the owning guild — carrying reason_code but no PII (no body)."""
    owner_token, _ = await _token(_auth_signer)
    guild_id, channel_id = await _make_guild_with_channel(client, owner_token)

    # Install the capture only AFTER setup so guild/channel creation events
    # (channel_created etc.) don't pollute the assertion.
    events: list = []

    async def _capture(env):
        events.append(env)

    app.state.connection_manager.publish_guild_event = _capture

    reporter_token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_channel_id": channel_id,
            "reason_code": "spam",
            "body": "This channel is being used to spam the whole community.",
        },
        headers=auth(reporter_token),
    )
    assert r.status_code == 201, r.text

    assert len(events) == 1
    payload = events[0].model_dump()
    assert payload["op"] == "report_new"
    assert payload["guild_id"] == guild_id
    assert payload["reason_code"] == "spam"
    assert payload["report_id"] == r.json()["id"]
    # No PII on the wire — the report body must never be pushed.
    assert "body" not in payload


@pytest.mark.asyncio
async def test_create_report_no_guild_no_publish(client, app, _auth_signer):
    """A report whose target maps to no guild (user not a member anywhere)
    publishes nothing."""
    events: list = []

    async def _capture(env):
        events.append(env)

    app.state.connection_manager.publish_guild_event = _capture

    reporter_token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_user_id": "424242424242",
            "reason_code": "harassment",
            "body": "This user has no shared community with any moderator here.",
        },
        headers=auth(reporter_token),
    )
    assert r.status_code == 201, r.text
    assert events == []


@pytest.mark.asyncio
async def test_create_report_returns_id(client, _auth_signer):
    token, _ = await _token(_auth_signer)
    r = await client.post(
        "/reports",
        json={
            "target_channel_id": "777888999000",
            "reason_code": "csam",
            "body": "There is illegal content posted in this channel right now.",
        },
        headers=auth(token),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["id"].isdigit()
    assert int(body["id"]) > 0
