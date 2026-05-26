"""Tests for GET /guilds/{id}/mention-candidates (Phase 3.2 / Plan §P.14).

Coverage:
1. Non-member → 403
2. Missing ``q`` param → 422 (FastAPI built-in)
3. Prefix-match returns sorted, limited results
4. Username update is reflected in next search (cache is live)
5. Empty result set for unmatched prefix
6. Limit of 20 results enforced
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
    uname = username or f"user{uid}"
    token = signer.issue_access(uid, uname)
    return token, uid


async def _make_guild(client, signer) -> tuple[str, int, int]:
    """Create a guild with one owner.  Returns (token, user_id, guild_id)."""
    token, uid = await _register(signer)
    r = await client.post("/guilds", json={"name": "testguild"}, headers=_auth(token))
    assert r.status_code in (200, 201)
    guild_id = int(r.json()["id"])
    return token, uid, guild_id


async def _seed_profile(session_factory, user_identifier: str, username: str, display_name: str):
    """Directly insert a CachedUserProfile row (bypasses JWT validation)."""
    from dcc_chat_gateway.models.moderation import CachedUserProfile

    async with session_factory() as session:
        existing = await session.get(CachedUserProfile, user_identifier)
        if existing is not None:
            existing.username = username
            existing.display_name = display_name
            existing.last_statement_iat = datetime.now(tz=timezone.utc)
            session.add(existing)
        else:
            session.add(
                CachedUserProfile(
                    user_identifier=user_identifier,
                    username=username,
                    display_name=display_name,
                    last_statement_iat=datetime.now(tz=timezone.utc),
                    stale=False,
                )
            )
        await session.commit()


# ─── Tests ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_non_member_gets_403(client, _auth_signer):
    token, uid, guild_id = await _make_guild(client, _auth_signer)
    other_token, _ = await _register(_auth_signer)
    r = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        params={"q": "ali"},
        headers=_auth(other_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_missing_q_gets_422(client, _auth_signer):
    token, uid, guild_id = await _make_guild(client, _auth_signer)
    r = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        headers=_auth(token),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_prefix_match_returns_sorted_results(client, _auth_signer, session_factory):
    token, uid, guild_id = await _make_guild(client, _auth_signer)

    await _seed_profile(session_factory, "id-alice", "alice", "Alice Smith")
    await _seed_profile(session_factory, "id-albert", "albert", "Albert Brown")
    await _seed_profile(session_factory, "id-bob", "bob", "Bob Jones")

    r = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        params={"q": "al"},
        headers=_auth(token),
    )
    assert r.status_code == 200
    names = [e["username"] for e in r.json()]
    # Both alice and albert match; bob does not
    assert "bob" not in names
    assert "alice" in names
    assert "albert" in names
    # Sorted ascending by username
    assert names == sorted(names)


@pytest.mark.asyncio
async def test_no_match_returns_empty_list(client, _auth_signer, session_factory):
    token, uid, guild_id = await _make_guild(client, _auth_signer)
    await _seed_profile(session_factory, "id-charlie", "charlie", "Charlie")

    r = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        params={"q": "xyz"},
        headers=_auth(token),
    )
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_updated_username_reflected_in_next_search(client, _auth_signer, session_factory):
    token, uid, guild_id = await _make_guild(client, _auth_signer)
    await _seed_profile(session_factory, "id-diana", "diana", "Diana")

    r = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        params={"q": "di"},
        headers=_auth(token),
    )
    assert any(e["username"] == "diana" for e in r.json())

    # Update the display_name and re-check
    await _seed_profile(session_factory, "id-diana", "diana", "Diana Updated")
    r2 = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        params={"q": "di"},
        headers=_auth(token),
    )
    assert r2.status_code == 200
    entry = next(e for e in r2.json() if e["username"] == "diana")
    assert entry["display_name"] == "Diana Updated"


@pytest.mark.asyncio
async def test_result_limit_enforced(client, _auth_signer, session_factory):
    token, uid, guild_id = await _make_guild(client, _auth_signer)

    # Insert 25 profiles with prefix "zz"
    for i in range(25):
        await _seed_profile(
            session_factory,
            f"id-zz{i:03d}",
            f"zz{i:03d}user",
            f"ZZ User {i}",
        )

    r = await client.get(
        f"/guilds/{guild_id}/mention-candidates",
        params={"q": "zz"},
        headers=_auth(token),
    )
    assert r.status_code == 200
    assert len(r.json()) == 20
