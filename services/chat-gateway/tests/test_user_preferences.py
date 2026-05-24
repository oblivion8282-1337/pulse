"""User-preferences REST tests — Plugin-System Schritt 3b.

Coverage:
- GET on empty → ``{}``.
- PUT then GET → round-trip preserves the value + bumps version.
- DELETE then GET → 404 + bulk GET empty for that key.
- 401 without a token.
- Cross-user isolation: user B never sees user A's prefs.
- Invalid section names → 400.
- ``If-Match`` optimistic concurrency: matching → OK, mismatched → 412.
- ``DELETE`` is idempotent (204 even when no row existed).

Pattern cribbed from ``test_privacy.py``: register synthetic users
via the ``_auth_signer`` fixture, issue access tokens, hit the REST
API through the ASGI client.
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway.models import UserPreference


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


# ---------------------------------------------------------------------------
# Basic CRUD


@pytest.mark.asyncio
async def test_get_all_empty_returns_empty_dict(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.get("/preferences", headers=auth(t))
    assert r.status_code == 200
    assert r.json() == {}


@pytest.mark.asyncio
async def test_put_then_get_roundtrip(client, _auth_signer):
    t, uid = await register(_auth_signer)
    value = {"theme": "dark", "compact": True, "nested": {"k": [1, 2, 3]}}
    r = await client.put(
        "/preferences/appearance", json={"value": value}, headers=auth(t)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == value
    assert body["version"] == 1

    r2 = await client.get("/preferences/appearance", headers=auth(t))
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["value"] == value
    assert body2["version"] == 1
    assert "updated_at" in body2

    # And bulk GET sees it under the section key.
    r3 = await client.get("/preferences", headers=auth(t))
    assert r3.status_code == 200
    assert r3.json() == {"appearance": {"value": value, "version": 1}}


@pytest.mark.asyncio
async def test_put_bumps_version_on_second_write(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r1 = await client.put(
        "/preferences/tamagotchi",
        json={"value": {"hunger": 0}},
        headers=auth(t),
    )
    assert r1.json()["version"] == 1

    r2 = await client.put(
        "/preferences/tamagotchi",
        json={"value": {"hunger": 50}},
        headers=auth(t),
    )
    assert r2.json()["version"] == 2
    assert r2.json()["value"] == {"hunger": 50}


@pytest.mark.asyncio
async def test_get_unknown_section_404(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.get("/preferences/missing", headers=auth(t))
    assert r.status_code == 404
    assert r.json()["detail"] == "section_not_found"


@pytest.mark.asyncio
async def test_delete_then_get_returns_404(client, _auth_signer):
    t, _ = await register(_auth_signer)
    await client.put(
        "/preferences/sect", json={"value": {"x": 1}}, headers=auth(t)
    )
    r = await client.delete("/preferences/sect", headers=auth(t))
    assert r.status_code == 204
    r2 = await client.get("/preferences/sect", headers=auth(t))
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_delete_missing_is_idempotent(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.delete("/preferences/never-existed", headers=auth(t))
    assert r.status_code == 204
    # And again — still 204.
    r2 = await client.delete("/preferences/never-existed", headers=auth(t))
    assert r2.status_code == 204


# ---------------------------------------------------------------------------
# Auth + isolation


@pytest.mark.asyncio
async def test_unauthenticated_401(client):
    r = await client.get("/preferences")
    assert r.status_code in (401, 403)  # depends on dep-style
    r2 = await client.put(
        "/preferences/x", json={"value": {}}
    )
    assert r2.status_code in (401, 403)
    r3 = await client.delete("/preferences/x")
    assert r3.status_code in (401, 403)


@pytest.mark.asyncio
async def test_cross_user_isolation(client, _auth_signer):
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    assert uid_a != uid_b

    await client.put(
        "/preferences/secret",
        json={"value": {"private": "data-of-a"}},
        headers=auth(t_a),
    )

    # B sees an empty bulk GET + a 404 on the single GET.
    r1 = await client.get("/preferences", headers=auth(t_b))
    assert r1.status_code == 200
    assert r1.json() == {}

    r2 = await client.get("/preferences/secret", headers=auth(t_b))
    assert r2.status_code == 404

    # And B can write its own row with the same section name without
    # clobbering A's row.
    r3 = await client.put(
        "/preferences/secret",
        json={"value": {"private": "data-of-b"}},
        headers=auth(t_b),
    )
    assert r3.status_code == 200
    assert r3.json()["value"] == {"private": "data-of-b"}

    r4 = await client.get("/preferences/secret", headers=auth(t_a))
    assert r4.status_code == 200
    assert r4.json()["value"] == {"private": "data-of-a"}


# ---------------------------------------------------------------------------
# Validation


@pytest.mark.asyncio
async def test_invalid_section_name_400(client, _auth_signer):
    t, _ = await register(_auth_signer)
    for bad in ("Foo", "1leading", "with space", "with.dot", "a" * 70):
        r = await client.put(
            f"/preferences/{bad}", json={"value": {}}, headers=auth(t)
        )
        assert r.status_code in (400, 404), (bad, r.status_code, r.text)


@pytest.mark.asyncio
async def test_namespaced_section_name_ok(client, _auth_signer):
    """Colon-namespaced names (``"plugin:sub"``) must be accepted."""
    t, _ = await register(_auth_signer)
    r = await client.put(
        "/preferences/tamagotchi:state",
        json={"value": {"x": 1}},
        headers=auth(t),
    )
    assert r.status_code == 200, r.text
    r2 = await client.get("/preferences/tamagotchi:state", headers=auth(t))
    assert r2.status_code == 200
    assert r2.json()["value"] == {"x": 1}


# ---------------------------------------------------------------------------
# Optimistic concurrency (If-Match)


@pytest.mark.asyncio
async def test_if_match_matching_version_accepted(client, _auth_signer):
    t, _ = await register(_auth_signer)
    await client.put(
        "/preferences/oc", json={"value": {"v": 1}}, headers=auth(t)
    )
    r = await client.put(
        "/preferences/oc",
        json={"value": {"v": 2}},
        headers={**auth(t), "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2


@pytest.mark.asyncio
async def test_if_match_mismatched_version_412(client, _auth_signer):
    t, _ = await register(_auth_signer)
    await client.put(
        "/preferences/oc", json={"value": {"v": 1}}, headers=auth(t)
    )
    r = await client.put(
        "/preferences/oc",
        json={"value": {"v": 2}},
        headers={**auth(t), "If-Match": "99"},
    )
    assert r.status_code == 412
    assert r.json()["detail"] == "version_mismatch"


@pytest.mark.asyncio
async def test_if_match_ignored_on_insert(client, _auth_signer):
    """First write of a section has no prior version to match — the
    header is silently ignored (route documents this)."""
    t, _ = await register(_auth_signer)
    r = await client.put(
        "/preferences/fresh",
        json={"value": {"v": 1}},
        headers={**auth(t), "If-Match": "42"},
    )
    assert r.status_code == 200
    assert r.json()["version"] == 1


@pytest.mark.asyncio
async def test_if_match_quoted_etag_form(client, _auth_signer):
    """HTTP-spec ``If-Match: "3"`` (with quotes) is also accepted."""
    t, _ = await register(_auth_signer)
    await client.put(
        "/preferences/oc", json={"value": {"v": 1}}, headers=auth(t)
    )
    r = await client.put(
        "/preferences/oc",
        json={"value": {"v": 2}},
        headers={**auth(t), "If-Match": '"1"'},
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Persistence integrity


@pytest.mark.asyncio
async def test_db_row_matches_response(
    client, session_factory, _auth_signer
):
    t, uid = await register(_auth_signer)
    await client.put(
        "/preferences/persisted",
        json={"value": {"items": [1, 2, 3]}},
        headers=auth(t),
    )
    async with session_factory() as s:
        row = await s.get(UserPreference, (uid, "persisted"))
    assert row is not None
    assert row.value == {"items": [1, 2, 3]}
    assert row.version == 1
    assert row.section_name == "persisted"
