"""Tests for profile-statement and profile-update endpoints (Block 1.D)."""

from __future__ import annotations

import inspect
from datetime import UTC, datetime, timedelta

import pytest

from dcc_auth.models import UsernameReservation
from dcc_auth.security import get_signer


@pytest.mark.asyncio
async def test_profile_statement_returns_jwt(client):
    r_reg = await client.post("/register", json={
        "username": "stmt_user", "email": "stmt@dcc-test.example.com", "password": "stmtpassword1",
    })
    access = r_reg.json()["access_token"]
    r = await client.get("/credentials/profile-statement", headers={"Authorization": f"Bearer {access}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "token" in body
    signer = get_signer()
    payload = signer.decode(body["token"])
    assert payload["typ"] == "profile_statement"
    assert "username" in payload
    assert payload["exp"] - payload["iat"] == pytest.approx(86_400, abs=10)


@pytest.mark.asyncio
async def test_jwt_claims_correct(client):
    """statement_id Claim ist UUID v4 und identisch mit jti."""
    import re
    UUID4_RE = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    r_reg = await client.post("/register", json={
        "username": "claims_user", "email": "claims@dcc-test.example.com", "password": "claimspassword1",
    })
    access = r_reg.json()["access_token"]
    r = await client.get(
        "/credentials/profile-statement", headers={"Authorization": f"Bearer {access}"}
    )
    assert r.status_code == 200, r.text
    signer = get_signer()
    claims = signer.decode(r.json()["token"])
    assert "statement_id" in claims, "statement_id claim fehlt"
    assert UUID4_RE.match(claims["statement_id"]), "statement_id ist keine UUID v4"
    assert claims["jti"] == claims["statement_id"], "jti und statement_id stimmen nicht überein"


@pytest.mark.asyncio
async def test_profile_change_invalidates_cache(client):
    """Nach POST /me/profile liefert GET /credentials/profile-statement den neuen display_name."""
    r_reg = await client.post("/register", json={
        "username": "cache_inv_user", "email": "cacheinv@dcc-test.example.com",
        "password": "cacheinvpassword1", "display_name": "Before",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    signer = get_signer()

    # JWT1 — alter Wert
    r1 = await client.get("/credentials/profile-statement", headers=headers)
    assert r1.status_code == 200
    claims1 = signer.decode(r1.json()["token"])
    assert claims1["display_name"] == "Before"

    # Profil ändern → Cache wird invalidiert
    r_upd = await client.post("/me/profile", json={"display_name": "After"}, headers=headers)
    assert r_upd.status_code == 200

    # JWT2 — muss neuen Wert enthalten (innerhalb 5 s, kein Sleep nötig)
    r2 = await client.get("/credentials/profile-statement", headers=headers)
    assert r2.status_code == 200
    claims2 = signer.decode(r2.json()["token"])
    assert claims2["display_name"] == "After", (
        f"Cache-Invalidation fehlgeschlagen: display_name = {claims2['display_name']!r}"
    )


@pytest.mark.asyncio
async def test_profile_statement_cache(client):
    r_reg = await client.post("/register", json={
        "username": "cache_stmt", "email": "cachestmt@dcc-test.example.com", "password": "cachepassword1",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r1 = await client.get("/credentials/profile-statement", headers=headers)
    r2 = await client.get("/credentials/profile-statement", headers=headers)
    assert r1.status_code == 200
    assert r2.status_code == 200
    signer = get_signer()
    assert signer.decode(r1.json()["token"])["typ"] == "profile_statement"
    assert signer.decode(r2.json()["token"])["typ"] == "profile_statement"


@pytest.mark.asyncio
async def test_profile_update_avatar_hash_is_ignored(client):
    # avatar_hash must NOT be settable via /me/profile — only POST /me/avatar
    # may write it (derived from the uploaded image). A client-supplied value is
    # silently ignored so nobody can point their profile at an arbitrary
    # by-hash blob (impersonation).
    r_reg = await client.post("/register", json={
        "username": "avatarhash_user", "email": "avh@dcc-test.example.com", "password": "avhpassword1",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r = await client.post("/me/profile", json={"avatar_hash": "abc123def456"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["avatar_hash"] is None
    assert "avatar_hash" not in r.json()["updated"]


@pytest.mark.asyncio
async def test_profile_update_display_name(client):
    r_reg = await client.post("/register", json={
        "username": "dispname_user", "email": "dn@dcc-test.example.com", "password": "dnpassword1",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r = await client.post("/me/profile", json={"display_name": "Display Test"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "Display Test"


@pytest.mark.asyncio
async def test_profile_update_omitted_keys_unchanged(client):
    r_reg = await client.post("/register", json={
        "username": "omit_user", "email": "omit@dcc-test.example.com", "password": "omitpassword1",
        "display_name": "Original",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r = await client.post("/me/profile", json={"profile_color": "#ff0000"}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["display_name"] == "Original"
    assert body["profile_color"] == "#ff0000"
    assert "display_name" not in body["updated"]
    assert "profile_color" in body["updated"]


@pytest.mark.asyncio
async def test_profile_color_secondary_round_trip(client):
    r_reg = await client.post("/register", json={
        "username": "grad_user", "email": "grad@dcc-test.example.com",
        "password": "gradpassword1", "display_name": "Grad",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    # Set both gradient colours in one request.
    r = await client.post(
        "/me/profile",
        json={"profile_color": "#112233", "profile_color_secondary": "#aabbcc"},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["profile_color"] == "#112233"
    assert body["profile_color_secondary"] == "#aabbcc"
    assert "profile_color_secondary" in body["updated"]
    # GET /me must echo both colours back.
    me = await client.get("/me", headers=headers)
    assert me.status_code == 200
    me_body = me.json()
    assert me_body["profile_color"] == "#112233"
    assert me_body["profile_color_secondary"] == "#aabbcc"
    # Null clears just the secondary, leaving the primary intact.
    r2 = await client.post(
        "/me/profile", json={"profile_color_secondary": None}, headers=headers
    )
    assert r2.status_code == 200
    assert r2.json()["profile_color_secondary"] is None
    assert r2.json()["profile_color"] == "#112233"


@pytest.mark.asyncio
async def test_profile_color_secondary_invalid_rejected(client):
    r_reg = await client.post("/register", json={
        "username": "badcol_user", "email": "badcol@dcc-test.example.com",
        "password": "badcolpassword1",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r = await client.post(
        "/me/profile", json={"profile_color_secondary": "notacolor"}, headers=headers
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_profile_update_null_clears_field(client):
    r_reg = await client.post("/register", json={
        "username": "null_user", "email": "null@dcc-test.example.com", "password": "nullpassword1",
        "display_name": "Has Name",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r = await client.post("/me/profile", json={"display_name": None}, headers=headers)
    assert r.status_code == 200
    assert r.json()["display_name"] is None


@pytest.mark.asyncio
async def test_username_change_happy_path(client, session_factory):
    r_reg = await client.post("/register", json={
        "username": "old_handle", "email": "oldhandle@dcc-test.example.com", "password": "handlepassword1",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    r = await client.post("/me/username", json={"new_username": "new_handle"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    assert "reserved_until" in r.json()
    async with session_factory() as session:
        reservation = await session.get(UsernameReservation, "old_handle")
    assert reservation is not None
    rel = reservation.released_at
    if rel.tzinfo is None:
        rel = rel.replace(tzinfo=UTC)
    assert rel > datetime.now(tz=UTC)


@pytest.mark.asyncio
async def test_username_change_taken_by_live_user(client):
    await client.post("/register", json={
        "username": "taken_name", "email": "taken@dcc-test.example.com", "password": "takenpassword1",
    })
    r_reg_b = await client.post("/register", json={
        "username": "changer_user", "email": "changer@dcc-test.example.com", "password": "changerpassword1",
    })
    access_b = r_reg_b.json()["access_token"]
    r = await client.post(
        "/me/username", json={"new_username": "taken_name"},
        headers={"Authorization": f"Bearer {access_b}"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "username_taken"


@pytest.mark.asyncio
async def test_username_change_reserved_by_other_user(client, session_factory):
    r_a = await client.post("/register", json={
        "username": "reserving_user", "email": "reserving@dcc-test.example.com", "password": "reservingpassword1",
    })
    r_b = await client.post("/register", json={
        "username": "wanting_user", "email": "wanting@dcc-test.example.com", "password": "wantingpassword1",
    })
    access_b = r_b.json()["access_token"]
    signer = get_signer()
    a_id = int(signer.decode(r_a.json()["access_token"])["sub"])
    async with session_factory() as session:
        session.add(UsernameReservation(
            old_username="reserved_handle", original_user_id=a_id,
            released_at=datetime.now(tz=UTC) + timedelta(days=30),
        ))
        await session.commit()
    r = await client.post(
        "/me/username", json={"new_username": "reserved_handle"},
        headers={"Authorization": f"Bearer {access_b}"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "username_reserved"


@pytest.mark.asyncio
async def test_username_reclaim_own_reservation(client, session_factory):
    r_reg = await client.post("/register", json={
        "username": "reclaim_user", "email": "reclaim@dcc-test.example.com", "password": "reclaimpassword1",
    })
    access = r_reg.json()["access_token"]
    signer = get_signer()
    user_id = int(signer.decode(access)["sub"])
    headers = {"Authorization": f"Bearer {access}"}
    async with session_factory() as session:
        session.add(UsernameReservation(
            old_username="reclaim_handle", original_user_id=user_id,
            released_at=datetime.now(tz=UTC) + timedelta(days=25),
        ))
        await session.commit()
    r = await client.post("/me/username", json={"new_username": "reclaim_handle"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    async with session_factory() as session:
        assert await session.get(UsernameReservation, "reclaim_handle") is None


@pytest.mark.asyncio
async def test_username_reserved_30_days(client, session_factory):
    r_reg = await client.post("/register", json={
        "username": "days_check", "email": "days@dcc-test.example.com", "password": "dayspassword1",
    })
    access = r_reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    before = datetime.now(tz=UTC)
    r = await client.post("/me/username", json={"new_username": "days_new"}, headers=headers)
    assert r.status_code == 200
    after = datetime.now(tz=UTC)
    async with session_factory() as session:
        res = await session.get(UsernameReservation, "days_check")
    assert res is not None
    released = res.released_at
    if released.tzinfo is None:
        released = released.replace(tzinfo=UTC)
    assert before + timedelta(days=30) <= released <= after + timedelta(days=30)


@pytest.mark.asyncio
async def test_username_same_name_rejected(client):
    r_reg = await client.post("/register", json={
        "username": "same_name", "email": "samename@dcc-test.example.com", "password": "samenamepassword1",
    })
    access = r_reg.json()["access_token"]
    r = await client.post(
        "/me/username", json={"new_username": "same_name"},
        headers={"Authorization": f"Bearer {access}"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_migration_0016_username_reservations_table_exists(engine):
    from sqlalchemy import inspect as sa_inspect
    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda c: sa_inspect(c).get_table_names())
    assert "username_reservations" in tables


@pytest.mark.asyncio
async def test_migration_0016_username_reservations_columns(engine):
    from sqlalchemy import inspect as sa_inspect
    async with engine.connect() as conn:
        cols = await conn.run_sync(lambda c: sa_inspect(c).get_columns("username_reservations"))
    missing = {"old_username", "original_user_id", "released_at"} - {c["name"] for c in cols}
    assert not missing, f"username_reservations missing: {missing}"


@pytest.mark.asyncio
async def test_migration_0016_users_avatar_hash_column(engine):
    from sqlalchemy import inspect as sa_inspect
    async with engine.connect() as conn:
        cols = await conn.run_sync(lambda c: sa_inspect(c).get_columns("users"))
    assert "avatar_hash" in {c["name"] for c in cols}


@pytest.mark.asyncio
async def test_migration_0016_users_profile_color_column(engine):
    from sqlalchemy import inspect as sa_inspect
    async with engine.connect() as conn:
        cols = await conn.run_sync(lambda c: sa_inspect(c).get_columns("users"))
    assert "profile_color" in {c["name"] for c in cols}
    # Migration 0029 added the secondary gradient colour alongside it.
    assert "profile_color_secondary" in {c["name"] for c in cols}


@pytest.mark.asyncio
async def test_migration_0016_index_exists(engine):
    from sqlalchemy import inspect as sa_inspect
    async with engine.connect() as conn:
        idxs = await conn.run_sync(lambda c: sa_inspect(c).get_indexes("username_reservations"))
    assert "ix_username_reservations_released_at" in {i["name"] for i in idxs}


def _load_migration_0016():
    import importlib.util
    from pathlib import Path
    versions_dir = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    for path in sorted(versions_dir.glob("*.py")):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        m = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(m)
        except Exception:
            continue
        if getattr(m, "revision", "").startswith("0016"):
            return m
    return None


def test_migration_0016_has_downgrade():
    mod = _load_migration_0016()
    assert mod is not None, "Migration 0016 not found"
    src = inspect.getsource(mod.downgrade)
    assert "username_reservations" in src
    assert "avatar_hash" in src
    assert "profile_color" in src


def test_migration_chain_0016():
    mod = _load_migration_0016()
    assert mod is not None, "Migration 0016 not found"
    assert mod.down_revision == "0015_encrypted_key_backups"