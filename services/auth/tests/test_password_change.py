"""Tests for the authenticated password-change endpoint (POST /me/password)."""

from __future__ import annotations

import pytest

_REG = {
    "username": "pw_change_user",
    "email": "pwchange@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "PW Changer",
}
_LOGIN = {"email_or_username": _REG["email"], "password": _REG["password"]}
_NEW_PW = "a totally different passphrase 99"


async def _register_and_login(client):
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200, r.text
    return r


def _bearer(login_r) -> dict[str, str]:
    return {"Authorization": f"Bearer {login_r.json()['access_token']}"}


@pytest.mark.asyncio
async def test_change_password_success_rotates_credential(client):
    """Correct current pw -> 200 + fresh tokens; old pw stops working, new works."""
    login_r = await _register_and_login(client)

    r = await client.post(
        "/me/password",
        json={"current_password": _REG["password"], "new_password": _NEW_PW},
        headers=_bearer(login_r),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"] and body["refresh_token"]

    # Old password no longer authenticates.
    old = await client.post("/login", json=_LOGIN)
    assert old.status_code == 401

    # New password does.
    new = await client.post(
        "/login", json={"email_or_username": _REG["email"], "password": _NEW_PW}
    )
    assert new.status_code == 200, new.text


@pytest.mark.asyncio
async def test_change_password_wrong_current_rejected(client):
    """Wrong current password -> 400, credential unchanged."""
    login_r = await _register_and_login(client)

    r = await client.post(
        "/me/password",
        json={"current_password": "not the password", "new_password": _NEW_PW},
        headers=_bearer(login_r),
    )
    assert r.status_code == 400, r.text

    # Original password still valid.
    still = await client.post("/login", json=_LOGIN)
    assert still.status_code == 200


@pytest.mark.asyncio
async def test_change_password_same_as_current_rejected(client):
    """New == current -> 400 (no-op rotation blocked)."""
    login_r = await _register_and_login(client)
    r = await client.post(
        "/me/password",
        json={"current_password": _REG["password"], "new_password": _REG["password"]},
        headers=_bearer(login_r),
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_change_password_revokes_other_refresh_tokens(client):
    """After a change, a refresh token issued before it must be dead."""
    login_r = await _register_and_login(client)
    old_refresh = login_r.json()["refresh_token"]

    r = await client.post(
        "/me/password",
        json={"current_password": _REG["password"], "new_password": _NEW_PW},
        headers=_bearer(login_r),
    )
    assert r.status_code == 200

    # The pre-change refresh token (a different device) is now revoked.
    bad = await client.post("/refresh", json={"refresh_token": old_refresh})
    assert bad.status_code == 401

    # The fresh refresh token returned by the change still works.
    good = await client.post("/refresh", json={"refresh_token": r.json()["refresh_token"]})
    assert good.status_code == 200, good.text


@pytest.mark.asyncio
async def test_change_password_requires_auth(client):
    """No bearer and no cookie -> 401."""
    await client.post("/register", json=_REG)
    r = await client.post(
        "/me/password",
        json={"current_password": _REG["password"], "new_password": _NEW_PW},
    )
    assert r.status_code == 401
