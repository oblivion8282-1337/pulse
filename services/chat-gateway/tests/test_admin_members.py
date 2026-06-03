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
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from dcc_chat_gateway.credential_validator import CertClaims, compute_pairwise_sub
from dcc_chat_gateway.models.moderation import CachedUserProfile
from dcc_chat_gateway.routes import cert_login as cert_login_route
from dcc_chat_gateway.session_tokens import reset_session_signer

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


def _make_claims(user_id: str, device_pubkey: str) -> CertClaims:
    now = int(time.time())
    return CertClaims(
        cert_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        user_id=user_id,
        device_pubkey=device_pubkey,
        device_label="Test Device",
        pairwise_seed=_b64url(b"\xab" * 32),
        amr=["pwd"],
        acr="1",
        iat=now,
        exp=now + 3600,
    )


def _patch_validate(claims: CertClaims):
    async def _fake(_cert: str, _redis):  # noqa: ARG001
        return claims

    return patch.object(cert_login_route, "validate_cert", _fake)


async def _full_verify(client, claims, priv):
    with _patch_validate(claims):
        ch = (await client.post("/cert-login/challenge", json={"cert": "stub"})).json()
        raw = base64.urlsafe_b64decode(ch["nonce"] + "==")
        sig = _b64url(priv.sign(raw))
        return await client.post(
            "/cert-login/verify",
            json={"cert": "stub", "challenge_token": ch["challenge_token"], "signature": sig},
        )


@pytest.mark.asyncio
async def test_cert_login_banned_user_403(client, session_factory, tmp_path):
    """A banned cached profile → cert-login verify returns 403 instance banned."""
    cert_login_route._reset_challenge_secret_for_tests()
    reset_session_signer()
    from dcc_chat_gateway.config import Settings as _Settings

    settings = _Settings(
        session_signing_key_file=str(tmp_path / "session_signing.pem"),
        pulse_instance_mode="self-host",
        pulse_instance_id=42,
        pulse_instance_owner_id=0,
        chat_gateway_challenge_secret="",
    )
    original = cert_login_route.get_settings
    cert_login_route.get_settings = lambda: settings  # type: ignore[assignment]
    try:
        priv = Ed25519PrivateKey.generate()
        pub = _b64url(priv.public_key().public_bytes_raw())
        claims = _make_claims(user_id="555", device_pubkey=pub)
        identifier = compute_pairwise_sub("555", 42, claims.pairwise_seed)

        # Not banned yet → 200.
        ok = await _full_verify(client, claims, priv)
        assert ok.status_code == 200, ok.text

        # Ban the resolved pairwise-sub → next verify 403.
        await _seed_profile(session_factory, identifier, "evil", banned=True)
        denied = await _full_verify(client, claims, priv)
        assert denied.status_code == 403, denied.text
        assert denied.json()["detail"] == "instance banned"
    finally:
        cert_login_route.get_settings = original  # type: ignore[assignment]
        reset_session_signer()
        cert_login_route._reset_challenge_secret_for_tests()


@pytest.mark.asyncio
async def test_cert_login_owner_exempt_from_ban(client, session_factory, tmp_path):
    """The instance owner is never locked out, even with a banned profile row."""
    cert_login_route._reset_challenge_secret_for_tests()
    reset_session_signer()
    from dcc_chat_gateway.config import Settings as _Settings

    settings = _Settings(
        session_signing_key_file=str(tmp_path / "session_signing.pem"),
        pulse_instance_mode="self-host",
        pulse_instance_id=42,
        pulse_instance_owner_id=555,  # cert user_id 555 == owner
        chat_gateway_challenge_secret="",
    )
    original = cert_login_route.get_settings
    cert_login_route.get_settings = lambda: settings  # type: ignore[assignment]
    try:
        priv = Ed25519PrivateKey.generate()
        pub = _b64url(priv.public_key().public_bytes_raw())
        claims = _make_claims(user_id="555", device_pubkey=pub)
        identifier = compute_pairwise_sub("555", 42, claims.pairwise_seed)
        await _seed_profile(session_factory, identifier, "owner", banned=True)

        resp = await _full_verify(client, claims, priv)
        assert resp.status_code == 200, resp.text
        assert resp.json()["pairwise_sub"] == identifier
    finally:
        cert_login_route.get_settings = original  # type: ignore[assignment]
        reset_session_signer()
        cert_login_route._reset_challenge_secret_for_tests()
