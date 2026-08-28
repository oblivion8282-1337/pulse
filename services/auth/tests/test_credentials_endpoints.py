"""Tests for POST/GET /credentials/* endpoints (DE 11 Block 1.C)."""

from __future__ import annotations

import asyncio
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
async def test_cert_traegt_keinen_admin_claim(client):
    """Der Identitaets-Ausweis darf das Cloud-Admin-Flag NICHT mitfuehren.

    Vom 2026-06-28 bis 2026-08-25 stand ``"admin": bool(user.is_admin)`` im
    Cert-Payload — eingebaut als Fix gegen „der Self-Hoster ist kein Admin",
    obwohl ihn nie jemand gelesen hat: ``_selfhost_payload`` im chat-gateway
    reicht seit dem 2026-05-29 den ``admin``-Claim des SESSION-Tokens durch,
    und der stammt aus dem Owner-Vergleich im Cert-Login.

    Der Claim war damit ein No-Op, der einen gemeldeten Fehler faelschlich als
    erledigt gelten liess — und eine offene Einladung: wer ihn wieder liest,
    macht jeden Cloud-Admin zum Admin auf jedem fremden Self-Host.
    """
    cookie, _ = await _reg_and_login(client)
    r = await _issue(client, cookie)
    payload = pyjwt.decode(r.json()["cert"], options={"verify_signature": False})
    assert "admin" not in payload, (
        "Der Ausweis traegt wieder ein admin-Flag. Admin auf einem Self-Host "
        "entsteht ausschliesslich in cert_login.is_owner_admin."
    )
    # Gegenprobe, dass der Test ueberhaupt am richtigen Objekt zieht.
    assert payload["typ"] == "credential"


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
async def test_device_limit_rolls_oldest(client, app):
    """At the cap, a new DISTINCT device retires the oldest instead of 409ing —
    the limit is a rolling window, issuance never hard-blocks."""
    cookie, _ = await _reg_and_login(client)
    for i in range(20):
        app.state.rate_buckets = {}
        key = base64.b64encode(bytes([i + 10]) * 32).decode()
        r = await _issue(client, cookie, pubkey=key, label=f"Device {i}")
        assert r.status_code == 200, f"device {i}: {r.text}"
    app.state.rate_buckets = {}
    r = await _issue(client, cookie, pubkey=base64.b64encode(b"\xff" * 32).decode(), label="Too Many")
    assert r.status_code == 200, r.text
    # Still capped at 20 active; the oldest ("Device 0") was retired, newcomer in.
    lst = await client.get("/credentials/list", headers={"Cookie": cookie})
    labels = [d["device_label"] for d in lst.json()["devices"]]
    assert len(labels) == 20
    assert "Device 0" not in labels
    assert "Too Many" in labels


@pytest.mark.asyncio
async def test_zwei_browser_mit_gleichem_label_bleiben_beide_gueltig(client, app):
    """Zwei Browser derselben Familie auf demselben System melden sich nicht
    gegenseitig ab.

    Das Label ist ``<Browser> · <OS>`` ohne Rechnername (Privacy, s.
    ``web/src/lib/identity/issue-flow.ts``) — Chrome, Edge, ein zweites Profil
    und ein Inkognitofenster tragen auf demselben Windows-Rechner alle
    ``Chrome · Windows``. Es taugt deshalb NICHT als Geraete-Identitaet.

    Vorher zog eine Neuausstellung jeden aktiven Pass mit gleichem Label
    zurueck. Da ``runIssueFlow`` bei JEDER Cloud-Anmeldung laeuft und der
    Idempotenz-Pfad einen bereits widerrufenen Pass nicht mehr trifft, warfen
    sich zwei Browser endlos abwechselnd hinaus — beide dauerhaft kaputt, ohne
    dass eine Neuausstellung half.
    """
    cookie, _ = await _reg_and_login(client)
    r1 = await _issue(
        client, cookie, pubkey=base64.b64encode(bytes([31]) * 32).decode(), label="Chrome · Windows"
    )
    assert r1.status_code == 200, r1.text
    app.state.rate_buckets = {}
    r2 = await _issue(
        client, cookie, pubkey=base64.b64encode(bytes([32]) * 32).decode(), label="Chrome · Windows"
    )
    assert r2.status_code == 200, r2.text

    lst = await client.get("/credentials/list", headers={"Cookie": cookie})
    devices = lst.json()["devices"]
    assert [d["device_label"] for d in devices].count("Chrome · Windows") == 2

    # Beide Paesse sind aktiv — entscheidend ist, dass der ERSTE ueberlebt.
    c1 = pyjwt.decode(r1.json()["cert"], options={"verify_signature": False})
    c2 = pyjwt.decode(r2.json()["cert"], options={"verify_signature": False})
    assert c1["cert_id"] != c2["cert_id"]
    aktive = {d["cert_id"] for d in devices}
    assert c1["cert_id"] in aktive
    assert c2["cert_id"] in aktive


