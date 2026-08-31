"""Tests für ``/me/recovery-package`` (Ablage §8, Aufgabe 3).

Nicht zu verwechseln mit ``test_recovery.py`` (Passwort-Reset/E-Mail).
"""

from __future__ import annotations

import base64

import pytest
import pytest_asyncio
from dcc_auth.db import Base

REG = {
    "username": "recovery_pkg_user",
    "email": "recoverypkg@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Recovery Pkg",
}
_LOGIN = {"email_or_username": REG["email"], "password": REG["password"]}


async def _register_and_login(client):
    await client.post("/register", json=REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200, r.text
    return r


def _bearer(login_r) -> dict[str, str]:
    return {"Authorization": f"Bearer {login_r.json()['access_token']}"}


def _blob(n: int = 64) -> str:
    return base64.b64encode(b"x" * n).decode()


@pytest.mark.asyncio
async def test_get_without_package_is_404(client):
    login_r = await _register_and_login(client)
    r = await client.get("/me/recovery-package", headers=_bearer(login_r))
    assert r.status_code == 404
    assert r.json()["detail"] == "no_recovery_package"


@pytest.mark.asyncio
async def test_put_then_get_roundtrip(client):
    login_r = await _register_and_login(client)
    payload = {"ciphertext": _blob()}

    put_r = await client.put(
        "/me/recovery-package", json=payload, headers=_bearer(login_r)
    )
    assert put_r.status_code == 200, put_r.text
    assert put_r.json()["ciphertext"] == payload["ciphertext"]
    assert "updated_at" in put_r.json()

    get_r = await client.get("/me/recovery-package", headers=_bearer(login_r))
    assert get_r.status_code == 200
    assert get_r.json()["ciphertext"] == payload["ciphertext"]


@pytest.mark.asyncio
async def test_put_replaces_existing_package(client):
    login_r = await _register_and_login(client)
    await client.put(
        "/me/recovery-package", json={"ciphertext": _blob(32)}, headers=_bearer(login_r)
    )
    second = _blob(96)
    put_r = await client.put(
        "/me/recovery-package", json={"ciphertext": second}, headers=_bearer(login_r)
    )
    assert put_r.status_code == 200

    get_r = await client.get("/me/recovery-package", headers=_bearer(login_r))
    assert get_r.json()["ciphertext"] == second


@pytest.mark.asyncio
async def test_delete_then_get_is_404_again(client):
    login_r = await _register_and_login(client)
    await client.put(
        "/me/recovery-package", json={"ciphertext": _blob()}, headers=_bearer(login_r)
    )
    del_r = await client.delete("/me/recovery-package", headers=_bearer(login_r))
    assert del_r.status_code == 204

    get_r = await client.get("/me/recovery-package", headers=_bearer(login_r))
    assert get_r.status_code == 404


@pytest.mark.asyncio
async def test_delete_without_package_is_idempotent(client):
    login_r = await _register_and_login(client)
    del_r = await client.delete("/me/recovery-package", headers=_bearer(login_r))
    assert del_r.status_code == 204


@pytest.mark.asyncio
async def test_requires_auth(client):
    await client.post("/register", json=REG)
    assert (await client.get("/me/recovery-package")).status_code == 401
    assert (
        await client.put("/me/recovery-package", json={"ciphertext": _blob()})
    ).status_code == 401
    assert (await client.delete("/me/recovery-package")).status_code == 401


@pytest.mark.asyncio
async def test_oversized_package_rejected(client):
    login_r = await _register_and_login(client)
    from dcc_auth.schemas import RECOVERY_PACKAGE_MAX_B64

    too_big = "a" * (RECOVERY_PACKAGE_MAX_B64 + 1)
    r = await client.put(
        "/me/recovery-package", json={"ciphertext": too_big}, headers=_bearer(login_r)
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_second_user_cannot_see_first_users_package(client):
    """Nur der Konto-Eigentümer — kein anderes Konto sieht dasselbe Päckchen."""
    login_r = await _register_and_login(client)
    await client.put(
        "/me/recovery-package", json={"ciphertext": _blob()}, headers=_bearer(login_r)
    )

    other_reg = {**REG, "username": "recovery_pkg_user_2", "email": "other@dcc-test.example.com"}
    await client.post("/register", json=other_reg)
    other_login = await client.post(
        "/login",
        json={"email_or_username": other_reg["email"], "password": other_reg["password"]},
    )
    assert other_login.status_code == 200

    get_r = await client.get("/me/recovery-package", headers=_bearer(other_login))
    assert get_r.status_code == 404


@pytest_asyncio.fixture
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys = ON``
    pro Verbindung. Postgres (Prod) erzwingt das immer — Muster 1:1 aus
    ``test_account_delete.py::_enable_sqlite_foreign_keys``."""
    from sqlalchemy import event

    sync_engine = engine.sync_engine

    def _set_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys = ON")
        cur.close()

    event.listen(sync_engine, "connect", _set_pragma)
    await engine.dispose()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql("INSERT INTO auth_settings (id) VALUES (1)")
        await conn.exec_driver_sql("INSERT INTO smtp_settings (id) VALUES (1)")
    yield
    event.remove(sync_engine, "connect", _set_pragma)


@pytest.mark.asyncio
async def test_account_delete_cascades_recovery_package(
    client, session_factory, _enable_sqlite_foreign_keys
):
    """FK-CASCADE: das Päckchen darf keine Kontolöschung überleben (kein
    Datenrest). Direkter DB-Check statt über ``DELETE /me`` — der Weg über die
    Route braucht chat-gateway-Erreichbarkeit + Passwort/2FA-Gates, die mit
    dem Päckchen selbst nichts zu tun haben; die Kaskade ist DB-Mechanik."""
    login_r = await _register_and_login(client)
    await client.put(
        "/me/recovery-package", json={"ciphertext": _blob()}, headers=_bearer(login_r)
    )

    from dcc_auth.models import User
    from dcc_auth.models_recovery_package import RecoveryPackage
    from sqlalchemy import select

    async with session_factory() as session:
        user_id = (
            await session.execute(select(User.id).where(User.username == REG["username"]))
        ).scalar_one()
        await session.execute(User.__table__.delete().where(User.id == user_id))
        await session.commit()

        remaining = (
            await session.execute(
                select(RecoveryPackage).where(RecoveryPackage.user_id == user_id)
            )
        ).scalar_one_or_none()
        assert remaining is None
