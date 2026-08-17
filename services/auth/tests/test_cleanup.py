"""Token-cleanup sweep — three deleted cohorts plus a keep-alive case.

The loop's error-resilience (swallow + sleep + continue) is exercised via
a mock at the bottom; the actual delete predicates against each of the
three tables get a dedicated test each.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from dcc_auth.cleanup import _run_once, cleanup_loop
from dcc_auth.config import Settings
from dcc_auth.models import (
    BackupCode,
    EmailVerificationToken,
    PasswordResetToken,
    RefreshToken,
    User,
    UsernameReservation,
)
from sqlalchemy import select


def _settings() -> Settings:
    """A throwaway Settings that doesn't touch ``get_settings``."""
    return Settings(
        token_cleanup_interval_seconds=86400,
        token_cleanup_grace_days_expired=7,
        token_cleanup_grace_days_revoked=30,
    )


async def _make_user(session_factory) -> int:
    """Insert one minimal user so the FK targets exist. Returns the id."""
    uid = 1234567890
    async with session_factory() as s:
        s.add(
            User(
                id=uid,
                username=f"u{uid}",
                email=f"u{uid}@dcc-test.example.com",
                password_hash="argon2$dummy",
            )
        )
        await s.commit()
    return uid


# ---- password_reset_tokens ----------------------------------------------


@pytest.mark.asyncio
async def test_run_once_deletes_old_password_reset_tokens(
    engine, session_factory
):
    uid = await _make_user(session_factory)
    now = datetime.now(UTC)
    async with session_factory() as s:
        # stale: expired more than 7 days ago — deleted
        s.add(
            PasswordResetToken(
                user_id=uid,
                token_hash="stale-pw-hash",
                expires_at=now - timedelta(days=10),
            )
        )
        # fresh-expired: expired only yesterday — kept (still in grace)
        s.add(
            PasswordResetToken(
                user_id=uid,
                token_hash="recent-pw-hash",
                expires_at=now - timedelta(days=1),
            )
        )
        # usable: not yet expired — kept
        s.add(
            PasswordResetToken(
                user_id=uid,
                token_hash="live-pw-hash",
                expires_at=now + timedelta(hours=1),
            )
        )
        await s.commit()

    counts = await _run_once(engine, _settings())
    assert counts["password_reset_tokens"] == 1

    async with session_factory() as s:
        remaining = (
            await s.execute(select(PasswordResetToken.token_hash))
        ).scalars().all()
    assert sorted(remaining) == ["live-pw-hash", "recent-pw-hash"]


# ---- email_verification_tokens ------------------------------------------


@pytest.mark.asyncio
async def test_run_once_deletes_old_email_verification_tokens(
    engine, session_factory
):
    uid = await _make_user(session_factory)
    now = datetime.now(UTC)
    async with session_factory() as s:
        s.add(
            EmailVerificationToken(
                user_id=uid,
                token_hash="stale-ev-hash",
                expires_at=now - timedelta(days=15),
            )
        )
        s.add(
            EmailVerificationToken(
                user_id=uid,
                token_hash="live-ev-hash",
                expires_at=now + timedelta(days=1),
            )
        )
        await s.commit()

    counts = await _run_once(engine, _settings())
    assert counts["email_verification_tokens"] == 1

    async with session_factory() as s:
        remaining = (
            await s.execute(select(EmailVerificationToken.token_hash))
        ).scalars().all()
    assert remaining == ["live-ev-hash"]


# ---- refresh_tokens -----------------------------------------------------


@pytest.mark.asyncio
async def test_run_once_deletes_old_revoked_refresh_tokens(
    engine, session_factory
):
    uid = await _make_user(session_factory)
    now = datetime.now(UTC)
    jti_old = uuid4()
    jti_fresh_revoked = uuid4()
    jti_active = uuid4()
    async with session_factory() as s:
        # old-revoked: revoked 60 days ago — deleted
        s.add(
            RefreshToken(
                jti=jti_old,
                user_id=uid,
                issued_at=now - timedelta(days=90),
                expires_at=now - timedelta(days=60),
                revoked_at=now - timedelta(days=60),
            )
        )
        # fresh-revoked: revoked yesterday — kept (within 30 d grace)
        s.add(
            RefreshToken(
                jti=jti_fresh_revoked,
                user_id=uid,
                issued_at=now - timedelta(days=10),
                expires_at=now + timedelta(days=20),
                revoked_at=now - timedelta(days=1),
            )
        )
        # active: never revoked — kept regardless of age
        s.add(
            RefreshToken(
                jti=jti_active,
                user_id=uid,
                issued_at=now - timedelta(days=100),
                expires_at=now + timedelta(days=30),
                revoked_at=None,
            )
        )
        await s.commit()

    counts = await _run_once(engine, _settings())
    assert counts["refresh_tokens_revoked"] == 1

    async with session_factory() as s:
        remaining = (
            await s.execute(select(RefreshToken.jti))
        ).scalars().all()
    assert sorted(str(j) for j in remaining) == sorted(
        [str(jti_fresh_revoked), str(jti_active)]
    )


