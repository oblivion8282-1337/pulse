"""Bughunt 2026-09-20 (Runde 2): ``GET /internal/channels/{id}/voice-limit``.

voice-signaling fragt über diese Route das Benutzerlimit nach, um Gäste
nicht mehr nur am Ticket-Mint (bis zu 4 h früher) zu begrenzen. Hier:
Auth-Postur (401 ohne/falsches Secret, 401 wenn Server-Secret leer) und
die Grenzwerte selbst."""

from __future__ import annotations

import pytest
import pytest_asyncio

_TEST_SECRET = "test-internal-secret-do-not-leak"


def _headers(secret: str) -> dict[str, str]:
    return {"X-Pulse-Internal-Secret": secret}


@pytest_asyncio.fixture
async def _internal_secret_set(_isolate_chat_settings):
    original = _isolate_chat_settings.internal_service_secret
    _isolate_chat_settings.internal_service_secret = _TEST_SECRET
    yield _TEST_SECRET
    _isolate_chat_settings.internal_service_secret = original


@pytest.mark.asyncio
async def test_voice_limit_braucht_secret(client):
    r = await client.get("/internal/channels/555/voice-limit")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_voice_limit_liefert_grenze(
    client, session_factory, _auth_signer, _internal_secret_set
):
    from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
    from dcc_chat_gateway.snowflake import next_id

    t_owner, _ = await _register_owner(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth_h(t_owner))
    ).json()
    chan_id = next_id()
    async with session_factory() as s:
        s.add(Channel(
            id=chan_id, guild_id=int(g["id"]), name="voice",
            type=CHANNEL_TYPE_VOICE, user_limit=7,
        ))
        await s.commit()

    r = await client.get(
        f"/internal/channels/{chan_id}/voice-limit", headers=_headers(_TEST_SECRET)
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"user_limit": 7}

    # Unbekannter Kanal → 404 (fail-closed für den Nachfrager).
    r2 = await client.get(
        "/internal/channels/123456/voice-limit", headers=_headers(_TEST_SECRET)
    )
    assert r2.status_code == 404


def _auth_h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_owner(_auth_signer):
    import random

    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid
