"""Widerruf von Geraete-Zertifikaten — Kontoloeschung, Admin-Sperre, Sperrliste.

Die Zusage, die hier haengt: ein Self-Host prueft ein Identitaets-Cert
ausschliesslich gegen Signatur und die veroeffentlichte Sperrliste. Was nicht
in dieser Liste steht, ist auf jedem fremden Server bis zu 365 Tage lang
gueltig — auch fuer ein geloeschtes oder gesperrtes Konto.

Der harte Teil ist die Dauerhaftigkeit: ``issued_credentials`` haengt per
CASCADE an ``users``, die Zeile mit der ``cert_id`` ist nach der Loeschung weg.
Der Widerruf muss also die Zeile ueberleben, die er widerruft — deshalb der
Grabstein in ``revoked_credentials`` (Migration 0048), und deshalb prueft der
Loesch-Test ausdruecklich NACH der Kaskade.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import event, select

from dcc_auth.credential_revocation import (
    REASON_ADMIN_DISABLE,
    REASON_USER_REVOKE,
    record_revocation,
)
from dcc_auth.models import IssuedCredential, RevokedCredential, User

PASSWORD = "correct horse battery staple"
_INTERNAL_SECRET = "test-internal-secret-xyz"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _settings(_isolate_settings):
    """Chat-Purge konfiguriert; Redis abgeschaltet.

    ``redis_url=""`` laesst ``publish_revocations`` sofort zurueckkehren — die
    Tests pruefen die dauerhafte Quelle (Datenbank), nicht den schnellen Weg.
    Der eine Test, der den Redis-Weg braucht, haengt sich ein eigenes Fake an.
    """
    _isolate_settings.internal_service_secret = _INTERNAL_SECRET
    _isolate_settings.chat_gateway_url = "http://chat-gateway-test"
    _isolate_settings.redis_url = ""
    return _isolate_settings


@pytest_asyncio.fixture(autouse=True)
async def _sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``.

    Ohne diese Pragma waere der Kernbeweis dieses Moduls wertlos: die Kaskade
    liefe gar nicht, die Zertifikatszeile bliebe stehen, und der Test gruente
    auch ohne Grabstein. Gleiches Muster wie in ``test_account_delete.py``.
    """
    sync_engine = engine.sync_engine

    def _set_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys = ON")
        cur.close()

    event.listen(sync_engine, "connect", _set_pragma)
    await engine.dispose()
    from dcc_auth.db import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql("INSERT INTO auth_settings (id) VALUES (1)")
    yield
    event.remove(sync_engine, "connect", _set_pragma)


@pytest.fixture
def chat_purge_ok(monkeypatch):
    """Der Cross-Service-Purge meldet Erfolg (der echte Weg braucht chat-gw)."""
    from dcc_auth import routes_account

    async def _fake_purge(_user_id):
        return True, None

    monkeypatch.setattr(routes_account, "_purge_chat_state", _fake_purge)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _register(client, username: str) -> str:
    r = await client.post(
        "/register",
        json={
            "username": username,
            "email": f"{username}@dcc-test.example.com",
            "password": PASSWORD,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


async def _login(client, username: str) -> str:
    r = await client.post(
        "/login", json={"email_or_username": username, "password": PASSWORD}
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def _user_id(session_factory, username: str) -> int:
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == username))
        ).scalar_one()
        return user.id


async def _add_cert(session_factory, user_id: int, *, days: int = 365) -> str:
    """Eine Zertifikatszeile direkt setzen — der echte Ausstellungsweg braucht
    ein Session-Cookie und traegt hier nichts zur Aussage bei."""
    cert_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    async with session_factory() as s:
        s.add(
            IssuedCredential(
                cert_id=cert_id,  # type: ignore[arg-type]
                user_id=user_id,
                device_pubkey=uuid.uuid4().bytes * 2,  # 32 Byte, Inhalt egal
                device_label="Testgeraet",
                issued_at=now,
                expires_at=now + timedelta(days=days),
            )
        )
        await s.commit()
    return cert_id


async def _crl_cert_ids(client) -> list[str]:
    r = await client.get("/.well-known/revoked-credentials")
    assert r.status_code == 200, r.text
    return r.json()["cert_ids"]


