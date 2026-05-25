"""Tests for POST/GET /credentials/* endpoints (DE 11 Block 1.C)."""

from __future__ import annotations

import base64
import time
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import jwt as pyjwt
import pytest

_REG_A = {"username": "cred_alice", "email": "cred_alice@dcc-test.example.com", "password": "horse battery staple correct", "display_name": "Alice"}
_REG_B = {"username": "cred_bob", "email": "cred_bob@dcc-test.example.com", "password": "horse battery staple correct", "display_name": "Bob"}
_LOGIN_A = {"email_or_username": _REG_A["email"], "password": _REG_A["password"]}
_LOGIN_B = {"email_or_username": _REG_B["email"], "password": _REG_B["password"]}
_PUBKEY = base64.b64encode(b"\x01" * 32).decode()
_PUBKEY2 = base64.b64encode(b"\x02" * 32).decode()


async def _reg_and_login(client, reg=_REG_A, login=_LOGIN_A):
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid
    return f"pulse_session={sid}", r.json()["access_token"]


async def _issue(client, cookie, *, pubkey=_PUBKEY, label="My Device", acr_values=None):
    body: dict = {"device_pubkey": pubkey, "device_label": label}
    if acr_values is not None:
        body["acr_values"] = acr_values
    return await client.post("/credentials/issue", json=body, headers={"Cookie": cookie})


@pytest.mark.asyncio
async def test_issue_with_cookie_returns_cert(client):
    cookie, _ = await _reg_and_login(client)
    r = await _issue(client, cookie)
    assert r.status_code == 200, r.text
    assert r.json()["cert"].count(".") == 2


@pytest.mark.asyncio
async def test_issue_without_cookie_returns_401(client):
    r = await client.post("/credentials/issue", json={"device_pubkey": _PUBKEY, "device_label": "X"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_issue_idempotency_same_pubkey(client):
    cookie, _ = await _reg_and_login(client)
    r1 = await _issue(client, cookie, pubkey=_PUBKEY)
    r2 = await _issue(client, cookie, pubkey=_PUBKEY)
    c1 = pyjwt.decode(r1.json()["cert"], options={"verify_signature": False})
    c2 = pyjwt.decode(r2.json()["cert"], options={"verify_signature": False})
    assert c1["cert_id"] == c2["cert_id"]


@pytest.mark.asyncio
async def test_device_limit_409(client, app):
    cookie, _ = await _reg_and_login(client)
    for i in range(20):
        app.state.rate_buckets = {}
        key = base64.b64encode(bytes([i + 10]) * 32).decode()
        r = await _issue(client, cookie, pubkey=key, label=f"Device {i}")
        assert r.status_code == 200, f"device {i}: {r.text}"
    app.state.rate_buckets = {}
    r = await _issue(client, cookie, pubkey=base64.b64encode(b"\xff" * 32).decode(), label="Too Many")
    assert r.status_code == 409
    assert "device_limit_reached" in r.text


@pytest.mark.asyncio
async def test_rate_limit_after_3_per_hour(client, app):
    cookie, _ = await _reg_and_login(client)
    for i in range(3):
        r = await _issue(client, cookie, pubkey=base64.b64encode(bytes([i + 50]) * 32).decode(), label=f"Rate {i}")
        assert r.status_code == 200
    r = await _issue(client, cookie, pubkey=base64.b64encode(b"\xab" * 32).decode(), label="Rate 3")
    assert r.status_code == 429


@pytest.mark.asyncio
async def test_list_shows_own_certs(client, app):
    cookie, _ = await _reg_and_login(client)
    r_issue = await _issue(client, cookie)
    assert r_issue.status_code == 200
    r_list = await client.get("/credentials/list", headers={"Cookie": cookie})
    assert r_list.status_code == 200
    devices = r_list.json()["devices"]
    assert len(devices) >= 1
    issued_id = pyjwt.decode(r_issue.json()["cert"], options={"verify_signature": False})["cert_id"]
    assert issued_id in [d["cert_id"] for d in devices]


@pytest.mark.asyncio
async def test_list_excludes_other_users_certs(client, app):
    cookie_a, _ = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    cookie_b, _ = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)
    r_a = await _issue(client, cookie_a, pubkey=_PUBKEY)
    alice_cert_id = pyjwt.decode(r_a.json()["cert"], options={"verify_signature": False})["cert_id"]
    r_list = await client.get("/credentials/list", headers={"Cookie": cookie_b})
    assert r_list.status_code == 200
    assert alice_cert_id not in [d["cert_id"] for d in r_list.json()["devices"]]


@pytest.mark.asyncio
async def test_revoke_sets_revoked_at(client, app, session_factory):
    cookie, _ = await _reg_and_login(client)
    r = await _issue(client, cookie, pubkey=_PUBKEY2)
    cert_id = pyjwt.decode(r.json()["cert"], options={"verify_signature": False})["cert_id"]
    with patch("dcc_auth.routes_credentials._push_to_redis_crl", new_callable=AsyncMock):
        r_revoke = await client.post(f"/credentials/{cert_id}/revoke", headers={"Cookie": cookie})
    assert r_revoke.status_code == 204
    from dcc_auth.models import IssuedCredential
    async with session_factory() as db:
        cred = await db.get(IssuedCredential, cert_id)
        assert cred is not None and cred.revoked_at is not None


@pytest.mark.asyncio
async def test_revoke_pushes_to_redis_crl(client, app):
    cookie, _ = await _reg_and_login(client)
    r = await _issue(client, cookie, pubkey=_PUBKEY)
    cert_id = pyjwt.decode(r.json()["cert"], options={"verify_signature": False})["cert_id"]
    with patch("dcc_auth.routes_credentials._push_to_redis_crl", new_callable=AsyncMock) as mock_redis:
        r_revoke = await client.post(f"/credentials/{cert_id}/revoke", headers={"Cookie": cookie})
    assert r_revoke.status_code == 204
    mock_redis.assert_awaited_once()
    assert mock_redis.call_args[0][0] == cert_id


@pytest.mark.asyncio
async def test_revoke_foreign_cert_returns_403(client, app):
    cookie_a, _ = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    cookie_b, _ = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)
    r = await _issue(client, cookie_a, pubkey=_PUBKEY)
    alice_cert_id = pyjwt.decode(r.json()["cert"], options={"verify_signature": False})["cert_id"]
    with patch("dcc_auth.routes_credentials._push_to_redis_crl", new_callable=AsyncMock):
        r_revoke = await client.post(f"/credentials/{alice_cert_id}/revoke", headers={"Cookie": cookie_b})
    assert r_revoke.status_code == 403


