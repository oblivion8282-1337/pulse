"""Tests für GET/PATCH /me/preferences/backup-onboarding.

Coverage:
- GET ohne Auth → 401
- GET happy-path (neuer User) → ``{decided: false, decision: null, decided_at: null}``
- PATCH happy-path "skipped" → 200
- PATCH nach PATCH mit gleicher decision → 200 idempotent
- PATCH zweimal mit verschiedener decision → 409
- GET nach PATCH → ``{decided: true, decision: "skipped", decided_at: ...}``
- PATCH happy-path "configured" → 200
- Cross-User-Leak: User B sieht User A's Pref nicht
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(10_000_000, 99_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


_URL = "/me/preferences/backup-onboarding"


# ---------------------------------------------------------------------------
# Auth guard


@pytest.mark.asyncio
async def test_get_requires_auth(client):
    r = await client.get(_URL)
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_patch_requires_auth(client):
    r = await client.patch(_URL, json={"decision": "skipped"})
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Happy-path GET (new user)


@pytest.mark.asyncio
async def test_get_new_user_undecided(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.get(_URL, headers=auth(t))
    assert r.status_code == 200
    body = r.json()
    assert body["decided"] is False
    assert body["decision"] is None
    assert body["decided_at"] is None


# ---------------------------------------------------------------------------
# Happy-path PATCH → decided


@pytest.mark.asyncio
async def test_patch_skipped(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.patch(_URL, json={"decision": "skipped"}, headers=auth(t))
    assert r.status_code == 200
    body = r.json()
    assert body["decided"] is True
    assert body["decision"] == "skipped"
    assert body["decided_at"] is not None


@pytest.mark.asyncio
async def test_patch_configured(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.patch(_URL, json={"decision": "configured"}, headers=auth(t))
    assert r.status_code == 200
    body = r.json()
    assert body["decided"] is True
    assert body["decision"] == "configured"
    assert body["decided_at"] is not None


# ---------------------------------------------------------------------------
# GET after PATCH


@pytest.mark.asyncio
async def test_get_after_patch_reflects_decision(client, _auth_signer):
    t, _ = await register(_auth_signer)
    await client.patch(_URL, json={"decision": "skipped"}, headers=auth(t))
    r = await client.get(_URL, headers=auth(t))
    assert r.status_code == 200
    body = r.json()
    assert body["decided"] is True
    assert body["decision"] == "skipped"
    assert body["decided_at"] is not None


# ---------------------------------------------------------------------------
# Idempotency


@pytest.mark.asyncio
async def test_patch_same_decision_twice_is_idempotent(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r1 = await client.patch(_URL, json={"decision": "skipped"}, headers=auth(t))
    assert r1.status_code == 200
    r2 = await client.patch(_URL, json={"decision": "skipped"}, headers=auth(t))
    assert r2.status_code == 200
    assert r2.json()["decision"] == "skipped"


# ---------------------------------------------------------------------------
# Conflict — zweite PATCH mit anderer decision


@pytest.mark.asyncio
async def test_patch_different_decision_twice_409(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r1 = await client.patch(_URL, json={"decision": "skipped"}, headers=auth(t))
    assert r1.status_code == 200
    r2 = await client.patch(_URL, json={"decision": "configured"}, headers=auth(t))
    assert r2.status_code == 409
    assert r2.json()["detail"] == "already_decided"


# ---------------------------------------------------------------------------
# Cross-user isolation


@pytest.mark.asyncio
async def test_cross_user_no_leak(client, _auth_signer):
    """User B darf User A's Entscheidung nicht sehen."""
    t_a, _ = await register(_auth_signer)
    t_b, _ = await register(_auth_signer)

    # User A entscheidet
    r = await client.patch(_URL, json={"decision": "configured"}, headers=auth(t_a))
    assert r.status_code == 200

    # User B soll noch undecided sein
    r_b = await client.get(_URL, headers=auth(t_b))
    assert r_b.status_code == 200
    body_b = r_b.json()
    assert body_b["decided"] is False
    assert body_b["decision"] is None
