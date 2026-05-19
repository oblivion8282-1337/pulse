"""Tests for GET /admin/backup-status.

Four states the endpoint must report:
  1. configured=False — the volume isn't mounted (dev / pre-setup).
  2. configured=True, last_backup_at=None — volume mounted, marker missing
     (fresh deploy, before entrypoint's start-touch landed).
  3. configured=True, healthy=True — marker fresh.
  4. configured=True, healthy=False — marker stale (>threshold).

The marker path is driven by ``Settings.backup_marker_path``. The conftest's
``_isolate_settings`` fixture (autouse) hands each test a fresh Settings
instance — we mutate ``backup_marker_path`` on it directly, which is
simpler than re-instantiating + re-wiring the provider, and isolated
across tests because the next ``_isolate_settings`` yield re-creates it.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select

from dcc_auth.models import User


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


@pytest.fixture
def marker_path(tmp_path: Path, _isolate_settings) -> Path:
    """Point Settings.backup_marker_path at a tmp dir for this test only."""
    marker = tmp_path / "backup-state" / ".pulse" / "last-backup-ok"
    _isolate_settings.backup_marker_path = marker
    return marker


@pytest.mark.asyncio
async def test_requires_admin(client, marker_path):
    """Non-admin → 403; no token → 401."""
    r = await client.get("/admin/backup-status")
    assert r.status_code == 401

    # Burn the bootstrap-admin slot so bob registers as a regular user.
    await _register_user(client, username="alice", email="alice@example.com")
    bob_token = await _register_user(client, username="bob", email="bob@example.com")
    r = await client.get(
        "/admin/backup-status", headers={"Authorization": f"Bearer {bob_token}"}
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_not_configured_when_volume_absent(client, admin_token, marker_path):
    """Case 1: parent dir doesn't exist → backup sidecar not deployed."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/backup-status", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is False
    assert body["last_backup_at"] is None
    assert body["age_seconds"] is None
    assert body["healthy"] is False
    assert body["stale_threshold_seconds"] == 129_600


@pytest.mark.asyncio
async def test_configured_but_no_run_yet(client, admin_token, marker_path):
    """Case 2: volume mounted but marker missing — entrypoint not run yet,
    or operator wiped /repo/.pulse/. Configured but unhealthy."""
    marker_path.parent.mkdir(parents=True)
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/backup-status", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["last_backup_at"] is None
    assert body["age_seconds"] is None
    assert body["healthy"] is False


@pytest.mark.asyncio
async def test_healthy_when_marker_fresh(client, admin_token, marker_path):
    """Case 3: marker is a few seconds old → healthy + ISO-8601 timestamp."""
    marker_path.parent.mkdir(parents=True)
    marker_path.write_text("2026-05-19T04:00:00Z\n")
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/backup-status", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["healthy"] is True
    assert body["age_seconds"] is not None
    assert body["age_seconds"] < 5
    # last_backup_at is the mtime as ISO-8601 with trailing Z.
    assert body["last_backup_at"].endswith("Z")
    assert "T" in body["last_backup_at"]


@pytest.mark.asyncio
async def test_unhealthy_when_marker_stale(client, admin_token, marker_path):
    """Case 4: marker is 40 h old → unhealthy."""
    marker_path.parent.mkdir(parents=True)
    marker_path.write_text("ignored")
    stale_at = time.time() - 40 * 3600
    os.utime(marker_path, (stale_at, stale_at))

    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.get("/admin/backup-status", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["healthy"] is False
    assert body["age_seconds"] >= 40 * 3600 - 5
