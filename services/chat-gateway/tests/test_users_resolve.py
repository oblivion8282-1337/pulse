"""Tests for GET /users?ids=… — numeric-id → profile resolution (F19).

Self-Host frontends resolve member display names against this endpoint instead
of the Cloud auth-svc (which doesn't know the per-instance synthetic ids).

Coverage:
1. No auth → 401
2. Known synthetic ids → UserSummary shape
3. Unknown ids omitted
4. Non-numeric ids filtered out
"""

from __future__ import annotations

import random
from datetime import datetime, timezone

import pytest


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _uid() -> int:
    return random.randint(100_000, 999_999)


async def _register(signer, uid: int | None = None, username: str | None = None) -> tuple[str, int]:
    uid = uid or _uid()
    token = signer.issue_access(uid, username or f"user{uid}")
    return token, uid


async def _seed(
    session_factory,
    user_identifier,
    synthetic_user_id,
    username,
    display_name,
    avatar_hash=None,
):
    from dcc_chat_gateway.models.moderation import CachedUserProfile

    async with session_factory() as session:
        session.add(
            CachedUserProfile(
                user_identifier=user_identifier,
                synthetic_user_id=synthetic_user_id,
                username=username,
                display_name=display_name,
                avatar_hash=avatar_hash,
                last_statement_iat=datetime.now(tz=timezone.utc),
                stale=False,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_requires_auth(client):
    r = await client.get("/users", params={"ids": "111"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_resolves_known_ids_to_user_summary(client, _auth_signer, session_factory):
    token, _ = await _register(_auth_signer)
    await _seed(session_factory, "pw-dev", 1645520347282241315, "dev", "Dev Display")

    r = await client.get(
        "/users", params={"ids": "1645520347282241315"}, headers=_auth(token)
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data) == 1
    # Matches the frontend UserSummary shape exactly.
    assert data[0] == {
        "id": "1645520347282241315",
        "username": "dev",
        "display_name": "Dev Display",
        "avatar_url": None,
    }


@pytest.mark.asyncio
async def test_avatar_hash_resolves_to_cloud_by_hash_url(
    client, _auth_signer, session_factory
):
    """An ``avatar_hash`` resolves to the Cloud content-addressed avatar URL —
    keyed by hash, never by the user's Cloud id (pairwise-sub privacy)."""
    from dcc_chat_gateway.config import get_settings

    token, _ = await _register(_auth_signer)
    h = "a" * 64
    await _seed(session_factory, "pw-av", 222, "ava", "Ava", avatar_hash=h)

    r = await client.get("/users", params={"ids": "222"}, headers=_auth(token))
    assert r.status_code == 200, r.text
    origin = get_settings().pulse_cloud_origin.rstrip("/")
    assert r.json()[0]["avatar_url"] == f"{origin}/api/auth/avatars/by-hash/{h}.webp"


@pytest.mark.asyncio
async def test_unknown_ids_omitted(client, _auth_signer, session_factory):
    token, _ = await _register(_auth_signer)
    await _seed(session_factory, "pw-a", 111, "alice", "Alice")

    r = await client.get("/users", params={"ids": "111,999999"}, headers=_auth(token))
    assert r.status_code == 200
    assert [u["id"] for u in r.json()] == ["111"]


@pytest.mark.asyncio
async def test_non_numeric_ids_filtered(client, _auth_signer, session_factory):
    token, _ = await _register(_auth_signer)
    await _seed(session_factory, "pw-b", 222, "bob", "Bob")

    r = await client.get("/users", params={"ids": "abc,222,"}, headers=_auth(token))
    assert r.status_code == 200
    assert [u["id"] for u in r.json()] == ["222"]


@pytest.mark.asyncio
async def test_empty_ids_returns_empty(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    r = await client.get("/users", params={"ids": "abc,,"}, headers=_auth(token))
    assert r.status_code == 200
    assert r.json() == []
