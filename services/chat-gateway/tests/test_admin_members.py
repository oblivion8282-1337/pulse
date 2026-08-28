"""Tests for /admin/members (F11c) — instance-wide Member-Verwaltung.

Covers:
* GET /admin/members — listing + sort (banned first, then by username)
* POST /admin/members/{id}/ban — sets banned_at, idempotent, 404 for unknown
* POST /admin/members/{id}/unban — clears banned_at, idempotent
* cert-login of a banned user → 403 "instance banned"
* cert-login of the instance OWNER is exempt from the ban gate
* admin gate: non-admin token → 403
"""

from __future__ import annotations

import base64
import time
from datetime import datetime, timezone

import pytest

from dcc_chat_gateway.credential_validator import CertClaims, compute_pairwise_sub
from dcc_chat_gateway.models.moderation import CachedUserProfile

from .conftest import make_auth_header


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


async def _seed_profile(
    session_factory,
    user_identifier: str,
    username: str,
    *,
    banned: bool = False,
) -> None:
    async with session_factory() as session:
        session.add(
            CachedUserProfile(
                user_identifier=user_identifier,
                username=username,
                display_name=username.title(),
                last_statement_iat=datetime.now(tz=timezone.utc),
                stale=False,
                banned_at=datetime.now(tz=timezone.utc) if banned else None,
                ban_reason="seeded" if banned else None,
            )
        )
        await session.commit()


# ─── /admin/members listing + ban/unban ────────────────────────────────────


@pytest.mark.asyncio
async def test_list_ban_unban_flow(client, admin_token, session_factory):
    token, _ = admin_token
    await _seed_profile(session_factory, "id-charlie", "charlie")
    await _seed_profile(session_factory, "id-alice", "alice")
    await _seed_profile(session_factory, "id-bob", "bob", banned=True)

    # List: banned (bob) first, then alphabetical (alice, charlie).
    r = await client.get("/admin/members", headers=make_auth_header(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [x["username"] for x in rows] == ["bob", "alice", "charlie"]
    assert rows[0]["banned_at"] is not None
    assert rows[1]["banned_at"] is None

    # Ban alice with a reason.
    r = await client.post(
        "/admin/members/id-alice/ban",
        json={"reason": "spam"},
        headers=make_auth_header(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["banned_at"] is not None
    assert r.json()["ban_reason"] == "spam"

    # Idempotent re-ban.
    r2 = await client.post(
        "/admin/members/id-alice/ban", json={}, headers=make_auth_header(token)
    )
    assert r2.status_code == 200
    assert r2.json()["banned_at"] is not None

    # Unban alice.
    r3 = await client.post(
        "/admin/members/id-alice/unban", headers=make_auth_header(token)
    )
    assert r3.status_code == 200
    assert r3.json()["banned_at"] is None
    assert r3.json()["ban_reason"] is None

    # Idempotent unban.
    r4 = await client.post(
        "/admin/members/id-alice/unban", headers=make_auth_header(token)
    )
    assert r4.status_code == 200
    assert r4.json()["banned_at"] is None


@pytest.mark.asyncio
async def test_ban_unknown_member_404(client, admin_token):
    token, _ = admin_token
    r = await client.post(
        "/admin/members/does-not-exist/ban", json={}, headers=make_auth_header(token)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_members_requires_admin(client, access_token):
    token, _ = access_token
    r = await client.get("/admin/members", headers=make_auth_header(token))
    assert r.status_code == 403


# ─── cert-login ban gate ────────────────────────────────────────────────────


# Die beiden Bann-Tests, die hier bis zum 2026-08-28 standen, prüften das
# Bann-Gate über ``cert-login/verify``. Mit dem Wegfall des Gerätezertifikats
# ist ihr Fahrzeug weg; das Gate selbst (``routes/gates.py``) ist unverändert
# und wird jetzt in ``test_session_ticket_route.py`` über ``POST /session``
# geprüft — an derselben Stelle wie die übrigen Anmelde-Gates.
