"""Login timing-oracle defense (bug 9 regression).

A login attempt for a non-existent user must perform the same Argon2 work as
one for an existing user, so response time cannot be used to enumerate
accounts. We assert the dummy-verify helper is invoked on the
non-existent-user path rather than measuring wall-clock (which is flaky).
"""

from __future__ import annotations

import dcc_auth.routes as routes_mod
import dcc_auth.security as security_mod
import pytest

_PW = "correct horse battery staple"


@pytest.mark.asyncio
async def test_dummy_verify_runs_for_unknown_user(client, monkeypatch):
    """POST /login for a non-existent user runs verify_dummy_password once."""
    calls: list[str] = []

    real_dummy = security_mod.verify_dummy_password

    def spy(plaintext: str) -> None:
        calls.append(plaintext)
        return real_dummy(plaintext)

    # routes.py imports the symbol by name, so patch it there.
    monkeypatch.setattr(routes_mod, "verify_dummy_password", spy)

    r = await client.post(
        "/login",
        json={"email_or_username": "ghost@dcc-test.example.com", "password": _PW},
    )
    assert r.status_code == 401
    assert calls == [_PW], "dummy Argon2 verify must run once for unknown users"


@pytest.mark.asyncio
async def test_dummy_verify_not_run_for_existing_user(client, monkeypatch):
    """For an existing user the real verify runs, not the dummy equalizer."""
    await client.post(
        "/register",
        json={
            "username": "timing_user",
            "email": "timing@dcc-test.example.com",
            "password": _PW,
        },
    )

    calls: list[str] = []
    monkeypatch.setattr(
        routes_mod, "verify_dummy_password", lambda pw: calls.append(pw)
    )

    # Wrong password, but the user exists -> real verify path, no dummy.
    r = await client.post(
        "/login",
        json={"email_or_username": "timing@dcc-test.example.com", "password": "wrong"},
    )
    assert r.status_code == 401
    assert calls == [], "existing-user path must not call the dummy equalizer"


def test_verify_dummy_password_is_constant_and_safe():
    """The helper never raises and ignores its input value."""
    security_mod.verify_dummy_password("anything")
    security_mod.verify_dummy_password("")
