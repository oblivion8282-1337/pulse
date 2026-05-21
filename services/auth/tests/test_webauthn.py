"""Tests for the WebAuthn / passkey flow.

The cryptographic verification is owned by the third-party ``webauthn``
library and exercised by its own suite — there is no software authenticator
here. These tests monkeypatch ``verify_registration_response`` /
``verify_authentication_response`` to return a canned result and instead
cover *our* orchestration: challenge-ticket issuing + purpose checks, the DB
row lifecycle, sign-count / last-used updates, recovery-code minting, the
login MFA-gate, and token issue.
"""

from __future__ import annotations

import types

import pytest
from webauthn.helpers import bytes_to_base64url

REG = {
    "username": "passkeyuser",
    "email": "passkey@dcc-test.example.com",
    "password": "hunter2hunter2",
}

# Deterministic fake authenticator output — the values the monkeypatched
# library functions hand back, so a test knows the credential id up front.
FAKE_CRED_ID = bytes(range(1, 21))
FAKE_PUBKEY = b"\x05" * 48
FAKE_AAGUID = "00000000-0000-0000-0000-000000000000"


async def _register(client, **over):
    body = {**REG, **over}
    r = await client.post("/register", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _bearer(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def _patch_reg_verify(monkeypatch, *, cred_id: bytes = FAKE_CRED_ID):
    import dcc_auth.routes_webauthn as rw

    monkeypatch.setattr(
        rw.webauthn,
        "verify_registration_response",
        lambda **kw: types.SimpleNamespace(
            credential_id=cred_id,
            credential_public_key=FAKE_PUBKEY,
            sign_count=0,
            aaguid=FAKE_AAGUID,
        ),
    )


def _patch_auth_verify(monkeypatch, *, sign_count: int = 1):
    import dcc_auth.routes_webauthn as rw

    monkeypatch.setattr(
        rw.webauthn,
        "verify_authentication_response",
        lambda **kw: types.SimpleNamespace(
            new_sign_count=sign_count, credential_id=FAKE_CRED_ID
        ),
    )


async def _enrol(client, monkeypatch, bearer, *, cred_id: bytes = FAKE_CRED_ID, name="Laptop"):
    """Run a full options→verify registration, return the verify response."""
    r = await client.post("/webauthn/register/options", headers=bearer)
    assert r.status_code == 200, r.text
    ticket = r.json()["challenge_ticket"]
    _patch_reg_verify(monkeypatch, cred_id=cred_id)
    cred_b64 = bytes_to_base64url(cred_id)
    return await client.post(
        "/webauthn/register/verify",
        headers=bearer,
        json={
            "challenge_ticket": ticket,
            "credential": {
                "id": cred_b64,
                "rawId": cred_b64,
                "type": "public-key",
                "response": {"transports": ["internal", "hybrid"]},
            },
            "name": name,
        },
    )


# ---- registration -------------------------------------------------------


@pytest.mark.asyncio
async def test_register_options_shape(client):
    bearer = _bearer(await _register(client))
    r = await client.post("/webauthn/register/options", headers=bearer)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["challenge_ticket"]
    opts = body["options"]
    assert opts["rp"]["id"] == "localhost"
    assert opts["challenge"]
    assert opts["user"]["name"] == REG["username"]


@pytest.mark.asyncio
async def test_register_verify_enrols_and_mints_backup_codes(client, monkeypatch):
    bearer = _bearer(await _register(client))
    r = await _enrol(client, monkeypatch, bearer, name="MacBook Touch ID")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["credential"]["name"] == "MacBook Touch ID"
    assert body["credential"]["transports"] == ["internal", "hybrid"]
    # First MFA factor on a TOTP-less account → 10 one-time recovery codes.
    assert body["backup_codes"] is not None
    assert len(body["backup_codes"]) == 10

    # A second passkey does NOT re-issue codes.
    r2 = await _enrol(
        client, monkeypatch, bearer, cred_id=bytes(range(21, 41)), name="YubiKey"
    )
    assert r2.status_code == 201, r2.text
    assert r2.json()["backup_codes"] is None


@pytest.mark.asyncio
async def test_register_verify_rejects_wrong_purpose_ticket(client, monkeypatch):
    bearer = _bearer(await _register(client))
    # A *login* challenge ticket must not be accepted by the register verify.
    r = await client.post("/login/webauthn/options", json={})
    login_ticket = r.json()["challenge_ticket"]
    _patch_reg_verify(monkeypatch)
    cred_b64 = bytes_to_base64url(FAKE_CRED_ID)
    r = await client.post(
        "/webauthn/register/verify",
        headers=bearer,
        json={
            "challenge_ticket": login_ticket,
            "credential": {"id": cred_b64, "rawId": cred_b64, "response": {}},
            "name": "x",
        },
    )
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_register_verify_duplicate_conflict(client, monkeypatch):
    bearer = _bearer(await _register(client))
    assert (await _enrol(client, monkeypatch, bearer)).status_code == 201
    # Same credential id again → 409.
    r = await _enrol(client, monkeypatch, bearer)
    assert r.status_code == 409, r.text


# ---- management ---------------------------------------------------------


@pytest.mark.asyncio
async def test_list_rename_delete(client, monkeypatch):
    bearer = _bearer(await _register(client))
    cred_id = (await _enrol(client, monkeypatch, bearer, name="Old name")).json()[
        "credential"
    ]["id"]

    listed = (await client.get("/webauthn/credentials", headers=bearer)).json()
    assert len(listed) == 1 and listed[0]["name"] == "Old name"

    r = await client.patch(
        f"/webauthn/credentials/{cred_id}", headers=bearer, json={"name": "New name"}
    )
    assert r.status_code == 200 and r.json()["name"] == "New name"

    r = await client.delete(f"/webauthn/credentials/{cred_id}", headers=bearer)
    assert r.status_code == 200, r.text
    assert (await client.get("/webauthn/credentials", headers=bearer)).json() == []


@pytest.mark.asyncio
async def test_delete_foreign_credential_404(client, monkeypatch):
    owner = _bearer(await _register(client))
    cred_id = (await _enrol(client, monkeypatch, owner)).json()["credential"]["id"]
    other = _bearer(
        await _register(client, username="intruder", email="intruder@dcc-test.example.com")
    )
    r = await client.delete(f"/webauthn/credentials/{cred_id}", headers=other)
    assert r.status_code == 404, r.text


# ---- login --------------------------------------------------------------


@pytest.mark.asyncio
async def test_login_is_gated_once_a_passkey_exists(client, monkeypatch):
    bearer = _bearer(await _register(client))
    await _enrol(client, monkeypatch, bearer)

    r = await client.post(
        "/login",
        json={"email_or_username": REG["email"], "password": REG["password"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["requires_mfa"] is True
    assert body["methods"] == ["webauthn"]
    assert "access_token" not in body


@pytest.mark.asyncio
async def test_login_webauthn_second_factor_flow(client, monkeypatch):
    bearer = _bearer(await _register(client))
    await _enrol(client, monkeypatch, bearer)

    step1 = (
        await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
    ).json()
    mfa_ticket = step1["mfa_ticket"]

    opts = (
        await client.post("/login/webauthn/options", json={"mfa_ticket": mfa_ticket})
    ).json()
    assert opts["options"]["allowCredentials"]  # scoped to the user's keys

    _patch_auth_verify(monkeypatch, sign_count=7)
    cred_b64 = bytes_to_base64url(FAKE_CRED_ID)
    r = await client.post(
        "/login/webauthn/verify",
        json={
            "challenge_ticket": opts["challenge_ticket"],
            "mfa_ticket": mfa_ticket,
            "credential": {"id": cred_b64, "rawId": cred_b64, "response": {}},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]

    # The verifier's new sign count was persisted.
    creds = (await client.get("/webauthn/credentials", headers=bearer)).json()
    assert creds[0]["last_used_at"] is not None


@pytest.mark.asyncio
async def test_login_webauthn_passwordless_flow(client, monkeypatch):
    tokens = await _register(client)
    bearer = _bearer(tokens)
    await _enrol(client, monkeypatch, bearer)
    user_id = (await client.get("/me", headers=bearer)).json()["id"]

    opts = (await client.post("/login/webauthn/options", json={})).json()
    # Discoverable login → no allowCredentials list.
    assert not opts["options"].get("allowCredentials")

    _patch_auth_verify(monkeypatch)
    cred_b64 = bytes_to_base64url(FAKE_CRED_ID)
    r = await client.post(
        "/login/webauthn/verify",
        json={
            "challenge_ticket": opts["challenge_ticket"],
            "credential": {
                "id": cred_b64,
                "rawId": cred_b64,
                "response": {"userHandle": bytes_to_base64url(str(user_id).encode())},
            },
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]


@pytest.mark.asyncio
async def test_login_webauthn_verify_rejects_unknown_credential(client):
    await _register(client)
    opts = (await client.post("/login/webauthn/options", json={})).json()
    bogus = bytes_to_base64url(b"not-a-real-credential")
    r = await client.post(
        "/login/webauthn/verify",
        json={
            "challenge_ticket": opts["challenge_ticket"],
            "credential": {"id": bogus, "rawId": bogus, "response": {}},
        },
    )
    assert r.status_code == 401, r.text
