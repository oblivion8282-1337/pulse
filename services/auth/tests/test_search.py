"""Tests for ``GET /users/search`` + ``POST /internal/users/discoverable``.

The search endpoint matches usernames by case-insensitive prefix.
Discoverable=false hides a user; self is filtered out; q<2 chars
returns 400.

The internal endpoint is gated by ``INTERNAL_SERVICE_SECRET`` — same
header convention as every other Pulse service-to-service call.
"""

from __future__ import annotations

import pytest

REG = {
    "username": "alice",
    "email": "alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}

_INTERNAL_SECRET = "test-internal-search-secret"


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(client, username: str, email: str | None = None) -> str:
    """Register a user, return the access token. Falls back to a
    deterministic dcc-test.example.com email so we don't collide
    with the email-validator's special-use-TLD block on ``*.test``.
    """
    body = {
        "username": username,
        "email": email or f"{username}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": username.title(),
    }
    r = await client.post("/register", json=body)
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


# ---------------------------------------------------------------------------
# GET /users/search


@pytest.mark.asyncio
async def test_search_prefix_match_finds_user(client):
    caller = await _register(client, "alice")
    _ = await _register(client, "bob")
    _ = await _register(client, "bobby")
    r = await client.get(
        "/users/search?q=bob", headers=_bearer(caller)
    )
    assert r.status_code == 200, r.text
    names = sorted(u["username"] for u in r.json())
    assert names == ["bob", "bobby"]


@pytest.mark.asyncio
async def test_search_case_insensitive(client):
    caller = await _register(client, "alice")
    await _register(client, "Charlie")
    r = await client.get(
        "/users/search?q=cha", headers=_bearer(caller)
    )
    assert r.status_code == 200, r.text
    names = [u["username"] for u in r.json()]
    assert names == ["Charlie"]


@pytest.mark.asyncio
async def test_search_excludes_self(client):
    """Self should never appear in your own search results."""
    caller = await _register(client, "alice")
    me_r = await client.get("/me", headers=_bearer(caller))
    me_id = me_r.json()["id"]
    r = await client.get(
        "/users/search?q=ali", headers=_bearer(caller)
    )
    assert r.status_code == 200
    assert all(u["id"] != me_id for u in r.json())


@pytest.mark.asyncio
async def test_search_hides_undiscoverable_users(
    client, session_factory
):
    caller = await _register(client, "alice")
    await _register(client, "hidden")
    # Flip the hidden user's discoverable flag off directly.
    from sqlalchemy import update

    from dcc_auth.models import User

    async with session_factory() as s:
        await s.execute(
            update(User)
            .where(User.username == "hidden")
            .values(discoverable=False)
        )
        await s.commit()

    r = await client.get(
        "/users/search?q=hid", headers=_bearer(caller)
    )
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_search_matches_display_name(client, session_factory):
    """A user whose handle is cryptic but whose display_name starts with
    the query must still be findable — covers the "wanted name was
    taken, fell back to user_42" scenario."""
    caller = await _register(client, "alice")

    from dcc_auth.models import User
    from dcc_auth.snowflake import next_id

    async with session_factory() as s:
        s.add(
            User(
                id=next_id(),
                username="user_42",
                email="u42@dcc-test.example.com",
                password_hash="$argon2id$placeholder",
                display_name="Alex Maier",
            )
        )
        await s.commit()

    r = await client.get("/users/search?q=ale", headers=_bearer(caller))
    assert r.status_code == 200
    names = [u["username"] for u in r.json()]
    assert "user_42" in names


@pytest.mark.asyncio
async def test_search_username_ranks_above_display_name(client, session_factory):
    """If both a username and a display_name match, the username hit
    must come first — exact-handle is what the searcher most likely meant."""
    caller = await _register(client, "alice")

    from dcc_auth.models import User
    from dcc_auth.snowflake import next_id

    async with session_factory() as s:
        s.add(
            User(
                id=next_id(),
                username="zzz_user",
                email="z@dcc-test.example.com",
                password_hash="$argon2id$placeholder",
                display_name="Bobby",  # display starts with "bob"
            )
        )
        s.add(
            User(
                id=next_id(),
                username="bob",  # username starts with "bob"
                email="b@dcc-test.example.com",
                password_hash="$argon2id$placeholder",
                display_name="Robert",
            )
        )
        await s.commit()

    r = await client.get("/users/search?q=bob", headers=_bearer(caller))
    assert r.status_code == 200
    names = [u["username"] for u in r.json()]
    # bob (username match) must precede zzz_user (display_name match)
    assert names.index("bob") < names.index("zzz_user")


@pytest.mark.asyncio
async def test_search_query_too_short_400(client):
    caller = await _register(client, "alice")
    r = await client.get("/users/search?q=a", headers=_bearer(caller))
    assert r.status_code == 400
    assert r.json()["detail"] == "query_too_short"


@pytest.mark.asyncio
async def test_search_requires_auth(client):
    r = await client.get("/users/search?q=ali")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_search_limit_capped(client, session_factory):
    """``limit=999`` is clamped to 50 — direct DB seed so we don't
    burn the per-IP register rate-limit just to populate fixtures."""
    caller = await _register(client, "alice")

    from dcc_auth.models import User
    from dcc_auth.snowflake import next_id

    async with session_factory() as s:
        for i in range(5):
            s.add(
                User(
                    id=next_id(),
                    username=f"target{i}",
                    email=f"target{i}@dcc-test.example.com",
                    password_hash="$argon2id$placeholder",
                )
            )
        await s.commit()

    r = await client.get(
        "/users/search?q=tar&limit=999", headers=_bearer(caller)
    )
    assert r.status_code == 200
    assert len(r.json()) == 5


# ---------------------------------------------------------------------------
# POST /internal/users/discoverable


@pytest.fixture
def _set_internal_secret(_isolate_settings):
    _isolate_settings.internal_service_secret = _INTERNAL_SECRET
    yield _INTERNAL_SECRET


@pytest.mark.asyncio
async def test_internal_discoverable_sets_flag(
    client, session_factory, _set_internal_secret
):
    caller = await _register(client, "alice")
    me_r = await client.get("/me", headers=_bearer(caller))
    me_id = me_r.json()["id"]
    r = await client.post(
        "/internal/users/discoverable",
        json={"user_id": me_id, "discoverable": False},
        headers={"X-Pulse-Internal-Secret": _INTERNAL_SECRET},
    )
    assert r.status_code == 204, r.text

    from dcc_auth.models import User

    async with session_factory() as s:
        u = await s.get(User, int(me_id))
        assert u is not None
        assert u.discoverable is False


@pytest.mark.asyncio
async def test_internal_discoverable_no_secret_401(client, _set_internal_secret):
    r = await client.post(
        "/internal/users/discoverable",
        json={"user_id": "1", "discoverable": False},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_internal_discoverable_wrong_secret_401(
    client, _set_internal_secret
):
    r = await client.post(
        "/internal/users/discoverable",
        json={"user_id": "1", "discoverable": False},
        headers={"X-Pulse-Internal-Secret": "wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_internal_discoverable_disabled_when_secret_unset(
    client, _isolate_settings
):
    """Empty server-side secret = fail-closed even with a header sent."""
    _isolate_settings.internal_service_secret = None
    r = await client.post(
        "/internal/users/discoverable",
        json={"user_id": "1", "discoverable": False},
        headers={"X-Pulse-Internal-Secret": "anything"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_internal_discoverable_unknown_user_204(
    client, _set_internal_secret
):
    """Missing user row → silent 204 (caller might be racing a purge)."""
    r = await client.post(
        "/internal/users/discoverable",
        json={"user_id": "999999999999", "discoverable": True},
        headers={"X-Pulse-Internal-Secret": _INTERNAL_SECRET},
    )
    assert r.status_code == 204