# ---------------------------------------------------------------------------
# Befund 1 — Kontoloeschung
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_account_delete_revokes_certs_and_tombstone_survives_cascade(
    client, session_factory, chat_purge_ok
):
    """``DELETE /me`` → Zertifikat in der Sperrliste, und zwar NACH der Kaskade.

    Der zweite Teil ist der eigentliche Punkt: die Zertifikatszeile ist weg,
    der Widerruf trotzdem da. Ohne den Grabstein waere er hier unrettbar
    verloren — niemand koennte die ``cert_id`` noch ermitteln.
    """
    await _register(client, "alice")
    user_id = await _user_id(session_factory, "alice")
    cert_id = await _add_cert(session_factory, user_id)

    # Vorher: nichts widerrufen.
    assert await _crl_cert_ids(client) == []

    token = await _login(client, "alice")
    r = await client.request(
        "DELETE",
        "/me",
        json={"password": PASSWORD, "confirm_username": "alice"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        # Die Kaskade hat wirklich zugeschlagen …
        assert (await s.execute(select(User))).scalars().all() == []
        assert (await s.execute(select(IssuedCredential))).scalars().all() == []
        # … der Grabstein steht trotzdem.
        tomb = (await s.execute(select(RevokedCredential))).scalars().one()
        assert str(tomb.cert_id) == cert_id
        assert tomb.reason == "account_delete"

    assert await _crl_cert_ids(client) == [cert_id]


@pytest.fixture
def published(monkeypatch):
    """Faengt den Redis-Push ab und sammelt, was gemeldet wurde."""
    from dcc_auth import routes_account

    pushed: list[tuple[str, datetime]] = []

    async def _fake_publish(revoked):
        pushed.extend(revoked)

    monkeypatch.setattr(routes_account, "publish_revocations", _fake_publish)
    return pushed


@pytest.mark.asyncio
async def test_account_delete_publishes_exactly_the_revoked_certs(
    client, session_factory, chat_purge_ok, published
):
    await _register(client, "alice")
    user_id = await _user_id(session_factory, "alice")
    cert_id = await _add_cert(session_factory, user_id)
    token = await _login(client, "alice")

    r = await client.request(
        "DELETE",
        "/me",
        json={"password": PASSWORD, "confirm_username": "alice"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text
    assert [c for c, _ in published] == [cert_id]


@pytest.mark.asyncio
async def test_failed_delete_publishes_nothing(
    client, session_factory, monkeypatch, published
):
    """Scheitert der Cross-Service-Purge, wird nichts gemeldet und nichts
    widerrufen — sonst stuende ein Zertifikat in der Sperrliste, dessen
    Widerruf die Datenbank nie geschrieben hat."""
    from dcc_auth import routes_account

    async def _failing_purge(_user_id):
        return False, "status_500:boom"

    monkeypatch.setattr(routes_account, "_purge_chat_state", _failing_purge)

    await _register(client, "alice")
    user_id = await _user_id(session_factory, "alice")
    await _add_cert(session_factory, user_id)
    token = await _login(client, "alice")

    r = await client.request(
        "DELETE",
        "/me",
        json={"password": PASSWORD, "confirm_username": "alice"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 503, r.text
    assert published == []
    async with session_factory() as s:
        cred = (await s.execute(select(IssuedCredential))).scalars().one()
        assert cred.revoked_at is None
        assert (await s.execute(select(RevokedCredential))).scalars().all() == []
    assert await _crl_cert_ids(client) == []


@pytest.mark.asyncio
async def test_account_delete_without_certs_leaves_crl_empty(
    client, session_factory, chat_purge_ok
):
    """Nichts zu widerrufen → kein Grabstein, Sperrliste bleibt leer und 200."""
    await _register(client, "alice")
    token = await _login(client, "alice")
    r = await client.request(
        "DELETE",
        "/me",
        json={"password": PASSWORD, "confirm_username": "alice"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.execute(select(RevokedCredential))).scalars().all() == []
    assert await _crl_cert_ids(client) == []


@pytest.mark.asyncio
async def test_expired_cert_gets_no_tombstone(client, session_factory, chat_purge_ok):
    """Ein abgelaufenes Zertifikat wird nicht widerrufen.

    Ein Self-Host weist es schon an ``exp`` ab; ein Eintrag in der Sperrliste
    waere Ballast, den jeder Self-Host im 10-Sekunden-Takt mitliest.
    """
    await _register(client, "alice")
    user_id = await _user_id(session_factory, "alice")
    await _add_cert(session_factory, user_id, days=-1)
    token = await _login(client, "alice")

    r = await client.request(
        "DELETE",
        "/me",
        json={"password": PASSWORD, "confirm_username": "alice"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text
    async with session_factory() as s:
        assert (await s.execute(select(RevokedCredential))).scalars().all() == []


# ---------------------------------------------------------------------------
# Befund 2 — Admin-Sperre
# ---------------------------------------------------------------------------


async def _promote(session_factory, username: str) -> None:
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == username))
        ).scalar_one()
        user.is_admin = True
        await s.commit()


@pytest_asyncio.fixture
async def admin_and_target(client, session_factory):
    """``alice`` ist Admin, ``bob`` das Opfer mit einem Geraete-Zertifikat."""
    await _register(client, "alice")
    await _promote(session_factory, "alice")
    await _register(client, "bob")
    bob_id = await _user_id(session_factory, "bob")
    cert_id = await _add_cert(session_factory, bob_id)
    token = await _login(client, "alice")
    return {"headers": {"Authorization": f"Bearer {token}"}, "id": bob_id, "cert": cert_id}


@pytest.mark.asyncio
async def test_admin_disable_revokes_device_certs(
    client, session_factory, admin_and_target
):
    """Sperren → Zertifikat gestempelt, Grabstein da, Sperrliste traegt es."""
    r = await client.patch(
        f"/admin/users/{admin_and_target['id']}",
        json={"disabled": True},
        headers=admin_and_target["headers"],
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        cred = (await s.execute(select(IssuedCredential))).scalars().one()
        assert cred.revoked_at is not None
        tomb = (await s.execute(select(RevokedCredential))).scalars().one()
        assert str(tomb.cert_id) == admin_and_target["cert"]
        assert tomb.reason == REASON_ADMIN_DISABLE

    assert await _crl_cert_ids(client) == [admin_and_target["cert"]]


@pytest.mark.asyncio
async def test_admin_patch_without_disable_leaves_certs_alone(
    client, session_factory, admin_and_target
):
    """Ein anderes Feld zu setzen widerruft nichts — die Sperre ist der Ausloeser."""
    r = await client.patch(
        f"/admin/users/{admin_and_target['id']}",
        json={"self_host_enabled": True},
        headers=admin_and_target["headers"],
    )
    assert r.status_code == 200, r.text
    async with session_factory() as s:
        cred = (await s.execute(select(IssuedCredential))).scalars().one()
        assert cred.revoked_at is None
        assert (await s.execute(select(RevokedCredential))).scalars().all() == []
    assert await _crl_cert_ids(client) == []


@pytest.mark.asyncio
async def test_admin_unblock_does_not_resurrect_the_cert(
    client, session_factory, admin_and_target
):
    """Entsperren gibt das alte Zertifikat NICHT zurueck — der Nutzer zieht beim
    naechsten Login ein frisches. Der Widerruf bleibt bis ``expires_at`` stehen."""
    await client.patch(
        f"/admin/users/{admin_and_target['id']}",
        json={"disabled": True},
        headers=admin_and_target["headers"],
    )
    r = await client.patch(
        f"/admin/users/{admin_and_target['id']}",
        json={"disabled": False},
        headers=admin_and_target["headers"],
    )
    assert r.status_code == 200, r.text
    assert await _crl_cert_ids(client) == [admin_and_target["cert"]]


# ---------------------------------------------------------------------------
# Sperrliste — Dauerhaftigkeit und Randfaelle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_revocation_is_idempotent(client, session_factory):
    """Zweimal derselbe Pass (Nutzer widerruft, waehrend der Admin sperrt) darf
    nicht am Primaerschluessel scheitern und die Transaktion mitreissen."""
    await _register(client, "alice")
    user_id = await _user_id(session_factory, "alice")
    cert_id = await _add_cert(session_factory, user_id)
    expires = datetime.now(UTC) + timedelta(days=10)

    async with session_factory() as s:
        await record_revocation(s, cert_id, expires, reason=REASON_USER_REVOKE)
        await record_revocation(s, cert_id, expires, reason=REASON_ADMIN_DISABLE)
        await s.commit()
        rows = (await s.execute(select(RevokedCredential))).scalars().all()
    assert len(rows) == 1
    assert rows[0].reason == REASON_USER_REVOKE  # der erste Grund bleibt stehen


@pytest.mark.asyncio
async def test_crl_drops_the_tombstone_only_after_expiry(client, session_factory):
    """Ein Grabstein zaehlt genau bis ``expires_at`` — danach faellt er aus der
    Liste, weil das Zertifikat ohnehin abgelaufen ist."""
    now = datetime.now(UTC)
    async with session_factory() as s:
        s.add(
            RevokedCredential(
                cert_id=str(uuid.uuid4()),  # type: ignore[arg-type]
                expires_at=now - timedelta(minutes=1),
                revoked_at=now - timedelta(days=1),
                reason="account_delete",
            )
        )
        alive = str(uuid.uuid4())
        s.add(
            RevokedCredential(
                cert_id=alive,  # type: ignore[arg-type]
                expires_at=now + timedelta(days=1),
                revoked_at=now - timedelta(days=1),
                reason="account_delete",
            )
        )
        await s.commit()

    assert await _crl_cert_ids(client) == [alive]


@pytest.mark.asyncio
async def test_cleanup_keeps_tombstones_until_expiry(session_factory, engine):
    """Der Sweeper raeumt Grabsteine erst nach ``expires_at`` — eine Sekunde
    frueher liesse das Zertifikat auf jedem Self-Host wieder aufleben."""
    from dcc_auth.cleanup import _run_once
    from dcc_auth.config import get_settings

    now = datetime.now(UTC)
    alive = str(uuid.uuid4())
    async with session_factory() as s:
        s.add(
            RevokedCredential(
                cert_id=alive,  # type: ignore[arg-type]
                expires_at=now + timedelta(days=30),
                revoked_at=now,
                reason="account_delete",
            )
        )
        s.add(
            RevokedCredential(
                cert_id=str(uuid.uuid4()),  # type: ignore[arg-type]
                expires_at=now - timedelta(seconds=5),
                revoked_at=now - timedelta(days=400),
                reason="account_delete",
            )
        )
        await s.commit()

    counts = await _run_once(engine, get_settings())
    assert counts["revoked_credentials_expired"] == 1
    async with session_factory() as s:
        rows = (await s.execute(select(RevokedCredential))).scalars().all()
    assert [str(r.cert_id) for r in rows] == [alive]


class _FakeRedis:
    """Nur die Operationen, die ``routes_crl`` anfasst."""

    def __init__(self):
        self._zsets: dict[str, dict[str, float]] = {}
        self._strings: dict[str, str] = {}

    async def ping(self):
        return True

    async def zadd(self, key, mapping):
        self._zsets.setdefault(key, {}).update(mapping)

    async def zrange(self, key, start, stop):
        members = sorted(self._zsets.get(key, {}).items(), key=lambda x: x[1])
        return [m[0] for m in members]

    async def zremrangebyscore(self, key, minv, maxv):
        lo = float("-inf") if minv == "-inf" else float(minv)
        hi = float("inf") if maxv == "+inf" else float(maxv)
        z = self._zsets.get(key, {})
        for m in [m for m, s in list(z.items()) if lo <= s <= hi]:
            del z[m]

    async def get(self, key):
        return self._strings.get(key)

    async def set(self, key, value, ex=None):
        self._strings[key] = value


@pytest.mark.asyncio
async def test_empty_redis_zset_is_reseeded_from_the_tombstones(
    client, app, session_factory
):
    """Ein leergelaufenes ZSET wird aus der Datenbank nachgefuellt.

    Ohne das haette der Grabstein in Produktion keine Wirkung: dort ist Redis
    immer erreichbar, der schnelle Weg gewinnt, und ein Neustart ohne
    Persistenz veroeffentlichte eine leere Sperrliste — jedes widerrufene
    Zertifikat lebte fuer den Rest seiner Laufzeit wieder auf.
    """
    now = datetime.now(UTC)
    cert_id = str(uuid.uuid4())
    async with session_factory() as s:
        s.add(
            RevokedCredential(
                cert_id=cert_id,  # type: ignore[arg-type]
                expires_at=now + timedelta(days=1),
                revoked_at=now,
                reason="account_delete",
            )
        )
        await s.commit()

    fake = _FakeRedis()
    app.state.redis = fake
    assert await _crl_cert_ids(client) == [cert_id]
    # Und das ZSET traegt ihn danach selbst — der naechste Poll geht wieder
    # den schnellen Weg.
    assert list(fake._zsets["auth:revoked_certs"]) == [cert_id]
