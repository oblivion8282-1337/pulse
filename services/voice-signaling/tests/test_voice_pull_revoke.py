"""voice-signaling-Seite des Voice-Pull-Revoke-Kreises.

Verifiziert, dass ``_maybe_revoke_voice_pull`` bei gesetztem Redis-Marker
den internen chat-gateway-Endpoint mit Secret + korrektem Body aufruft
(fire-and-forget) und dass der Webhook ihn bei ``participant_left``
triggert (bei ``participant_joined`` nicht).
"""

from __future__ import annotations

import os

import dcc_voice_signaling.routes.chat_gateway as cg
import pytest
import pytest_asyncio
from dcc_voice_signaling.routes.chat_gateway import _maybe_revoke_voice_pull

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")
_MARKER = "voice_pull:channel-{cid}:user-{uid}"


class _FakeResp:
    def __init__(self, status_code: int = 200) -> None:
        self.status_code = status_code


class _FakeClient:
    def __init__(self, status_code: int = 200) -> None:
        self.posts: list[tuple[str, dict, dict]] = []
        self._status = status_code

    async def post(self, url: str, json=None, headers=None):  # noqa: A002
        self.posts.append((url, json or {}, headers or {}))
        return _FakeResp(self._status)


@pytest_asyncio.fixture
async def redis():
    from redis.asyncio import Redis

    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    # Marker-Leak zwischen den Tests vermeiden (gleicher cid/uid-Raum).
    await r.flushdb()
    await r.aclose()


# ---- Helper direkt --------------------------------------------------------


@pytest.mark.asyncio
async def test_posts_revoke_when_marker_present(redis, _isolate_voice_settings, monkeypatch):
    await redis.set(_MARKER.format(cid="123", uid="456"), b"1")
    _isolate_voice_settings.chat_gateway_url = "http://chat.test"
    _isolate_voice_settings.internal_service_secret = "s"
    fake = _FakeClient()
    monkeypatch.setattr(cg, "_http_client", fake)

    await _maybe_revoke_voice_pull(redis, "123", "456")

    assert len(fake.posts) == 1
    url, body, headers = fake.posts[0]
    assert url == "http://chat.test/internal/voice-pull-revoke"
    assert body == {"channel_id": 123, "user_id": 456}
    assert headers["X-Pulse-Internal-Secret"] == "s"


@pytest.mark.asyncio
async def test_noop_without_marker(redis, _isolate_voice_settings, monkeypatch):
    _isolate_voice_settings.chat_gateway_url = "http://chat.test"
    _isolate_voice_settings.internal_service_secret = "s"
    fake = _FakeClient()
    monkeypatch.setattr(cg, "_http_client", fake)

    await _maybe_revoke_voice_pull(redis, "123", "456")
    assert fake.posts == []


@pytest.mark.asyncio
async def test_noop_without_settings_or_secret(redis, _isolate_voice_settings, monkeypatch):
    """Kein chat_gateway_url ODER kein Secret → kein Call (dev/no-voice)."""
    await redis.set(_MARKER.format(cid="1", uid="2"), b"1")
    fake = _FakeClient()
    monkeypatch.setattr(cg, "_http_client", fake)

    _isolate_voice_settings.chat_gateway_url = None
    _isolate_voice_settings.internal_service_secret = "s"
    await _maybe_revoke_voice_pull(redis, "1", "2")
    _isolate_voice_settings.chat_gateway_url = "http://chat.test"
    _isolate_voice_settings.internal_service_secret = ""
    await _maybe_revoke_voice_pull(redis, "1", "2")
    assert fake.posts == []


# ---- Webhook-Integration --------------------------------------------------
# wohnt in test_webhook.py (dort ist das webhook_client-Fixture definiert).