# ---- username_reservations -----------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_purges_expired_username_reservations(engine, session_factory):
    """released_at in der Vergangenheit → Zeile wird beim Sweep gelöscht."""
    uid = await _make_user(session_factory)
    now = datetime.now(UTC)

    async with session_factory() as s:
        # expired: released_at war gestern
        s.add(UsernameReservation(
            old_username="stale_handle",
            original_user_id=uid,
            released_at=now - timedelta(days=1),
        ))
        # active: released_at ist in 30 Tagen — muss bleiben
        s.add(UsernameReservation(
            old_username="live_handle",
            original_user_id=uid,
            released_at=now + timedelta(days=30),
        ))
        await s.commit()

    counts = await _run_once(engine, _settings())

    assert counts["username_reservations_expired"] == 1

    async with session_factory() as s:
        remaining = (
            await s.execute(select(UsernameReservation.old_username))
        ).scalars().all()
    assert remaining == ["live_handle"], f"Unerwartet verblieben: {remaining}"


# ---- keep-alive: usable tokens + backup-codes untouched -----------------


@pytest.mark.asyncio
async def test_run_once_keeps_usable_and_never_touches_backup_codes(
    engine, session_factory
):
    """Active resets + used backup codes both survive a sweep."""
    uid = await _make_user(session_factory)
    now = datetime.now(UTC)
    async with session_factory() as s:
        s.add(
            PasswordResetToken(
                user_id=uid,
                token_hash="usable-1",
                expires_at=now + timedelta(minutes=30),
            )
        )
        s.add(
            EmailVerificationToken(
                user_id=uid,
                token_hash="usable-ev",
                expires_at=now + timedelta(hours=12),
            )
        )
        # used long ago — must remain (audit trail until 2FA disabled)
        s.add(
            BackupCode(
                user_id=uid,
                code_hash="bc-used",
                used_at=now - timedelta(days=400),
            )
        )
        # unused — also stays
        s.add(BackupCode(user_id=uid, code_hash="bc-unused"))
        await s.commit()

    counts = await _run_once(engine, _settings())
    assert counts == {
        "password_reset_tokens": 0,
        "email_verification_tokens": 0,
        "refresh_tokens_revoked": 0,
        "user_sessions_expired": 0,
        "username_reservations_expired": 0,
        "revoked_credentials_expired": 0,
    }

    async with session_factory() as s:
        n_bc = len((await s.execute(select(BackupCode))).scalars().all())
        n_pw = len((await s.execute(select(PasswordResetToken))).scalars().all())
        n_ev = len((await s.execute(select(EmailVerificationToken))).scalars().all())
    assert (n_bc, n_pw, n_ev) == (2, 1, 1)


# ---- loop resilience ----------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_loop_survives_run_once_exception(
    monkeypatch, caplog, engine
):
    """A raise from ``_run_once`` is logged + the loop keeps spinning.

    We give the loop a 0-second interval, let it tick twice, then cancel.
    The first call raises; the second succeeds. Without the try/except in
    ``cleanup_loop`` the task would die on the first tick.
    """
    calls = {"n": 0}

    async def _broken_once(_engine, _settings):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated db blip")
        return {
            "password_reset_tokens": 0,
            "email_verification_tokens": 0,
            "refresh_tokens_revoked": 0,
        }

    import dcc_auth.cleanup as cleanup_mod

    monkeypatch.setattr(cleanup_mod, "_run_once", _broken_once)

    s = _settings()
    s.token_cleanup_interval_seconds = 0  # tight loop for the test
    caplog.set_level(logging.ERROR, logger="dcc_auth.cleanup")

    task = asyncio.create_task(cleanup_loop(s, engine))
    # Let the loop run a couple of iterations.
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert calls["n"] >= 2
    assert any("token_cleanup_failed" in rec.message for rec in caplog.records)
