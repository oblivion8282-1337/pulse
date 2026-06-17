"""Mandatory-SSO gate: local /register is disabled on a self-host instance
unless ALLOW_LOCAL_ACCOUNTS is set. The Cloud (instance_mode == "cloud") is
the identity source and always accepts registration.
"""

from __future__ import annotations

import pytest

import dcc_auth.config as cfg
import dcc_auth.routes as routes_mod

_PW = "correct horse battery staple"


def _selfhost_settings(allow: bool):
    # Copy the (cloud, sqlite) test settings and flip just the two fields.
    return cfg.get_settings().model_copy(
        update={"pulse_instance_mode": "self-host", "allow_local_accounts": allow}
    )


async def _register(client, username, email):
    return await client.post(
        "/register",
        json={"username": username, "email": email, "password": _PW},
    )


async def _login(client, needle):
    return await client.post(
        "/login",
        json={"email_or_username": needle, "password": _PW},
    )


@pytest.mark.asyncio
async def test_cloud_allows_local_registration(client):
    # Test env defaults to instance_mode=cloud → registration is open.
    r = await _register(client, "clouduser", "cloud@example.com")
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_selfhost_blocks_local_registration(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "get_settings", lambda: _selfhost_settings(False))
    r = await _register(client, "selfhostuser", "sh@example.com")
    assert r.status_code == 403
    assert "howispulse.com" in r.text


@pytest.mark.asyncio
async def test_selfhost_escape_flag_allows_registration(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "get_settings", lambda: _selfhost_settings(True))
    r = await _register(client, "islanduser", "island@example.com")
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_selfhost_blocks_local_login(client, monkeypatch):
    # Register the user while in cloud mode so valid credentials exist…
    assert (await _register(client, "loginuser", "login@example.com")).status_code == 201
    # …then switch to a self-host: even correct credentials must be refused
    # (the gate fires before the password check).
    monkeypatch.setattr(routes_mod, "get_settings", lambda: _selfhost_settings(False))
    r = await _login(client, "loginuser")
    assert r.status_code == 403
    assert "howispulse.com" in r.text


@pytest.mark.asyncio
async def test_selfhost_escape_flag_allows_login(client, monkeypatch):
    assert (await _register(client, "islandlogin", "islandlogin@example.com")).status_code == 201
    monkeypatch.setattr(routes_mod, "get_settings", lambda: _selfhost_settings(True))
    r = await _login(client, "islandlogin")
    assert r.status_code == 200, r.text
