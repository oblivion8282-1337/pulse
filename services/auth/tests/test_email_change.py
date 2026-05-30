"""Tests for the authenticated email-change flow.

POST /me/email/change         -> issues a token, mails the NEW address
POST /me/email/change/confirm -> consumes the token, rewrites users.email
"""

from __future__ import annotations

import pytest

import dcc_auth.routes_account_security as ras

_REG = {
    "username": "email_change_user",
    "email": "before@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Email Changer",
}
_LOGIN = {"email_or_username": _REG["email"], "password": _REG["password"]}
_NEW = "after@dcc-test.example.com"


async def _register_and_login(client):
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200, r.text
    return r


def _bearer(login_r) -> dict[str, str]:
    return {"Authorization": f"Bearer {login_r.json()['access_token']}"}


def _spy_capture(monkeypatch) -> dict[str, str]:
    """Spy on the verification-mail composer to grab the link's plaintext token."""
    captured: dict[str, str] = {}

    def _spy(new_email: str, url: str):
        captured["url"] = url
        return ("subject", "body")

    monkeypatch.setattr(ras, "compose_email_change_verification", _spy)
    return captured


@pytest.mark.asyncio
async def test_email_change_full_flow(client, monkeypatch):
    """Request keeps the old email; confirm swaps it and marks it verified."""
    captured = _spy_capture(monkeypatch)
    login_r = await _register_and_login(client)

    r = await client.post(
        "/me/email/change",
        json={"new_email": _NEW, "current_password": _REG["password"]},
        headers=_bearer(login_r),
    )
    assert r.status_code == 204, r.text

    # Email is NOT changed until the link is clicked.
    me = await client.get("/me", headers=_bearer(login_r))
    assert me.json()["email"] == _REG["email"]

    token = captured["url"].rsplit("/", 1)[1]
    c = await client.post("/me/email/change/confirm", json={"token": token})
    assert c.status_code == 200, c.text

    me2 = await client.get("/me", headers=_bearer(login_r))
    assert me2.json()["email"] == _NEW
    assert me2.json()["email_verified_at"] is not None

    # Token is single-use.
    again = await client.post("/me/email/change/confirm", json={"token": token})
    assert again.status_code == 401


@pytest.mark.asyncio
async def test_email_change_wrong_password_rejected(client):
    login_r = await _register_and_login(client)
    r = await client.post(
        "/me/email/change",
        json={"new_email": _NEW, "current_password": "not the password"},
        headers=_bearer(login_r),
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_email_change_unchanged_rejected(client):
    login_r = await _register_and_login(client)
    r = await client.post(
        "/me/email/change",
        json={"new_email": _REG["email"], "current_password": _REG["password"]},
        headers=_bearer(login_r),
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_email_change_to_taken_address_conflicts(client):
    """Requesting a change to an address another account owns -> 409."""
    # First account owns _NEW.
    await client.post(
        "/register",
        json={
            "username": "owns_target",
            "email": _NEW,
            "password": "another good passphrase 00",
            "display_name": "Owner",
        },
    )
    login_r = await _register_and_login(client)  # second account
    r = await client.post(
        "/me/email/change",
        json={"new_email": _NEW, "current_password": _REG["password"]},
        headers=_bearer(login_r),
    )
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_email_change_confirm_bad_token(client):
    r = await client.post(
        "/me/email/change/confirm", json={"token": "this-token-does-not-exist"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_email_change_requires_auth(client):
    await client.post("/register", json=_REG)
    r = await client.post(
        "/me/email/change",
        json={"new_email": _NEW, "current_password": _REG["password"]},
    )
    assert r.status_code == 401
