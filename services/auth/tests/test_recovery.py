"""Tests for the password-reset, email-verify and TOTP flows."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pyotp
import pytest
from dcc_auth.models import (
    BackupCode,
    EmailVerificationToken,
    PasswordResetToken,
    RefreshToken,
    User,
)
from dcc_auth.recovery import hash_token
from sqlalchemy import select

REG = {
    "username": "alice",
    "email": "alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


async def _register(client) -> dict:
    r = await client.post("/register", json=REG)
    assert r.status_code == 201, r.text
    return r.json()


async def _forgot_and_reset(client, monkeypatch, new_password: str):
    """Run the forgot → reset flow, returning the ``/password/reset`` response.

    The plaintext token only ever exists in the mail body, so spy on the
    composer (no SMTP) instead of reading the DB, which stores it hashed.
    """
    from dcc_auth import routes_recovery

    captured: dict[str, str] = {}
    real_compose = routes_recovery.compose_password_reset_email

    def _spy_compose(to, url):
        captured["url"] = url
        return real_compose(to, url)

    monkeypatch.setattr(routes_recovery, "compose_password_reset_email", _spy_compose)

    assert (
        await client.post("/password/forgot", json={"email_or_username": REG["email"]})
    ).status_code == 204
    return await client.post(
        "/password/reset",
        json={
            "token": captured["url"].rsplit("/", 1)[1],
            "new_password": new_password,
        },
    )


# ---- Password forgot/reset ---------------------------------------------


@pytest.mark.asyncio
async def test_password_forgot_returns_204_for_missing_user(client):
    r = await client.post("/password/forgot", json={"email_or_username": "ghost@ex.com"})
    assert r.status_code == 204
    assert r.text == ""  # no body — pure enumeration guard


@pytest.mark.asyncio
async def test_password_forgot_suspended_user_is_silent(client, session_factory):
    """A suspended account must be indistinguishable from a non-existent one:
    204, and crucially NO reset token issued (it could otherwise be redeemed)."""
    await _register(client)
    async with session_factory() as s:
        user = (await s.execute(select(User))).scalar_one()
        user.is_suspended = True
        await s.commit()

    r = await client.post("/password/forgot", json={"email_or_username": REG["email"]})
    assert r.status_code == 204
    async with session_factory() as s:
        rows = (await s.execute(select(PasswordResetToken))).scalars().all()
        assert rows == []  # no token leaked for a suspended account


@pytest.mark.asyncio
async def test_password_forgot_creates_token_and_invalidates_old(client, session_factory):
    await _register(client)

    r1 = await client.post(
        "/password/forgot", json={"email_or_username": REG["email"]}
    )
    assert r1.status_code == 204
    r2 = await client.post(
        "/password/forgot", json={"email_or_username": REG["email"]}
    )
    assert r2.status_code == 204

    async with session_factory() as s:
        rows = (
            await s.execute(select(PasswordResetToken).order_by(PasswordResetToken.id))
        ).scalars().all()
        assert len(rows) == 2
        # Older row must have used_at stamped (invalidated by the second issue).
        assert rows[0].used_at is not None
        assert rows[1].used_at is None


@pytest.mark.asyncio
async def test_password_reset_changes_password_and_revokes_refreshes(
    client, session_factory, monkeypatch
):
    tokens = await _register(client)
    r = await _forgot_and_reset(client, monkeypatch, "new-password-12345")
    assert r.status_code == 200, r.text

    # Old refresh dead.
    r_refresh = await client.post(
        "/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert r_refresh.status_code == 401

    # New password works.
    r_login = await client.post(
        "/login",
        json={"email_or_username": REG["email"], "password": "new-password-12345"},
    )
    assert r_login.status_code == 200, r_login.text

    # Old password rejected.
    r_old = await client.post(
        "/login",
        json={"email_or_username": REG["email"], "password": REG["password"]},
    )
    assert r_old.status_code == 401


@pytest.mark.asyncio
async def test_password_reset_kills_browser_sessions(
    client, session_factory, monkeypatch
):
    """A reset must revoke browser sessions, not just refresh tokens.

    A stolen ``pulse_session`` cookie would otherwise outlive the reset
    indefinitely — ``validate_session`` slides ``expires_at`` forward on every
    request — and could still mint a device cert via ``/credentials/issue``
    unless ``revoke_until`` is raised. See ``routes_recovery.password_reset``.
    """

    await _register(client)
    login_r = await client.post(
        "/login", json={"email_or_username": REG["email"], "password": REG["password"]}
    )
    assert login_r.status_code == 200, login_r.text
    sid = login_r.cookies["pulse_session"]
    # The stolen cookie works before the reset.
    assert (
        await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    ).status_code == 200

    r = await _forgot_and_reset(client, monkeypatch, "new-password-12345")
    assert r.status_code == 200, r.text

    # ... and is dead after it.
    assert (
        await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    ).status_code == 401, "session cookie survived a password reset"

    async with session_factory() as s:
        user = (await s.execute(select(User))).scalar_one()
        assert user.revoke_until is not None, "reset left revoke_until unset"


@pytest.mark.asyncio
async def test_password_reset_rejects_expired_token(client, session_factory):
    await _register(client)
    await client.post("/password/forgot", json={"email_or_username": REG["email"]})

    async with session_factory() as s:
        row = (await s.execute(select(PasswordResetToken))).scalar_one()
        # Force-expire by rewinding expires_at.
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        # We don't know plaintext — but reset_token verify works on hash; we
        # instead reverse-engineer via the spy used in the happy path. Simpler:
        # craft a known plaintext and persist its hash.
        plaintext = "manual-expired-token-XYZ"
        row.token_hash = hash_token(plaintext)
        await s.commit()

    r = await client.post(
        "/password/reset",
        json={"token": plaintext, "new_password": "fresh-password-12345"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_password_reset_rejects_used_token(client, session_factory):
    await _register(client)
    await client.post("/password/forgot", json={"email_or_username": REG["email"]})

    plaintext = "single-use-test-token-abc"
    async with session_factory() as s:
        row = (await s.execute(select(PasswordResetToken))).scalar_one()
        row.token_hash = hash_token(plaintext)
        await s.commit()

    r1 = await client.post(
        "/password/reset",
        json={"token": plaintext, "new_password": "fresh-password-12345"},
    )
    assert r1.status_code == 200
    r2 = await client.post(
        "/password/reset",
        json={"token": plaintext, "new_password": "another-password-12345"},
    )
    assert r2.status_code == 401


# ---- Email verify -------------------------------------------------------


@pytest.mark.asyncio
async def test_email_verify_send_authenticated_only(client):
    r = await client.post("/email/verification/send")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_email_verify_confirm_sets_verified_at(
    client, session_factory, monkeypatch
):
    captured: dict[str, str] = {}

    # Spy on the verify-mail composer in email.py — both register's auto-fire
    # and the explicit /email/verification/send route go through it.
    # Last-write-wins means ``captured["url"]`` holds the *most recent* token,
    # which matches what a real user would click in their inbox.
    from dcc_auth import email as email_mod

    real_compose = email_mod.compose_email_verification

    def _spy(to, url):
        captured["url"] = url
        return real_compose(to, url)

    monkeypatch.setattr(email_mod, "compose_email_verification", _spy)

    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    r = await client.post("/email/verification/send", headers=bearer)
    assert r.status_code == 204

    token = captured["url"].rsplit("/", 1)[1]
    r2 = await client.post("/email/verification/confirm", json={"token": token})
    assert r2.status_code == 200, r2.text

    me = (await client.get("/me", headers=bearer)).json()
    assert me["email_verified_at"] is not None


# ---- TOTP setup / verify ------------------------------------------------


@pytest.mark.asyncio
async def test_totp_setup_returns_secret_and_qr(client):
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    r = await client.post("/totp/setup", headers=bearer)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["secret"]
    assert body["qr_png_base64"]
    assert body["provisioning_uri"].startswith("otpauth://totp/")


@pytest.mark.asyncio
async def test_totp_verify_setup_enables_and_returns_backup_codes(
    client, session_factory
):
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    setup = (await client.post("/totp/setup", headers=bearer)).json()
    code = pyotp.TOTP(setup["secret"]).now()

    r = await client.post(
        "/totp/verify-setup", json={"code": code, "password": REG["password"]}, headers=bearer
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["backup_codes"]) == 10
    for c in body["backup_codes"]:
        assert len(c) == 8

    async with session_factory() as s:
        # totp_enabled toggled on
        user = (await s.execute(select(User))).scalar_one()
        assert user.totp_enabled is True
        # backup codes persisted as hashes
        rows = (await s.execute(select(BackupCode))).scalars().all()
        assert len(rows) == 10
        # hashes != plaintext
        plaintext_set = set(body["backup_codes"])
        for r_ in rows:
            assert r_.code_hash not in plaintext_set


@pytest.mark.asyncio
async def test_totp_disable_requires_password_and_code(client):
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    setup = (await client.post("/totp/setup", headers=bearer)).json()
    code = pyotp.TOTP(setup["secret"]).now()
    await client.post("/totp/verify-setup", json={"code": code, "password": REG["password"]}, headers=bearer)

    # Wrong password — rejected.
    r1 = await client.post(
        "/totp/disable",
        json={
            "password": "wrong",
            "code": pyotp.TOTP(setup["secret"]).now(),
        },
        headers=bearer,
    )
    assert r1.status_code == 401

    # Right password, no second factor — rejected.
    r2 = await client.post(
        "/totp/disable",
        json={"password": REG["password"]},
        headers=bearer,
    )
    assert r2.status_code == 401

    # Right password + right code — succeeds.
    r3 = await client.post(
        "/totp/disable",
        json={
            "password": REG["password"],
            "code": pyotp.TOTP(setup["secret"]).now(),
        },
        headers=bearer,
    )
    assert r3.status_code == 200


# ---- Login with 2FA -----------------------------------------------------


async def _enable_2fa(client, bearer) -> str:
    setup = (await client.post("/totp/setup", headers=bearer)).json()
    code = pyotp.TOTP(setup["secret"]).now()
    r = await client.post("/totp/verify-setup", json={"code": code, "password": REG["password"]}, headers=bearer)
    assert r.status_code == 200
    return setup["secret"]


@pytest.mark.asyncio
async def test_backup_regen_rejects_replayed_totp_code(client):
    """The same live TOTP code must not pass /totp/backup-codes/regenerate
    twice — replay protection (totp_last_counter) applies here as in login."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    secret = await _enable_2fa(client, bearer)

    code = pyotp.TOTP(secret).now()
    r1 = await client.post(
        "/totp/backup-codes/regenerate",
        json={"password": REG["password"], "code": code},
        headers=bearer,
    )
    assert r1.status_code == 200, r1.text

    # Replay the exact same code in the same window → must be rejected.
    r2 = await client.post(
        "/totp/backup-codes/regenerate",
        json={"password": REG["password"], "code": code},
        headers=bearer,
    )
    assert r2.status_code == 401


