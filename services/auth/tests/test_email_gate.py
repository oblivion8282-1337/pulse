"""Tests for the email-verification hard gate (Phase 1 — auth-svc side).

The gate is active only when SMTP is configured. When active, freshly-issued
access tokens for unverified accounts carry an ``email_blocked`` claim, and
``GET /me`` reports ``email_verification_pending = true``. chat-gateway and
voice-signaling consume the claim (tested in those services).

SMTP is "configured" here by writing the ``smtp_settings`` singleton directly
— faster than the admin PATCH and decoupled from the admin-auth dance. The
``mock_smtp`` fixture stubs the transport so register's auto-fired
verification mail never opens a socket.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from dcc_auth.models import SmtpSettings, User
from dcc_auth.security import get_signer
from sqlalchemy import select


async def _register(client, *, username: str, email: str) -> dict:
    r = await client.post(
        "/register",
        json={
            "username": username,
            "email": email,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _configure_smtp(session_factory) -> None:
    """Flip the SMTP singleton to configured — the gate's on-switch."""
    async with session_factory() as s:
        row = await s.get(SmtpSettings, 1)
        row.host = "mail.example.com"
        row.from_email = "noreply@example.com"
        row.configured = True
        await s.commit()


def _claims(token: str) -> dict:
    return get_signer().decode(token, expected_type="access")


async def _me(client, token: str) -> dict:
    r = await client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest_asyncio.fixture
def mock_smtp(monkeypatch) -> AsyncIterator[list[dict]]:
    """Stub ``_send_smtp_sync`` so register's verify-mail never hits the wire."""
    calls: list[dict] = []
    monkeypatch.setattr(
        "dcc_auth.email._send_smtp_sync",
        lambda cfg, to, subject, body: calls.append({"to": to}),
    )
    return calls


# ---- gate OFF (no SMTP) -------------------------------------------------


@pytest.mark.asyncio
async def test_no_smtp_token_has_no_block_claim(client):
    """Fresh self-host without SMTP: gate off, no claim, nothing pending."""
    tokens = await _register(client, username="alice", email="alice@example.com")
    assert "email_blocked" not in _claims(tokens["access_token"])

    body = await _me(client, tokens["access_token"])
    assert body["email_verification_pending"] is False


# ---- gate ON (SMTP configured) ------------------------------------------


@pytest.mark.asyncio
async def test_smtp_configured_register_token_is_blocked(
    client, session_factory, mock_smtp
):
    """With SMTP on, a freshly-registered (unverified) account is blocked."""
    await _configure_smtp(session_factory)
    tokens = await _register(client, username="bob", email="bob@example.com")

    assert _claims(tokens["access_token"]).get("email_blocked") is True
    body = await _me(client, tokens["access_token"])
    assert body["email_verification_pending"] is True


@pytest.mark.asyncio
async def test_verified_account_not_blocked_after_refresh(
    client, session_factory, mock_smtp
):
    """Once the account is verified, the next minted token drops the claim."""
    await _configure_smtp(session_factory)
    tokens = await _register(client, username="carol", email="carol@example.com")
    assert _claims(tokens["access_token"]).get("email_blocked") is True

    # Simulate the verify-confirm having stamped the column.
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == "carol"))
        ).scalar_one()
        from datetime import UTC, datetime

        user.email_verified_at = datetime.now(UTC)
        await s.commit()

    r = await client.post("/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 200, r.text
    fresh = r.json()
    assert "email_blocked" not in _claims(fresh["access_token"])
    body = await _me(client, fresh["access_token"])
    assert body["email_verification_pending"] is False


# ---- grandfathering on SMTP-enable --------------------------------------


@pytest.mark.asyncio
async def test_enabling_smtp_grandfathers_existing_users(
    client, session_factory, mock_smtp
):
    """Accounts that exist when SMTP is first saved are grandfathered;
    accounts registering afterwards face the gate."""
    # alice = bootstrap admin, bob = registered before SMTP — both unverified.
    admin = await _register(client, username="alice", email="alice@example.com")
    await _register(client, username="bob", email="bob@example.com")

    # Admin configures SMTP through the real endpoint (triggers the
    # not-configured → configured transition + grandfather sweep).
    r = await client.patch(
        "/admin/smtp",
        json={
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "from_email": "noreply@example.com",
            "use_ssl": False,
        },
        headers={"Authorization": f"Bearer {admin['access_token']}"},
    )
    assert r.status_code == 200, r.text

    # bob existed before the switch → grandfathered, not pending.
    async with session_factory() as s:
        bob = (
            await s.execute(select(User).where(User.username == "bob"))
        ).scalar_one()
        assert bob.email_verified_at is not None

    # A user registering AFTER the switch is unverified → blocked.
    late = await _register(client, username="dave", email="dave@example.com")
    assert _claims(late["access_token"]).get("email_blocked") is True
    body = await _me(client, late["access_token"])
    assert body["email_verification_pending"] is True
