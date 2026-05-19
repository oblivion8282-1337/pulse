"""Tests for the SMTP admin routes (GET/PATCH/POST /admin/smtp[/test]).

The SMTP transport is mocked out at ``dcc_auth.email._send_smtp_sync`` so the
tests verify config-resolution + persistence + audit-logging without ever
opening a real socket. The fixture reuses ``test_admin``'s register/promote/
login dance so the admin-claim flow stays close to production.
"""

from __future__ import annotations

import smtplib
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import select

from dcc_auth.crypto import decrypt_secret, encrypt_secret
from dcc_auth.models import AdminAuditLog, SmtpSettings, User


async def _register_user(client, *, username: str, email: str) -> str:
    r = await client.post(
        "/register",
        json={
            "username": username,
            "email": email,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


async def _promote(session_factory, username: str) -> int:
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == username))
        ).scalar_one()
        user.is_admin = True
        await s.commit()
        return user.id


async def _login(client, *, username_or_email: str) -> str:
    r = await client.post(
        "/login",
        json={
            "email_or_username": username_or_email,
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest_asyncio.fixture
async def admin_token(client, session_factory) -> str:
    await _register_user(client, username="alice", email="alice@example.com")
    await _promote(session_factory, "alice")
    return await _login(client, username_or_email="alice")


@pytest_asyncio.fixture
async def regular_token(client) -> str:
    # Burn the bootstrap-admin slot so bob arrives as a regular user.
    await _register_user(client, username="bootstrap", email="bootstrap@example.com")
    return await _register_user(client, username="bob", email="bob@example.com")


@pytest_asyncio.fixture
def mock_smtp(monkeypatch) -> AsyncIterator[list[dict]]:
    """Capture every ``_send_smtp_sync`` call without hitting the wire.

    Returns a list the tests append to (each call appends one dict). Patches
    the function in-place on the module so both ``send_email`` and
    ``send_email_with`` route through it.
    """
    calls: list[dict] = []

    def _fake_send(cfg, to, subject, body_plain):  # noqa: ANN001
        calls.append(
            {
                "host": cfg.host,
                "port": cfg.port,
                "username": cfg.username,
                "password": cfg.password,
                "from_email": cfg.from_email,
                "use_ssl": cfg.use_ssl,
                "to": to,
                "subject": subject,
                "body": body_plain,
            }
        )

    monkeypatch.setattr("dcc_auth.email._send_smtp_sync", _fake_send)
    return calls


# ---- gate ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_smtp_routes_403_for_non_admin(client, regular_token):
    headers = {"Authorization": f"Bearer {regular_token}"}
    for path in ("/admin/smtp",):
        r = await client.get(path, headers=headers)
        assert r.status_code == 403, f"{path}: {r.text}"

    r = await client.patch(
        "/admin/smtp",
        json={"provider": "custom", "port": 587, "use_ssl": False},
        headers=headers,
    )
    assert r.status_code == 403

    r = await client.post(
        "/admin/smtp/test", json={"to": "x@example.com"}, headers=headers
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_smtp_routes_401_without_token(client):
    r = await client.get("/admin/smtp")
    assert r.status_code == 401


# ---- GET ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_smtp_returns_unconfigured_defaults(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/smtp", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # Fresh DB: singleton seeded with provider=custom, all other fields null.
    assert body["provider"] == "custom"
    assert body["host"] is None
    assert body["port"] == 587
    assert body["use_ssl"] is False
    assert body["configured"] is False
    assert body["has_password"] is False
    # No plaintext OR ciphertext password ever crosses the wire.
    assert "password" not in body
    assert "password_encrypted" not in body


# ---- PATCH --------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_smtp_full_save_marks_configured(
    client, admin_token, session_factory
):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.patch(
        "/admin/smtp",
        json={
            "provider": "brevo",
            "host": "smtp-relay.brevo.com",
            "port": 587,
            "username": "demo@smtp-brevo.com",
            "password": "the-smtp-key",
            "from_email": "noreply@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "brevo"
    assert body["host"] == "smtp-relay.brevo.com"
    assert body["configured"] is True
    assert body["has_password"] is True
    # Verify the DB row really has the encrypted ciphertext (not plaintext).
    async with session_factory() as s:
        row = await s.get(SmtpSettings, 1)
        assert row is not None
        assert row.password_encrypted is not None
        assert row.password_encrypted != "the-smtp-key"
        assert decrypt_secret(row.password_encrypted) == "the-smtp-key"


@pytest.mark.asyncio
async def test_patch_smtp_password_none_preserves_existing(
    client, admin_token, session_factory
):
    """Second PATCH without ``password`` must NOT clobber the stored one."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    # First save with password.
    await client.patch(
        "/admin/smtp",
        json={
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "password": "keep-me",
            "from_email": "a@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    # Second save: edit only the From-Email, leave password field absent.
    r = await client.patch(
        "/admin/smtp",
        json={
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "from_email": "b@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["from_email"] == "b@example.com"
    assert body["has_password"] is True

    async with session_factory() as s:
        row = await s.get(SmtpSettings, 1)
        assert decrypt_secret(row.password_encrypted) == "keep-me"


@pytest.mark.asyncio
async def test_patch_smtp_empty_password_clears_existing(
    client, admin_token, session_factory
):
    headers = {"Authorization": f"Bearer {admin_token}"}
    await client.patch(
        "/admin/smtp",
        json={
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "password": "to-be-cleared",
            "from_email": "a@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    r = await client.patch(
        "/admin/smtp",
        json={
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "password": "",
            "from_email": "a@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["has_password"] is False

    async with session_factory() as s:
        row = await s.get(SmtpSettings, 1)
        assert (row.password_encrypted or "") == ""


@pytest.mark.asyncio
async def test_patch_smtp_writes_audit_log(client, admin_token, session_factory):
    headers = {"Authorization": f"Bearer {admin_token}"}
    await client.patch(
        "/admin/smtp",
        json={
            "provider": "resend",
            "host": "smtp.resend.com",
            "port": 465,
            "username": "resend",
            "password": "re_xxx",
            "from_email": "noreply@example.com",
            "use_ssl": True,
        },
        headers=headers,
    )
    async with session_factory() as s:
        rows = (
            await s.execute(select(AdminAuditLog).where(AdminAuditLog.action == "smtp.patch"))
        ).scalars().all()
        assert len(rows) == 1
        entry = rows[0]
        # Sensitive value must not appear in the audit payload.
        flat = repr(entry.payload)
        assert "re_xxx" not in flat
        assert "password" in entry.payload
        assert entry.payload["password"] == {"changed": True}
        assert entry.payload["host"]["to"] == "smtp.resend.com"
        assert entry.payload["configured"]["to"] is True


@pytest.mark.asyncio
async def test_patch_smtp_rejects_invalid_provider(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.patch(
        "/admin/smtp",
        json={
            "provider": "not-a-known-preset",
            "host": "x",
            "port": 587,
            "from_email": "a@b.de",
            "use_ssl": False,
        },
        headers=headers,
    )
    assert r.status_code == 422


# ---- POST /smtp/test ----------------------------------------------------


@pytest.mark.asyncio
async def test_test_smtp_inline_config_succeeds(
    client, admin_token, mock_smtp
):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.post(
        "/admin/smtp/test",
        json={
            "to": "alice@example.com",
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "username": "smtp-user",
            "password": "fresh-not-yet-saved",
            "from_email": "noreply@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "error": None}
    assert len(mock_smtp) == 1
    call = mock_smtp[0]
    assert call["host"] == "mail.example.com"
    assert call["password"] == "fresh-not-yet-saved"  # used inline, never encrypted
    assert call["to"] == "alice@example.com"
    assert "SMTP-Test" in call["subject"]


@pytest.mark.asyncio
async def test_test_smtp_falls_back_to_saved_password(
    client, admin_token, session_factory, mock_smtp
):
    headers = {"Authorization": f"Bearer {admin_token}"}
    # Plant a saved row with an encrypted password.
    async with session_factory() as s:
        row = await s.get(SmtpSettings, 1)
        row.provider = "custom"
        row.host = "saved.example.com"
        row.port = 587
        row.username = "saved-user"
        row.password_encrypted = encrypt_secret("saved-secret")
        row.from_email = "saved@example.com"
        row.use_ssl = False
        row.configured = True
        await s.commit()

    r = await client.post(
        "/admin/smtp/test",
        json={"to": "alice@example.com"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    assert mock_smtp[-1]["host"] == "saved.example.com"
    assert mock_smtp[-1]["password"] == "saved-secret"


@pytest.mark.asyncio
async def test_test_smtp_returns_error_on_smtp_failure(
    client, admin_token, monkeypatch
):
    """SMTP server raises ⇒ ``ok=false`` with the exception message verbatim."""
    headers = {"Authorization": f"Bearer {admin_token}"}

    def _boom(cfg, to, subject, body_plain):  # noqa: ANN001
        raise smtplib.SMTPAuthenticationError(535, b"5.7.0 Authentication failed")

    monkeypatch.setattr("dcc_auth.email._send_smtp_sync", _boom)
    r = await client.post(
        "/admin/smtp/test",
        json={
            "to": "alice@example.com",
            "provider": "custom",
            "host": "mail.example.com",
            "port": 587,
            "password": "wrong",
            "from_email": "noreply@example.com",
            "use_ssl": False,
        },
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "SMTPAuthenticationError" in body["error"]
    assert "535" in body["error"]


@pytest.mark.asyncio
async def test_test_smtp_requires_host_and_from(client, admin_token):
    """Without host/from_email (no saved row + no inline override), refuse fast."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.post(
        "/admin/smtp/test", json={"to": "alice@example.com"}, headers=headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "Host" in body["error"]