@pytest.mark.asyncio
async def test_login_with_totp_enabled_returns_mfa_ticket(client):
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    await _enable_2fa(client, bearer)

    r = await client.post(
        "/login",
        json={"email_or_username": REG["email"], "password": REG["password"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("requires_mfa") is True
    assert body.get("methods") == ["totp"]
    assert body.get("mfa_ticket")
    assert "access_token" not in body


@pytest.mark.asyncio
async def test_login_totp_step2_with_code(client):
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    secret = await _enable_2fa(client, bearer)

    step1 = (
        await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
    ).json()

    code = pyotp.TOTP(secret).now()
    r = await client.post(
        "/login/totp",
        json={"mfa_ticket": step1["mfa_ticket"], "code": code},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["refresh_token"]


@pytest.mark.asyncio
async def test_login_totp_step2_with_backup_code(client, session_factory):
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    await _enable_2fa(client, bearer)

    # Grab one backup code (we regenerate to get plaintext access).
    setup_again = (await client.post("/totp/setup", headers=bearer))
    # totp_enabled is true → 409 expected here
    assert setup_again.status_code == 409
    # So instead: regenerate to capture plaintext codes.
    async with session_factory() as s:
        user = (await s.execute(select(User))).scalar_one()
        secret = user.totp_secret

    regen = await client.post(
        "/totp/backup-codes/regenerate",
        json={"password": REG["password"], "code": pyotp.TOTP(secret).now()},
        headers=bearer,
    )
    assert regen.status_code == 200, regen.text
    backup = regen.json()["backup_codes"][0]

    step1 = (
        await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
    ).json()

    r = await client.post(
        "/login/totp",
        json={"mfa_ticket": step1["mfa_ticket"], "backup_code": backup},
    )
    assert r.status_code == 200, r.text

    # Backup code must now be single-use → reject on replay.
    step1b = (
        await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
    ).json()
    r2 = await client.post(
        "/login/totp",
        json={"mfa_ticket": step1b["mfa_ticket"], "backup_code": backup},
    )
    assert r2.status_code == 401

    # DB row stamped.
    async with session_factory() as s:
        used = (
            await s.execute(
                select(BackupCode).where(BackupCode.used_at.is_not(None))
            )
        ).scalars().all()
        assert len(used) == 1


@pytest.mark.asyncio
async def test_login_totp_rejects_expired_ticket(client):
    """Manually mint a ticket with exp=-1 — exactly what an expired one
    would look like — and confirm the second step rejects it."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    secret = await _enable_2fa(client, bearer)

    from dcc_auth.recovery import issue_mfa_ticket
    from dcc_auth.security import get_signer

    # Resolve the current user id from /me so we can craft a ticket.
    me = (await client.get("/me", headers=bearer)).json()
    expired_ticket = issue_mfa_ticket(get_signer(), int(me["id"]), ttl_seconds=-10)

    code = pyotp.TOTP(secret).now()
    r = await client.post(
        "/login/totp",
        json={"mfa_ticket": expired_ticket, "code": code},
    )
    assert r.status_code == 401


# ---- MFA ticket single-use (replay protection) -------------------------


@pytest.mark.asyncio
async def test_mfa_ticket_carries_single_use_jti():
    """Every minted ticket has a random jti; decode round-trips it."""
    from dcc_auth.recovery import decode_mfa_ticket, issue_mfa_ticket
    from dcc_auth.security import get_signer

    signer = get_signer()
    uid, jti = decode_mfa_ticket(signer, issue_mfa_ticket(signer, 4242, 300))
    assert uid == 4242
    assert jti and len(jti) == 32  # secrets.token_hex(16)


@pytest.mark.asyncio
async def test_claim_mfa_ticket_is_single_use(monkeypatch):
    """The Redis NX claim wins exactly once per jti; fail-open without Redis."""
    import redis.asyncio

    from dcc_auth import recovery

    store: dict[str, str] = {}

    class _FakeRedis:
        async def set(self, key, val, nx=False, ex=None):
            if nx and key in store:
                return None
            store[key] = val
            return True

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(redis.asyncio.Redis, "from_url", lambda *a, **k: _FakeRedis())

    # First claim wins, the replay loses, a different jti is independent.
    assert await recovery.claim_mfa_ticket("redis://x", "jti-1", 300) is True
    assert await recovery.claim_mfa_ticket("redis://x", "jti-1", 300) is False
    assert await recovery.claim_mfa_ticket("redis://x", "jti-2", 300) is True

    # Fail-open: a legacy ticket (no jti) or unconfigured Redis must not lock out.
    assert await recovery.claim_mfa_ticket("redis://x", None, 300) is True
    assert await recovery.claim_mfa_ticket(None, "jti-3", 300) is True

    # Fail-open on a Redis error (down/unreachable) — login must still proceed.
    def _boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(redis.asyncio.Redis, "from_url", _boom)
    assert await recovery.claim_mfa_ticket("redis://x", "jti-4", 300) is True


@pytest.mark.asyncio
async def test_login_totp_claims_the_ticket_jti(client, monkeypatch):
    """A successful 2FA login claims a real (non-None) jti for single use."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    secret = await _enable_2fa(client, bearer)

    seen: dict[str, str | None] = {}

    async def _fake_claim(url, jti, ttl):
        seen["jti"] = jti
        return True

    monkeypatch.setattr("dcc_auth.routes_totp.claim_mfa_ticket", _fake_claim)

    step1 = (
        await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
    ).json()
    r = await client.post(
        "/login/totp",
        json={"mfa_ticket": step1["mfa_ticket"], "code": pyotp.TOTP(secret).now()},
    )
    assert r.status_code == 200, r.text
    assert seen.get("jti")  # the ticket's jti reached the single-use claim


@pytest.mark.asyncio
async def test_login_totp_rejects_already_claimed_ticket(client, monkeypatch):
    """When the jti is already used (claim → False), the second step 401s even
    with a valid code — this is the replay block an intercepted ticket hits."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    secret = await _enable_2fa(client, bearer)

    async def _used_claim(url, jti, ttl):
        return False

    monkeypatch.setattr("dcc_auth.routes_totp.claim_mfa_ticket", _used_claim)

    step1 = (
        await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
    ).json()
    r = await client.post(
        "/login/totp",
        json={"mfa_ticket": step1["mfa_ticket"], "code": pyotp.TOTP(secret).now()},
    )
    assert r.status_code == 401


# ---- Background invariants ---------------------------------------------


@pytest.mark.asyncio
async def test_no_refresh_tokens_left_after_reset(client, session_factory, monkeypatch):
    captured: dict[str, str] = {}
    from dcc_auth import routes_recovery

    real = routes_recovery.compose_password_reset_email
    monkeypatch.setattr(
        routes_recovery,
        "compose_password_reset_email",
        lambda t, u: (captured.setdefault("url", u), real(t, u))[1],
    )

    await _register(client)
    await client.post("/password/forgot", json={"email_or_username": REG["email"]})
    token = captured["url"].rsplit("/", 1)[1]
    await client.post(
        "/password/reset",
        json={"token": token, "new_password": "fresh-password-12345"},
    )
    async with session_factory() as s:
        active = (
            await s.execute(
                select(RefreshToken).where(RefreshToken.revoked_at.is_(None))
            )
        ).scalars().all()
        assert active == []


@pytest.mark.asyncio
async def test_register_auto_fires_verify_email(
    client, session_factory, monkeypatch
):
    """Registration alone (without any further calls) must leave a fresh
    verify-token in the DB AND have invoked the mail composer once. The
    inbox-link UX depends on this: a new user clicks register, the redirect
    to /app finishes, and the mail with the link is already on its way.
    """
    captured: list[str] = []

    from dcc_auth import email as email_mod

    real_compose = email_mod.compose_email_verification

    def _spy(to, url):
        captured.append(url)
        return real_compose(to, url)

    monkeypatch.setattr(email_mod, "compose_email_verification", _spy)

    await _register(client)

    assert len(captured) == 1
    async with session_factory() as s:
        rows = (
            await s.execute(select(EmailVerificationToken))
        ).scalars().all()
        assert len(rows) == 1
        assert rows[0].used_at is None  # fresh, ready to redeem


@pytest.mark.asyncio
async def test_register_succeeds_when_verify_mail_fails(
    client, session_factory, monkeypatch
):
    """A flaky SMTP relay must NOT abort registration — the user account is
    created, an access token is returned, the verify-token row exists for
    later manual resend. Only the outbound send is the casualty."""
    from dcc_auth import email as email_mod

    async def _boom(*args, **kwargs):
        raise RuntimeError("smtp relay melted")

    monkeypatch.setattr(email_mod, "send_email", _boom)

    r = await client.post("/register", json=REG)
    assert r.status_code == 201, r.text
    assert "access_token" in r.json()
    # The token row was committed before the send was attempted.
    async with session_factory() as s:
        rows = (
            await s.execute(select(EmailVerificationToken))
        ).scalars().all()
        assert len(rows) == 1


@pytest.mark.asyncio
async def test_email_verify_token_in_db(client, session_factory):
    """After register (auto-fire) + manual resend, exactly ONE open token
    exists. The earlier register-token gets marked ``used_at`` by the resend
    so the user can't accidentally consume a stale link."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    r = await client.post("/email/verification/send", headers=bearer)
    assert r.status_code == 204
    async with session_factory() as s:
        rows = (
            await s.execute(select(EmailVerificationToken))
        ).scalars().all()
        open_rows = [r for r in rows if r.used_at is None]
        assert len(open_rows) == 1
        assert len(rows) == 2  # one from register, one from /send
        # plaintext never leaked
        assert all(len(r.token_hash) == 64 for r in rows)  # sha256 hex


@pytest.mark.asyncio
async def test_totp_enable_requires_the_password(client):
    """**Auch das EINschalten braucht das Passwort, nicht nur das Abschalten.**

    Wer kurz an ein gueltiges Zugangs-Token kommt, koennte sonst ein eigenes
    TOTP-Geraet scharfschalten — der echte Inhaber ist beim naechsten Login
    ausgesperrt, und einen Admin-Weg zurueck gibt es nicht. Die Schranke gab es
    beim Abschalten laengst (`totp_disable`), beim Einschalten bis 2026-08-13
    nicht.
    """
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    setup = (await client.post("/totp/setup", headers=bearer)).json()
    code = pyotp.TOTP(setup["secret"]).now()

    r = await client.post(
        "/totp/verify-setup",
        json={"code": code, "password": "falsch-falsch-falsch"},
        headers=bearer,
    )
    assert r.status_code == 401, r.text

    # Und 2FA ist NICHT an — der richtige Code allein hat nichts bewirkt.
    me = (await client.get("/me", headers=bearer)).json()
    assert me.get("totp_enabled") is not True