@pytest.mark.asyncio
async def test_jwt_claims_correct(client, app):
    cookie, access = await _reg_and_login(client)
    user_id = pyjwt.decode(access, options={"verify_signature": False})["sub"]
    r = await _issue(client, cookie, pubkey=_PUBKEY)
    cert_jwt = r.json()["cert"]
    header = pyjwt.get_unverified_header(cert_jwt)
    assert "kid" in header
    claims = pyjwt.decode(cert_jwt, options={"verify_signature": False})
    assert claims["user_id"] == str(user_id)
    assert "cert_id" in claims
    assert claims["typ"] == "credential"
    assert "device_pubkey" in claims
    assert "pairwise_seed" in claims
    assert "amr" in claims and "acr" in claims
    assert abs(claims["exp"] - (int(time.time()) + 365 * 86400)) < 120


@pytest.mark.asyncio
async def test_mfa_step_up_required(client, app):
    cookie, _ = await _reg_and_login(client)
    r = await _issue(client, cookie, pubkey=_PUBKEY, acr_values="mfa")
    assert r.status_code == 403
    assert "mfa_step_up_required" in r.text


@pytest.mark.asyncio
async def test_revoke_until_watermark_blocks_issuance(client, app, session_factory):
    from dcc_auth.models import User as UserModel
    cookie, access = await _reg_and_login(client)
    user_id = int(pyjwt.decode(access, options={"verify_signature": False})["sub"])
    async with session_factory() as db:
        user = await db.get(UserModel, user_id)
        user.revoke_until = datetime.now(UTC) + timedelta(minutes=2)
        await db.commit()
    r = await _issue(client, cookie, pubkey=_PUBKEY)
    assert r.status_code == 409
    assert "account_in_revoke_window" in r.text


@pytest.mark.asyncio
async def test_admin_can_revoke_foreign_cert(client, app, session_factory):
    from dcc_auth.models import User as UserModel
    cookie_admin, access_admin = await _reg_and_login(client, reg=_REG_A, login=_LOGIN_A)
    admin_id = int(pyjwt.decode(access_admin, options={"verify_signature": False})["sub"])
    async with session_factory() as db:
        admin = await db.get(UserModel, admin_id)
        admin.is_admin = True
        await db.commit()
    cookie_b, _ = await _reg_and_login(client, reg=_REG_B, login=_LOGIN_B)
    r = await _issue(client, cookie_b, pubkey=_PUBKEY2)
    bob_cert_id = pyjwt.decode(r.json()["cert"], options={"verify_signature": False})["cert_id"]
    with patch("dcc_auth.routes_credentials._push_to_redis_crl", new_callable=AsyncMock):
        r_revoke = await client.post(f"/credentials/{bob_cert_id}/revoke", headers={"Cookie": cookie_admin})
    assert r_revoke.status_code == 204


@pytest.mark.asyncio
async def test_list_excludes_revoked_certs(client, app):
    cookie, _ = await _reg_and_login(client)
    r = await _issue(client, cookie, pubkey=_PUBKEY)
    cert_id = pyjwt.decode(r.json()["cert"], options={"verify_signature": False})["cert_id"]
    with patch("dcc_auth.routes_credentials._push_to_redis_crl", new_callable=AsyncMock):
        r_revoke = await client.post(f"/credentials/{cert_id}/revoke", headers={"Cookie": cookie})
    assert r_revoke.status_code == 204
    r_list = await client.get("/credentials/list", headers={"Cookie": cookie})
    assert r_list.status_code == 200
    assert cert_id not in [d["cert_id"] for d in r_list.json()["devices"]]
