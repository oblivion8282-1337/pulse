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
async def test_create_report_body_optional(client, _auth_signer):
    """The free-text body is optional — the reason_code carries the category.
    A short body, or none at all, is accepted."""
    token, _ = await _token(_auth_signer)
    short = await client.post(
        "/reports",
        json={"target_user_id": "111", "reason_code": "other", "body": "spam"},
        headers=auth(token),
    )
    assert short.status_code == 201, short.text

    none = await client.post(
        "/reports",
        json={"target_user_id": "112", "reason_code": "spam"},
        headers=auth(token),
    )
    assert none.status_code == 201, none.text


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


# ---------------------------------------------------------------------------
# POST /operator-reports — DM report with server-side authoritative snapshot
# ---------------------------------------------------------------------------


async def _seed_dm_message(session_factory, author_id, other_id, *,
                           content="hi", with_image=False):
    from dcc_chat_gateway.models import (
        DirectMessageChannel,
        Message,
        MessageAttachment,
    )
    from dcc_chat_gateway.snowflake import next_id as _nid

    a, b = sorted((author_id, other_id))
    dm_id, msg_id = _nid(), _nid()
    async with session_factory() as s:
        s.add(DirectMessageChannel(id=dm_id, user_a_id=a, user_b_id=b))
        s.add(Message(id=msg_id, channel_id=dm_id, author_id=author_id, content=content))
        if with_image:
            s.add(MessageAttachment(
                id=_nid(), message_id=msg_id, channel_id=dm_id,
                uploader_id=author_id, storage_key=f"k{msg_id}",
                mime="image/png", size=123,
            ))
        await s.commit()
    return msg_id


@pytest.mark.asyncio
async def test_operator_report_snapshots_text_server_side(
    client, _auth_signer, session_factory, monkeypatch
):
    from dcc_chat_gateway.routes import reports as _r

    calls = []

    async def _fake(body, target_user_id, submitter_user_id=None):
        calls.append((body, target_user_id, submitter_user_id))
        return "42"

    monkeypatch.setattr(_r, "escalate_report_to_operator", _fake)

    t_reporter, uid_reporter = await _token(_auth_signer)
    uid_author = _uid()
    msg_id = await _seed_dm_message(
        session_factory, uid_author, uid_reporter, content="du bist bloed"
    )
    r = await client.post(
        "/operator-reports",
        json={"target_message_id": str(msg_id), "reason_code": "harassment", "body": "bitte pruefen"},
        headers=auth(t_reporter),
    )
    assert r.status_code == 201, r.text
    assert len(calls) == 1
    body, target, submitter = calls[0]
    assert target == uid_author
    assert submitter == uid_reporter
    assert "du bist bloed" in body   # authoritative message text
    assert "bitte pruefen" in body   # reporter's own description
    assert "Belästigung" in body     # reason label


@pytest.mark.asyncio
async def test_operator_report_withholds_image(
    client, _auth_signer, session_factory, monkeypatch
):
    from dcc_chat_gateway.routes import reports as _r

    calls = []

    async def _fake(body, target_user_id, submitter_user_id=None):
        calls.append(body)
        return "1"

    monkeypatch.setattr(_r, "escalate_report_to_operator", _fake)

    t_reporter, uid_reporter = await _token(_auth_signer)
    msg_id = await _seed_dm_message(
        session_factory, _uid(), uid_reporter, content="", with_image=True
    )
    r = await client.post(
        "/operator-reports",
        json={"target_message_id": str(msg_id), "reason_code": "csam", "body": ""},
        headers=auth(t_reporter),
    )
    assert r.status_code == 201, r.text
    body = calls[0]
    assert "nicht angezeigt" in body   # image withheld, only noted
    assert "(kein Text)" in body       # no text content


@pytest.mark.asyncio
async def test_operator_report_non_participant_403(
    client, _auth_signer, session_factory, monkeypatch
):
    from dcc_chat_gateway.routes import reports as _r

    async def _fake(*a, **k):
        return "1"

    monkeypatch.setattr(_r, "escalate_report_to_operator", _fake)

    msg_id = await _seed_dm_message(session_factory, _uid(), _uid(), content="hi")
    t_stranger, _ = await _token(_auth_signer)
    r = await client.post(
        "/operator-reports",
        json={"target_message_id": str(msg_id), "reason_code": "spam", "body": ""},
        headers=auth(t_stranger),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_operator_report_message_not_found_404(client, _auth_signer):
    t, _ = await _token(_auth_signer)
    r = await client.post(
        "/operator-reports",
        json={"target_message_id": "999888777", "reason_code": "spam", "body": ""},
        headers=auth(t),
    )
    assert r.status_code == 404