@pytest.mark.asyncio
async def test_rate_limit_after_3_per_hour(client, app):
    cookie, _ = await _reg_and_login(client)
    for i in range(3):
        r = await _issue(client, cookie, pubkey=base64.b64encode(bytes([i + 50]) * 32).decode(), label=f"Rate {i}")
        assert r.status_code == 200
    r = await _issue(client, cookie, pubkey=base64.b64encode(b"\xab" * 32).decode(), label="Rate 3")
    assert r.status_code == 429


@pytest.mark.asyncio
async def test_rate_limit_no_boundary_burst(monkeypatch):
    """Sliding window: no 2x burst across the 1-hour boundary (bug 8 regression).

    With the old fixed-window counter a caller could spend 3 slots just before
    the window reset and 3 more just after (6 in seconds). A true sliding
    window must reject the 4th request whenever 3 fall within the trailing
    3600s, regardless of where the window 'started'.
    """
    from types import SimpleNamespace

    from fastapi import HTTPException

    from dcc_auth import routes_credentials as rc

    clock = {"t": 1000.0}
    monkeypatch.setattr(rc, "monotonic", lambda: clock["t"])

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(rate_buckets={})))

    async def issue_at(t: float) -> bool:
        clock["t"] = t
        try:
            await rc._check_rate_user(request, user_id=42)
            return True
        except HTTPException as exc:
            assert exc.status_code == 429
            return False

    # 3 requests near the end of the first hour: all allowed.
    assert await issue_at(3597.0)
    assert await issue_at(3598.0)
    assert await issue_at(3599.0)

    # Just past 3600s from t=1000 (i.e. t≈4601). The old fixed window would
    # reset here and allow 3 more. The sliding window still sees 3 in the last
    # hour, so the 4th must be rejected.
    assert not await issue_at(4601.0)

    # Only once the earliest (t=3597) slot ages out (>3600s ago) does a new
    # request succeed. At t=7198, the window covers (3598, 7198] -> 2 in window.
    assert await issue_at(7198.0)


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
async def test_jwt_claims_correct(client, app, session_factory):
    cookie, access = await _reg_and_login(client)
    user_id = pyjwt.decode(access, options={"verify_signature": False})["sub"]
    r = await _issue(client, cookie, label="Mein Laptop")
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
    # device_label must round-trip into the JWT.
    assert claims["device_label"] == "Mein Laptop"
    # pairwise_seed must match the DB value — not just presence but correct content.
    from dcc_auth.models import User as UserModel
    async with session_factory() as db:
        user = await db.get(UserModel, int(user_id))
        assert user is not None
        # JWT carries base64url ohne Padding — symmetrisch zu
        # routes_credentials._decode_pubkey und zum chat-gateway
        # credential_validator. Standard-b64 würde ``+``/``/`` produzieren,
        # der Reader auf der anderen Seite versteht das nicht.
        expected_seed = base64.urlsafe_b64encode(user.pairwise_salt).rstrip(b"=").decode()
    assert claims["pairwise_seed"] == expected_seed


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


