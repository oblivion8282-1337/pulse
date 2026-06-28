"""Tests für den Ein-Befehl-Installer: Mint + Redeem von Bootstrap-Tokens.

Deckt: Mint (Auth/Owner/Invalidierung), Redeem (Happy/Secret-Rotation/
single-use/expired/invalid).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select

from dcc_auth.models_instances import InstanceBootstrapToken, RegisteredInstance
from dcc_auth.security import verify_password

_REG_A = {
    "username": "boot_alice",
    "email": "boot_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}
_REG_B = {
    "username": "boot_bob",
    "email": "boot_bob@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Bob",
}
_FAKE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fakehash"


async def _reg_and_login(client, reg: dict) -> tuple[str, str]:
    """Register + login → (cookie-header, user_id)."""
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    me = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return f"pulse_session={sid}", me.json()["id"]


@pytest_asyncio.fixture
async def alice(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_A)
    # Grant the self-hosting flag so mint-token tests can succeed.
    async with session_factory() as s:
        from dcc_auth.models import User
        user = await s.get(User, int(uid))
        user.self_host_enabled = True
        await s.commit()
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def bob(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_B)
    # Also grant the flag so the ownership check (not the gate) triggers.
    async with session_factory() as s:
        from dcc_auth.models import User
        user = await s.get(User, int(uid))
        user.self_host_enabled = True
        await s.commit()
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def no_flag_user(client, session_factory):
    """Owner OHNE self_host_enabled — testet, dass der Gate weg ist."""
    cookie, uid = await _reg_and_login(client, {
        "username": "boot_noflag",
        "email": "boot_noflag@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": "NoFlag",
    })
    async with session_factory() as s:
        from dcc_auth.models import User
        user = await s.get(User, int(uid))
        assert user.self_host_enabled is False  # Default
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def alice_instance(session_factory, alice) -> RegisteredInstance:
    async with session_factory() as session:
        inst = RegisteredInstance(
            id=20000000000000001,
            hostname="boot-instance.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret=_FAKE_HASH,
            worker_id_chat=110,
            worker_id_voice=111,
            worker_id_media=112,
            status="active",
            registered_by=int(alice["id"]),
        )
        session.add(inst)
        await session.commit()
        await session.refresh(inst)
    return inst


# --------------------------------------------------------------------------- #
# Mint                                                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_mint_requires_cookie(client, alice_instance):
    r = await client.post(f"/me/instances/{alice_instance.id}/bootstrap-token")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_mint_happy_path(client, alice, alice_instance):
    r = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["token"].startswith("plse_boot_")
    assert data["ttl_seconds"] > 0
    assert "expires_at" in data


@pytest.mark.asyncio
async def test_mint_non_owner_404(client, bob, alice_instance):
    r = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": bob["cookie"]},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_mint_invalidates_previous_pre_redeem(
    client, alice, alice_instance, session_factory
):
    """Solange noch kein Token eingelöst wurde, darf der Owner beliebig oft
    einen neuen Token minten — der alte wird jedes Mal invalidiert."""
    r1 = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    old_token = r1.json()["token"]
    r2 = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r2.status_code == 201
    # Nur ein Token-Row für die Instanz übrig.
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(InstanceBootstrapToken).where(
                    InstanceBootstrapToken.instance_id == alice_instance.id
                )
            )
        ).scalars().all()
    assert len(rows) == 1
    # Der alte Token löst nicht mehr ein.
    rr = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {old_token}"}
    )
    assert rr.status_code == 401


@pytest.mark.asyncio
async def test_mint_works_without_self_host_enabled(
    client, no_flag_user, alice_instance, session_factory
):
    """Owner braucht KEIN users.self_host_enabled=true mehr — die
    Admin-Approval der Self-Host-Instanz ist die einzige Voraussetzung."""
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, alice_instance.id, with_for_update=True)
        inst.registered_by = int(no_flag_user["id"])
        await s.commit()

    r = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": no_flag_user["cookie"]},
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_mint_blocked_after_successful_redeem(
    client, alice, alice_instance, session_factory
):
    """Sobald ein Token eingelöst wurde (Redeem), ist die Instanz
    'setup-komplett' — weitere Mints sind geblockt, User muss neuen Antrag
    stellen."""
    token = await _mint(client, alice, alice_instance.id)

    # Redeem → consumed_at wird gesetzt.
    rr = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert rr.status_code == 200, rr.text

    # Folge-Mint ist geblockt.
    r2 = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r2.status_code == 403
    assert "bereits eingelöst" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_mint_allowed_when_previous_expired_without_redeem(
    client, alice, alice_instance, session_factory
):
    """Weich-Variante: TTL-Ablauf ohne Redeem (User hat das Setup-Script
    ver-kritzelt oder vergessen) erlaubt einen weiteren Mint-Versuch."""
    r1 = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r1.status_code == 201

    # Token in der DB ablaufen lassen — kein Redeem dazwischen.
    async with session_factory() as s:
        row = (
            await s.execute(
                select(InstanceBootstrapToken).where(
                    InstanceBootstrapToken.instance_id == alice_instance.id
                )
            )
        ).scalar_one()
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()

    # Folge-Mint ist erlaubt (kein consumed Token vorhanden).
    r2 = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r2.status_code == 201, r2.text


# --------------------------------------------------------------------------- #
# Redeem                                                                        #
# --------------------------------------------------------------------------- #


async def _mint(client, alice, instance_id) -> str:
    r = await client.post(
        f"/me/instances/{instance_id}/bootstrap-token",
        headers={"Cookie": alice["cookie"]},
    )
    assert r.status_code == 201, r.text
    return r.json()["token"]


@pytest.mark.asyncio
async def test_redeem_happy_and_rotates_secret(
    client, alice, alice_instance, session_factory
):
    token = await _mint(client, alice, alice_instance.id)
    r = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["instance_id"] == str(alice_instance.id)
    assert data["hostname"] == "boot-instance.example.com"
    assert data["client_id"] == alice_instance.client_id
    assert data["owner_user_id"] == str(alice["id"])
    assert data["admin_email"] == _REG_A["email"]
    assert data["cloud_origin"].startswith("https://")
    new_secret = data["client_secret"]
    assert new_secret and len(new_secret) > 20

    # Secret wurde rotiert: DB-Hash passt zum neuen Klartext, nicht mehr zum Fake.
    async with session_factory() as session:
        inst = await session.get(RegisteredInstance, alice_instance.id)
        assert inst.client_secret != _FAKE_HASH
        assert verify_password(new_secret, inst.client_secret)


@pytest.mark.asyncio
async def test_redeem_is_single_use(client, alice, alice_instance):
    token = await _mint(client, alice, alice_instance.id)
    r1 = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r1.status_code == 200
    r2 = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r2.status_code == 401


@pytest.mark.asyncio
async def test_redeem_expired(client, alice, alice_instance, session_factory):
    token = await _mint(client, alice, alice_instance.id)
    # Ablauf in die Vergangenheit schieben.
    async with session_factory() as session:
        row = (
            await session.execute(
                select(InstanceBootstrapToken).where(
                    InstanceBootstrapToken.instance_id == alice_instance.id
                )
            )
        ).scalar_one()
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    r = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_redeem_missing_or_invalid_token(client):
    assert (await client.post("/selfhost/bootstrap")).status_code == 401
    r = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": "Bearer not_a_pulse_token"}
    )
    assert r.status_code == 401
    r2 = await client.post(
        "/selfhost/bootstrap", headers={"Authorization": "Bearer plse_boot_doesnotexist"}
    )
    assert r2.status_code == 401
