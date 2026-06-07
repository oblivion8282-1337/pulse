"""Tests for POST /cert-login/{challenge,verify} (Phase 5.1).

Covers the happy path + every documented failure code in
``routes/cert_login.py``:

* /challenge → 401 cert_invalid (bad sig / revoked / expired / malformed)
* /verify happy path → 200 + session_token
* /verify wrong-signature → 401 signature_invalid
* /verify expired challenge → 410 challenge_expired
* /verify cert-mismatch (challenge bound to a different cert) → 401 cert_mismatch
* /verify tampered challenge token → 401 challenge_invalid
* pairwise_sub: cloud-mode = raw user_id, self-host = pairwise hash

``validate_cert`` is monkey-patched (the live JWKS/CRL plumbing has its
own coverage in ``test_credential_validator.py``); this file focuses on
the route's HMAC challenge + Ed25519 verification logic.
"""

from __future__ import annotations

import base64
import time
from unittest.mock import patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from dcc_chat_gateway.credential_validator import CertClaims
from dcc_chat_gateway.routes import cert_login as cert_login_route
from dcc_chat_gateway.session_tokens import (
    SESSION_TTL_SECONDS,
    reset_session_signer,
    validate_session_token,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _make_keypair() -> tuple[Ed25519PrivateKey, str]:
    """Return (private_key, base64url(public_key)) for the device-cert pubkey claim."""
    priv = Ed25519PrivateKey.generate()
    return priv, _b64url(priv.public_key().public_bytes_raw())


def _make_claims(
    *,
    cert_id: str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    user_id: str = "777777",
    device_pubkey: str | None = None,
    pairwise_seed: str | None = None,
) -> CertClaims:
    if device_pubkey is None:
        priv, device_pubkey = _make_keypair()
    if pairwise_seed is None:
        pairwise_seed = _b64url(b"\xab" * 32)
    now = int(time.time())
    return CertClaims(
        cert_id=cert_id,
        user_id=user_id,
        device_pubkey=device_pubkey,
        device_label="Test Device",
        pairwise_seed=pairwise_seed,
        amr=["pwd"],
        acr="1",
        iat=now,
        exp=now + 3600,
    )


def _sign_nonce(priv: Ed25519PrivateKey, nonce_b64: str) -> str:
    """Sign the raw nonce bytes with Ed25519 and return base64url(signature)."""
    raw = base64.urlsafe_b64decode(nonce_b64 + "==")
    sig = priv.sign(raw)
    return _b64url(sig)


async def _seed_public_guild(session_factory, handle: str = "openhouse") -> None:
    """Install a public community so a first-contact non-owner cert-holder is
    admitted by the public-community grant (the join gate now denies a new
    member with no admission path; these tests focus on cert-login *mechanics*,
    not the gate). Passing ``public_join_handle`` is the lightest faithful way
    to clear the gate without making the user the owner."""
    from dcc_chat_gateway.models import Guild

    async with session_factory() as s:
        s.add(Guild(id=888, name="PublicCommunity", owner_id=1, handle=handle, is_public=True))
        await s.commit()


@pytest.fixture(autouse=True)
def _route_settings(tmp_path):
    """Override ``cert_login.get_settings`` so the route sees the test config.

    ``conftest._isolate_chat_settings`` swaps the provider on the *config*
    module, but ``cert_login`` imported ``get_settings`` by name → it holds
    a live reference to the original LRU-cached function.  We bind a stub
    here that returns a fresh Settings each test, with the session-signing
    key redirected into ``tmp_path`` so we don't write into the repo.
    """
    from dcc_chat_gateway.config import Settings as _Settings

    cert_login_route._reset_challenge_secret_for_tests()
    cert_login_route._reset_cert_login_rate_for_tests()
    reset_session_signer()

    settings = _Settings(
        session_signing_key_file=str(tmp_path / "session_signing.pem"),
        pulse_instance_mode="self-host",
        pulse_instance_id=0,
        chat_gateway_challenge_secret="",  # force ephemeral path
    )
    original = cert_login_route.get_settings

    def _provider() -> _Settings:
        return settings

    cert_login_route.get_settings = _provider  # type: ignore[assignment]
    yield settings
    cert_login_route.get_settings = original  # type: ignore[assignment]
    reset_session_signer()
    cert_login_route._reset_challenge_secret_for_tests()
    cert_login_route._reset_cert_login_rate_for_tests()


def _patch_validate(claims: CertClaims | None):
    """Replace ``cert_login.validate_cert`` with an async stub returning ``claims``."""

    async def _fake(_cert: str, _redis):  # noqa: ARG001
        return claims

    return patch.object(cert_login_route, "validate_cert", _fake)


# ---------------------------------------------------------------------------
# /challenge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_challenge_happy_path(client):
    """Valid cert → 200 with challenge_token + nonce + ttl."""
    claims = _make_claims()
    with _patch_validate(claims):
        resp = await client.post("/cert-login/challenge", json={"cert": "stub"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["expires_in"] == 60
    assert body["nonce"]
    # Challenge token decodes (with HMAC secret) → carries the cert_id + nonce
    decoded = jwt.decode(
        body["challenge_token"],
        cert_login_route._get_challenge_secret(),
        algorithms=["HS256"],
    )
    assert decoded["cert_id"] == claims.cert_id
    assert decoded["purpose"] == "cert-login-challenge"
    assert decoded["nonce"] == body["nonce"]


@pytest.mark.asyncio
async def test_challenge_invalid_cert(client):
    """validate_cert returns None → 401 cert_invalid."""
    with _patch_validate(None):
        resp = await client.post("/cert-login/challenge", json={"cert": "broken"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "cert_invalid"


# ---------------------------------------------------------------------------
# /verify — happy paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verify_happy_path_self_host(client, _route_settings, session_factory):
    """Self-host mode → session_token + pairwise_sub (hashed, not user_id)."""
    priv = Ed25519PrivateKey.generate()
    pub_b64 = _b64url(priv.public_key().public_bytes_raw())
    claims = _make_claims(user_id="555", device_pubkey=pub_b64)

    _route_settings.pulse_instance_mode = "self-host"
    _route_settings.pulse_instance_id = 42
    await _seed_public_guild(session_factory)

    with _patch_validate(claims):
        ch = await client.post("/cert-login/challenge", json={"cert": "stub"})
        assert ch.status_code == 200
        ch_body = ch.json()
        sig = _sign_nonce(priv, ch_body["nonce"])

        v = await client.post(
            "/cert-login/verify",
            json={
                "cert": "stub",
                "challenge_token": ch_body["challenge_token"],
                "signature": sig,
                "public_join_handle": "openhouse",
            },
        )
    assert v.status_code == 200, v.text
    body = v.json()
    assert body["expires_in"] == SESSION_TTL_SECONDS
    assert body["instance_id"] == "42"
    # Self-host → pairwise hash, NOT raw user_id
    assert body["pairwise_sub"] != "555"
    assert len(body["pairwise_sub"]) == 16
    # The minted session token validates locally
    session = validate_session_token(
        body["session_token"], key_path=_route_settings.session_signing_key_file
    )
    assert session is not None
    assert session.user_identifier == body["pairwise_sub"]
    assert session.cert_id == claims.cert_id


async def _verify_as(
    client, _route_settings, *, user_id: str, owner_id: int, public_join_handle=None
):
    """Run the full challenge→sign→verify as ``user_id`` with the instance
    configured to owner ``owner_id``; return the decoded SessionClaims.

    A non-owner first-contact must clear the join gate — pass
    ``public_join_handle`` (a pre-seeded public community) for that.
    """
    priv = Ed25519PrivateKey.generate()
    pub_b64 = _b64url(priv.public_key().public_bytes_raw())
    claims = _make_claims(user_id=user_id, device_pubkey=pub_b64)
    _route_settings.pulse_instance_mode = "self-host"
    _route_settings.pulse_instance_id = 42
    _route_settings.pulse_instance_owner_id = owner_id
    with _patch_validate(claims):
        ch = (await client.post("/cert-login/challenge", json={"cert": "stub"})).json()
        sig = _sign_nonce(priv, ch["nonce"])
        body = {"cert": "stub", "challenge_token": ch["challenge_token"], "signature": sig}
        if public_join_handle is not None:
            body["public_join_handle"] = public_join_handle
        v = await client.post("/cert-login/verify", json=body)
    assert v.status_code == 200, v.text
    return validate_session_token(
        v.json()["session_token"], key_path=_route_settings.session_signing_key_file
    )


@pytest.mark.asyncio
async def test_verify_owner_becomes_admin(client, _route_settings):
    """Cert-holder whose user_id == PULSE_INSTANCE_OWNER_ID → admin session.

    The owner clears the join gate unconditionally — no grant needed."""
    session = await _verify_as(client, _route_settings, user_id="555", owner_id=555)
    assert session is not None
    assert session.admin is True


@pytest.mark.asyncio
async def test_verify_non_owner_not_admin(client, _route_settings, session_factory):
    """A non-owner cert-holder gets a normal (non-admin) session. The non-owner
    is admitted through the join gate by a public-community handle."""
    await _seed_public_guild(session_factory)
    session = await _verify_as(
        client, _route_settings, user_id="555", owner_id=999, public_join_handle="openhouse"
    )
    assert session is not None
    assert session.admin is False


@pytest.mark.asyncio
async def test_verify_happy_path_cloud_mode(client, _route_settings):
    """Cloud mode → pairwise_sub equals raw user_id (no obfuscation)."""
    priv = Ed25519PrivateKey.generate()
    pub_b64 = _b64url(priv.public_key().public_bytes_raw())
    claims = _make_claims(user_id="9001", device_pubkey=pub_b64)

    _route_settings.pulse_instance_mode = "cloud"

    with _patch_validate(claims):
        ch = await client.post("/cert-login/challenge", json={"cert": "stub"})
        ch_body = ch.json()
        sig = _sign_nonce(priv, ch_body["nonce"])
        v = await client.post(
            "/cert-login/verify",
            json={
                "cert": "stub",
                "challenge_token": ch_body["challenge_token"],
                "signature": sig,
            },
        )
    assert v.status_code == 200
    assert v.json()["pairwise_sub"] == "9001"


# ---------------------------------------------------------------------------
# /verify — failure paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verify_wrong_signature(client):
    """Signature minted with the wrong device key → 401 signature_invalid."""
    _priv_cert, pub_b64 = _make_keypair_full()
    priv_wrong = Ed25519PrivateKey.generate()
    claims = _make_claims(device_pubkey=pub_b64)

    with _patch_validate(claims):
        ch = await client.post("/cert-login/challenge", json={"cert": "stub"})
        ch_body = ch.json()
        sig_bad = _sign_nonce(priv_wrong, ch_body["nonce"])
        v = await client.post(
            "/cert-login/verify",
            json={
                "cert": "stub",
                "challenge_token": ch_body["challenge_token"],
                "signature": sig_bad,
            },
        )
    assert v.status_code == 401
    assert v.json()["detail"] == "signature_invalid"


@pytest.mark.asyncio
async def test_verify_expired_challenge(client):
    """challenge_token whose exp is in the past → 410 challenge_expired."""
    priv, pub_b64 = _make_keypair_full()
    claims = _make_claims(device_pubkey=pub_b64)

    # Hand-craft an already-expired challenge-JWT signed with the live secret
    expired = jwt.encode(
        {
            "purpose": "cert-login-challenge",
            "cert_id": claims.cert_id,
            "nonce": _b64url(b"\x00" * 32),
            "iat": int(time.time()) - 120,
            "exp": int(time.time()) - 10,
        },
        cert_login_route._get_challenge_secret(),
        algorithm="HS256",
    )
    sig = _sign_nonce(priv, _b64url(b"\x00" * 32))

    with _patch_validate(claims):
        v = await client.post(
            "/cert-login/verify",
            json={"cert": "stub", "challenge_token": expired, "signature": sig},
        )
    assert v.status_code == 410
    assert v.json()["detail"] == "challenge_expired"


@pytest.mark.asyncio
async def test_verify_cert_mismatch(client):
    """challenge bound to cert A but /verify sent with cert B → 401 cert_mismatch."""
    priv, pub_b64 = _make_keypair_full()
    claims_a = _make_claims(cert_id="aaaa-AAAA", device_pubkey=pub_b64)
    claims_b = _make_claims(cert_id="bbbb-BBBB", device_pubkey=pub_b64)

    with _patch_validate(claims_a):
        ch = await client.post("/cert-login/challenge", json={"cert": "stubA"})
        ch_body = ch.json()
        sig = _sign_nonce(priv, ch_body["nonce"])
    # Second call: validate_cert now returns claims for a DIFFERENT cert
    with _patch_validate(claims_b):
        v = await client.post(
            "/cert-login/verify",
            json={
                "cert": "stubB",
                "challenge_token": ch_body["challenge_token"],
                "signature": sig,
            },
        )
    assert v.status_code == 401
    assert v.json()["detail"] == "cert_mismatch"


@pytest.mark.asyncio
async def test_verify_tampered_challenge_token(client):
    """Tampered challenge_token (broken HMAC) → 401 challenge_invalid."""
    priv, pub_b64 = _make_keypair_full()
    claims = _make_claims(device_pubkey=pub_b64)

    with _patch_validate(claims):
        ch = await client.post("/cert-login/challenge", json={"cert": "stub"})
        ch_body = ch.json()
        # Flip the last 4 chars of the payload — HMAC breaks
        h, p, s = ch_body["challenge_token"].split(".")
        tampered = f"{h}.{p[:-4]}AAAA.{s}"
        sig = _sign_nonce(priv, ch_body["nonce"])
        v = await client.post(
            "/cert-login/verify",
            json={"cert": "stub", "challenge_token": tampered, "signature": sig},
        )
    assert v.status_code == 401
    assert v.json()["detail"] == "challenge_invalid"


@pytest.mark.asyncio
async def test_verify_invalid_cert(client):
    """validate_cert returns None on /verify → 401 cert_invalid."""
    priv, pub_b64 = _make_keypair_full()
    claims = _make_claims(device_pubkey=pub_b64)
    with _patch_validate(claims):
        ch = await client.post("/cert-login/challenge", json={"cert": "stub"})
        ch_body = ch.json()
        sig = _sign_nonce(priv, ch_body["nonce"])
    with _patch_validate(None):
        v = await client.post(
            "/cert-login/verify",
            json={
                "cert": "broken",
                "challenge_token": ch_body["challenge_token"],
                "signature": sig,
            },
        )
    assert v.status_code == 401
    assert v.json()["detail"] == "cert_invalid"


# Alias kept for the failure-path tests written before the helper rename.
_make_keypair_full = _make_keypair
