"""Payload-contract tests for the DM + friend web-push fan-out helpers.

These pin the payload shapes the Service Worker + Electron notifier decode.
We capture the dict by stubbing the shared ``_fan_out_payload`` sink so the
test never needs VAPID keys or real subscriptions.
"""

from __future__ import annotations

import pytest

from dcc_chat_gateway import push


@pytest.fixture
def captured(monkeypatch):
    calls: list[tuple[set[int], dict]] = []

    async def _fake(user_ids, payload):
        calls.append((set(user_ids), payload))

    monkeypatch.setattr(push, "_fan_out_payload", _fake)
    return calls


@pytest.mark.asyncio
async def test_dm_push_payload(captured):
    await push.fan_out_dm_push(
        recipient_id=42,
        author_name="alice",
        content="hey <@123> check this out",
        channel_id=999,
        message_id=1000,
    )
    assert len(captured) == 1
    users, payload = captured[0]
    assert users == {42}
    assert payload["type"] == "dm"
    assert payload["title"] == "alice"
    assert payload["channel_id"] == "999"
    assert payload["message_id"] == "1000"
    assert payload["guild_id"] is None  # SW routes to /app/@me/<channel>
    # Mention markers stripped from the preview body.
    assert "<@123>" not in payload["body"]


@pytest.mark.asyncio
async def test_friend_request_push_payload(captured):
    await push.fan_out_friend_push(
        recipient_id=7, actor_name="bob", kind="friend_request"
    )
    users, payload = captured[0]
    assert users == {7}
    assert payload["type"] == "friend_request"
    assert payload["title"] == "bob"
    assert payload["target_url"] == "/app/friends"
    assert "bob" in payload["body"]


@pytest.mark.asyncio
async def test_friend_accept_push_payload(captured):
    await push.fan_out_friend_push(
        recipient_id=8, actor_name="carol", kind="friend_accept"
    )
    _users, payload = captured[0]
    assert payload["type"] == "friend_accept"
    assert payload["target_url"] == "/app/friends"


@pytest.mark.asyncio
async def test_friend_push_unknown_kind_noop(captured):
    await push.fan_out_friend_push(recipient_id=9, actor_name="x", kind="bogus")
    assert captured == []