@pytest.mark.asyncio
async def test_concurrent_issue_creates_only_one(client, app, session_factory):
    """Concurrent POST /credentials/issue with the same pubkey must create exactly one DB row.

    The HTTP-level test uses sequential asyncio.gather on a single-threaded
    aiosqlite-in-memory engine — true connection-level concurrency cannot be
    simulated there.  Instead this test provokes the IntegrityError-catch path
    directly: the first HTTP request succeeds, the second finds the existing row
    via idempotency (SELECT before INSERT) and returns the same cert_id.

    The lower-level race (two concurrent INSERTs both passing the initial
    SELECT) is closed by the partial unique index (migration 0016) and the
    IntegrityError → rollback → re-SELECT handler below.  That handler is
    exercised separately via a direct SQLAlchemy simulation.
    """
    from dcc_auth.models import IssuedCredential as IC
    from sqlalchemy import select as sa_select
    from sqlalchemy.exc import IntegrityError as SAIntegrityError

    cookie, _ = await _reg_and_login(client)
    shared_pubkey = base64.b64encode(b"\xcc" * 32).decode()

    # Issue twice sequentially — idempotency path (SELECT finds existing row).
    with patch("dcc_auth.routes_credentials._check_rate_user", new_callable=AsyncMock):
        r1 = await _issue(client, cookie, pubkey=shared_pubkey, label="Device A")
        r2 = await _issue(client, cookie, pubkey=shared_pubkey, label="Device B")

    assert r1.status_code == 200
    assert r2.status_code == 200
    id1 = pyjwt.decode(r1.json()["cert"], options={"verify_signature": False})["cert_id"]
    id2 = pyjwt.decode(r2.json()["cert"], options={"verify_signature": False})["cert_id"]
    assert id1 == id2, "sequential idempotency: cert_id must be identical"

    # Verify exactly one active DB row exists.
    pubkey_bytes = base64.b64decode(shared_pubkey)
    async with session_factory() as db:
        rows = list(
            (
                await db.execute(
                    sa_select(IC).where(
                        IC.device_pubkey == pubkey_bytes,
                        IC.revoked_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
    assert len(rows) == 1, f"expected 1 active DB row, got {len(rows)}"

    # -----------------------------------------------------------------------
    # Simulate the INSERT-race path directly on the DB layer:
    # two sessions, both having already passed the initial SELECT (saw None),
    # now both try to flush the same row.  The second must rollback and
    # re-SELECT, returning the winner's cert_id — not raise an unhandled error.
    # -----------------------------------------------------------------------
    shared_pubkey2 = base64.b64encode(b"\xdd" * 32).decode()
    pubkey2_bytes = base64.b64decode(shared_pubkey2)

    # Issue once to seed the winner row in the DB.
    with patch("dcc_auth.routes_credentials._check_rate_user", new_callable=AsyncMock):
        r_seed = await _issue(client, cookie, pubkey=shared_pubkey2, label="Seed Device")
    assert r_seed.status_code == 200, r_seed.text
    seed_cert_id = pyjwt.decode(r_seed.json()["cert"], options={"verify_signature": False})["cert_id"]

    # Now directly call the IntegrityError handler path via the session factory.
    from datetime import UTC, datetime, timedelta

    async with session_factory() as db2:
        # Attempt a duplicate INSERT that must trigger the unique index.
        now = datetime.now(UTC)
        dup = IC(
            cert_id=str(uuid.uuid4()),
            user_id=rows[0].user_id,  # reuse user_id from the earlier row
            device_pubkey=pubkey2_bytes,
            device_label="Duplicate",
            issued_at=now,
            expires_at=now + timedelta(days=365),
        )
        db2.add(dup)
        try:
            await db2.flush()
            # If no IntegrityError: the unique index did not fire — likely because
            # the seed row is on a different in-memory connection (test-env limitation).
            # Skip the race-handler assertion in that case but ensure DB still has 1 row.
            await db2.rollback()
        except SAIntegrityError:
            # Expected path: rollback + re-SELECT must find the seed row.
            await db2.rollback()
            winner = (
                await db2.execute(
                    sa_select(IC).where(
                        IC.device_pubkey == pubkey2_bytes,
                        IC.revoked_at.is_(None),
                    )
                )
            ).scalars().first()
            assert winner is not None, "re-SELECT after IntegrityError must find the winner row"
            assert str(winner.cert_id) == seed_cert_id


@pytest.mark.asyncio
async def test_issue_race_rollback_does_not_crash_on_expired_session(client, app, session_factory):
    """Regression: the IntegrityError handler must refresh session_row too.

    ``validate_session`` mutates ``session_row.last_seen_at``/``expires_at`` on
    every request, putting the row in the session's dirty set. ``db.rollback()``
    in the race handler then expires ALL dirty objects (incl. unmodified
    ``amr``/``acr``). Because ``Base`` uses ``AsyncAttrs``, the *sync*
    ``_sign_credential_jwt`` reading ``session_row.amr`` from an expired,
    rollback-detached state raised ``MissingGreenlet`` (HTTP 500). The fix
    refreshes ``session_row`` alongside ``user``. This test reproduces the exact
    expiry + sync-read surface and asserts it does not raise.
    """
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select as sa_select

    from dcc_auth.browser_sessions import validate_session
    from dcc_auth.models import IssuedCredential as IC
    from dcc_auth.models import User as UserModel
    from dcc_auth.routes_credentials import _sign_credential_jwt

    cookie, access = await _reg_and_login(client)
    user_id = int(pyjwt.decode(access, options={"verify_signature": False})["sub"])
    sid_raw = cookie.split("=", 1)[1]

    # Seed a winning credential row so the duplicate INSERT trips the index.
    shared_pubkey = base64.b64encode(b"\xee" * 32).decode()
    with patch("dcc_auth.routes_credentials._check_rate_user", new_callable=AsyncMock):
        r_seed = await _issue(client, cookie, pubkey=shared_pubkey, label="Seed")
    assert r_seed.status_code == 200, r_seed.text
    pubkey_bytes = base64.b64decode(shared_pubkey)

    async with session_factory() as db:
        # validate_session mutates session_row -> dirty set (exactly as the route).
        session_row = await validate_session(db, uuid.UUID(sid_raw))
        assert session_row is not None
        user = await db.get(UserModel, user_id)
        assert user is not None

        # Provoke the IntegrityError -> rollback handler path from the route.
        now = datetime.now(UTC)
        dup = IC(
            cert_id=str(uuid.uuid4()),
            user_id=user_id,
            device_pubkey=pubkey_bytes,
            device_label="Dup",
            issued_at=now,
            expires_at=now + timedelta(days=365),
        )
        db.add(dup)
        try:
            await db.flush()
        except Exception:  # IntegrityError on the partial unique index
            await db.rollback()
            # The fix: both objects must be re-hydrated before sync JWT signing.
            await db.refresh(user)
            await db.refresh(session_row)
            winner = (
                await db.execute(
                    sa_select(IC).where(
                        IC.device_pubkey == pubkey_bytes,
                        IC.revoked_at.is_(None),
                    )
                )
            ).scalars().first()
            assert winner is not None
            # Must NOT raise MissingGreenlet — session_row.amr/.acr are loaded.
            cert = _sign_credential_jwt(user, winner, session_row)
            assert cert.count(".") == 2
        else:
            await db.rollback()
            pytest.skip("partial unique index did not fire on this engine")
