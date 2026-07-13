"""Tests for ``DELETE /me`` — self-service hard-delete of an account.

The cross-service POST to chat-gateway is monkeypatched at the
``routes_account._purge_chat_state`` helper (not at ``httpx.AsyncClient``
— the test client itself uses httpx-ASGI to drive the auth-svc, so a
broad httpx-patch would catch its own traffic too).

The ``chat_purge_calls`` fixture returns ``(calls, responses)``:
* ``calls`` accumulates every invocation as ``{url, headers}``.
* ``responses`` is a list a test can pre-load with a ``_FakeResponse``
  to override the default 204 (e.g. push a 500 for the rollback test).
"""

from __future__ import annotations

import io

import pyotp
import pytest
import pytest_asyncio
from dcc_auth.models import (
    AdminAuditLog,
    BackupCode,
    RefreshToken,
    User,
)
from PIL import Image
from sqlalchemy import select

REG = {
    "username": "alice",
    "email": "alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}

_INTERNAL_SECRET = "test-internal-secret-xyz"


@pytest.fixture(autouse=True)
def _set_internal_secret(_isolate_settings):
    """Default-on: every test gets the secret configured. The one negative
    test that exercises the ``None`` branch explicitly unsets it."""
    _isolate_settings.internal_service_secret = _INTERNAL_SECRET
    _isolate_settings.chat_gateway_url = "http://chat-gateway-test"


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignores ``ON DELETE CASCADE`` unless ``PRAGMA foreign_keys =
    ON`` is set per connection. Postgres (prod) enforces unconditionally,
    so the production behaviour we're testing is the cascading delete of
    refresh-token + backup-code rows. Without this pragma the suite would
    happily green on sqlite while shipping a broken cascade.

    The conftest's ``engine`` fixture already opened connections (to
    ``CREATE TABLE`` + seed singletons) before our listener could attach,
    so we (1) attach the listener, (2) ``dispose()`` the pool so any
    further checkout creates a fresh connection that picks up the pragma,
    and (3) remove the listener on teardown. Per-test-function scope —
    every test gets a fresh in-memory DB anyway.
    """
    from sqlalchemy import event

    sync_engine = engine.sync_engine

    def _set_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys = ON")
        cur.close()

    event.listen(sync_engine, "connect", _set_pragma)
    await engine.dispose()
    # Re-create the tables on the new connection pool — :memory: SQLite
    # discards its schema when its only connection closes during dispose.
    from dcc_auth.db import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql("INSERT INTO auth_settings (id) VALUES (1)")
    yield
    event.remove(sync_engine, "connect", _set_pragma)


class _FakeResponse:
    def __init__(self, status_code: int, text: str = ""):
        self.status_code = status_code
        self.text = text


@pytest.fixture
def chat_purge_calls(monkeypatch):
    """Collect every chat-gateway purge invocation. Default = success.

    Returns ``(calls, responses)``. ``calls`` is a list of dicts with
    ``url``/``headers`` per invocation. Tests can pre-load ``responses``
    with a ``_FakeResponse`` to override the default 204.

    We patch ``httpx.AsyncClient.post`` *scoped to the routes_account
    module* — via the module-local helper — so the test client's own
    ASGI httpx instance (used to drive the /register, /login, /me etc.
    requests) is untouched.
    """
    from dcc_auth import routes_account

    calls: list[dict] = []
    responses: list[_FakeResponse] = []

    async def _fake_purge(user_id):  # signature mirrors _purge_chat_state
        import dcc_auth.config as _cfg

        settings = _cfg.get_settings()
        secret = settings.internal_service_secret
        if not secret:
            return False, "no_internal_secret"
        url = (
            settings.chat_gateway_url.rstrip("/")
            + f"/internal/users/{user_id}/purge"
        )
        headers = {"X-Pulse-Internal-Secret": secret}
        calls.append({"url": url, "headers": headers})
        resp = responses[-1] if responses else _FakeResponse(204)
        if 200 <= resp.status_code < 300:
            return True, None
        return False, f"status_{resp.status_code}:{resp.text[:200]}"

    monkeypatch.setattr(routes_account, "_purge_chat_state", _fake_purge)
    return calls, responses


async def _register(client) -> dict:
    r = await client.post("/register", json=REG)
    assert r.status_code == 201, r.text
    return r.json()


async def _enable_2fa(client, bearer) -> str:
    """Mirror of the helper in test_recovery.py — returns the TOTP secret."""
    setup = (await client.post("/totp/setup", headers=bearer)).json()
    code = pyotp.TOTP(setup["secret"]).now()
    r = await client.post("/totp/verify-setup", json={"code": code}, headers=bearer)
    assert r.status_code == 200
    return setup["secret"]


# ---- Negative path: input validation -----------------------------------


@pytest.mark.asyncio
async def test_delete_me_requires_password(client, session_factory, chat_purge_calls):
    """Wrong password → 401, user row still present, no chat call made."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    calls, _ = chat_purge_calls

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": "wrong",
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 401, r.text
    async with session_factory() as s:
        rows = (await s.execute(select(User))).scalars().all()
        assert len(rows) == 1
    assert calls == []


@pytest.mark.asyncio
async def test_delete_me_requires_username_confirm(client, session_factory, chat_purge_calls):
    """Mismatched confirm_username → 400, no DB mutation, no chat call."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    calls, _ = chat_purge_calls

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": "wronguser",
        },
        headers=bearer,
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "username_mismatch"
    async with session_factory() as s:
        assert (await s.execute(select(User))).scalars().one()
    assert calls == []


@pytest.mark.asyncio
async def test_delete_me_requires_totp_when_enabled(client, chat_purge_calls):
    """2FA on + no code/backup_code → 401, no chat call."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    await _enable_2fa(client, bearer)
    calls, _ = chat_purge_calls

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid code"
    assert calls == []


@pytest.mark.asyncio
async def test_delete_me_with_backup_code_works(client, session_factory, chat_purge_calls):
    """2FA on + valid backup code → 204, user gone, backup code consumed."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    await _enable_2fa(client, bearer)

    # Same trick as test_recovery: regenerate to get plaintext backup codes.
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

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "backup_code": backup,
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 204, r.text
    async with session_factory() as s:
        assert (await s.execute(select(User))).scalars().all() == []
        # BackupCode rows cascade-deleted with the user; no need to check
        # ``used_at`` (the row itself is gone).


# ---- Happy path --------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_me_hard_deletes_user(client, session_factory, chat_purge_calls):
    """No 2FA + correct creds → 204, user gone from DB."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 204, r.text
    assert r.text == ""

    async with session_factory() as s:
        rows = (await s.execute(select(User))).scalars().all()
        assert rows == []


@pytest.mark.asyncio
async def test_delete_me_cascades_refresh_tokens(client, session_factory, chat_purge_calls):
    """Several active refresh-tokens → cascade-deleted when user goes."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    # Log in twice more so we have 3 refresh-tokens for this user.
    for _ in range(2):
        r = await client.post(
            "/login",
            json={"email_or_username": REG["email"], "password": REG["password"]},
        )
        assert r.status_code == 200, r.text

    async with session_factory() as s:
        count_before = len((await s.execute(select(RefreshToken))).scalars().all())
        assert count_before == 3

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.execute(select(RefreshToken))).scalars().all() == []
        # BackupCode + audit-log invariants too — the latter must survive.
        assert (await s.execute(select(BackupCode))).scalars().all() == []
        audits = (await s.execute(select(AdminAuditLog))).scalars().all()
        assert len(audits) == 1
        assert audits[0].action == "user.self_delete"
        assert audits[0].payload == {"username": REG["username"]}


@pytest.mark.asyncio
async def test_delete_me_calls_chat_purge(client, chat_purge_calls):
    """Mock asserts the chat-gateway purge was called with the right
    URL, internal-secret header, and the calling user's snowflake id."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    calls, _ = chat_purge_calls

    me = (await client.get("/me", headers=bearer)).json()
    expected_id = me["id"]

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 204, r.text

    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == f"http://chat-gateway-test/internal/users/{expected_id}/purge"
    assert call["headers"]["X-Pulse-Internal-Secret"] == _INTERNAL_SECRET


@pytest.mark.asyncio
async def test_delete_me_rollback_on_chat_failure(
    client, session_factory, chat_purge_calls
):
    """chat-gateway returns 500 → DELETE 503, user row still present."""
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    calls, responses = chat_purge_calls
    responses.append(_FakeResponse(500, "boom"))

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 503
    assert r.json()["detail"] == "chat_gateway_purge_failed"

    async with session_factory() as s:
        assert len((await s.execute(select(User))).scalars().all()) == 1
        # No audit row written on the failure path.
        assert (await s.execute(select(AdminAuditLog))).scalars().all() == []
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_delete_me_503_without_internal_secret(
    client, _isolate_settings, session_factory, chat_purge_calls
):
    """internal_service_secret=None → 503 BEFORE any chat call."""
    _isolate_settings.internal_service_secret = None
    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    calls, _ = chat_purge_calls

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 503
    assert r.json()["detail"] == "deletion_disabled_no_internal_secret"
    assert calls == []
    async with session_factory() as s:
        assert len((await s.execute(select(User))).scalars().all()) == 1


# ---- Side effects: avatar cleanup --------------------------------------


@pytest.mark.asyncio
async def test_delete_me_removes_avatar_file(
    client, session_factory, tmp_path, _isolate_settings, chat_purge_calls
):
    """Upload an avatar, then self-delete — the .webp on disk must be gone."""
    _isolate_settings.avatar_upload_dir = str(tmp_path)

    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    me = (await client.get("/me", headers=bearer)).json()
    user_id = me["id"]

    # Upload a small PNG (auth-svc re-encodes to <id>.webp).
    img = Image.new("RGB", (40, 40), color=(10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    up = await client.post(
        "/me/avatar",
        headers=bearer,
        files={"file": ("a.png", io.BytesIO(buf.getvalue()), "image/png")},
    )
    assert up.status_code == 200, up.text
    avatar_file = tmp_path / f"{user_id}.webp"
    assert avatar_file.exists()

    r = await client.request(
        "DELETE",
        "/me",
        json={
            "password": REG["password"],
            "confirm_username": REG["username"],
        },
        headers=bearer,
    )
    assert r.status_code == 204, r.text
    assert not avatar_file.exists()


# ---- Instance owner path (Migration 0043) --------------------------------


@pytest.mark.asyncio
async def test_delete_me_with_owned_instance_soft_deletes_it(
    client, session_factory, chat_purge_calls
):
    """Ein Instanz-Besitzer kann sein Konto löschen (vorher: FK-Verletzung → 500).

    Erwartung: Instanz-Zeile überlebt als ``status='deleted'`` mit
    freigegebenem Hostname und ``registered_by=NULL`` (Worker-ID-Reservierung
    + Kill-Switch); Membership + Bootstrap-Tokens verschwinden; der eigene
    Antrag fällt mit dem Konto (CASCADE, personenbezogene Daten); ein
    ``suspended_instances``-Eintrag (Kill-Switch) existiert.
    """
    from datetime import UTC, datetime, timedelta

    from dcc_auth.models_instances import (
        InstanceApplication,
        InstanceBootstrapToken,
        RegisteredInstance,
        SuspendedInstance,
        UserInstanceMembership,
    )
    from dcc_auth.snowflake import next_id

    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    async with session_factory() as s:
        user = (await s.execute(select(User))).scalar_one()
        inst_id = next_id()
        s.add(
            RegisteredInstance(
                id=inst_id,
                hostname="pulse.alice.example.org",
                client_id="inst-alice-1",
                client_secret="x" * 32,
                worker_id_chat=100,
                worker_id_voice=100,
                worker_id_media=100,
                registered_by=user.id,
            )
        )
        s.add(UserInstanceMembership(user_id=user.id, instance_id=inst_id))
        s.add(
            InstanceApplication(
                id=next_id(),
                applicant_user_id=user.id,
                hostname="pulse.alice.example.org",
                purpose="privat",
                expected_users=5,
                contact_email=REG["email"],
                status="approved",
                approved_instance_id=inst_id,
            )
        )
        s.add(
            InstanceBootstrapToken(
                id=next_id(),
                instance_id=inst_id,
                token_hash="h" * 64,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
        )
        await s.commit()

    r = await client.request(
        "DELETE",
        "/me",
        json={"password": REG["password"], "confirm_username": REG["username"]},
        headers=bearer,
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.execute(select(User))).scalars().all() == []
        inst = (await s.execute(select(RegisteredInstance))).scalar_one()
        assert inst.status == "deleted"
        assert inst.hostname == f"deleted-{inst_id}.invalid"
        assert inst.registered_by is None
        assert (await s.execute(select(UserInstanceMembership))).scalars().all() == []
        assert (await s.execute(select(InstanceBootstrapToken))).scalars().all() == []
        assert (await s.execute(select(InstanceApplication))).scalars().all() == []
        susp = (await s.execute(select(SuspendedInstance))).scalar_one()
        assert susp.instance_id == inst_id


@pytest.mark.asyncio
async def test_delete_me_with_rejected_application_only(
    client, session_factory, chat_purge_calls
):
    """Auch ein bloßer (abgelehnter) Antrag ohne Instanz blockierte die
    Konto-Löschung über die applicant-FK — jetzt CASCADE."""
    from dcc_auth.models_instances import InstanceApplication
    from dcc_auth.snowflake import next_id

    tokens = await _register(client)
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}

    async with session_factory() as s:
        user = (await s.execute(select(User))).scalar_one()
        s.add(
            InstanceApplication(
                id=next_id(),
                applicant_user_id=user.id,
                hostname="pulse.bob.example.org",
                purpose="privat",
                expected_users=5,
                contact_email=REG["email"],
                status="rejected",
                rejection_reason="test",
            )
        )
        await s.commit()

    r = await client.request(
        "DELETE",
        "/me",
        json={"password": REG["password"], "confirm_username": REG["username"]},
        headers=bearer,
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.execute(select(User))).scalars().all() == []
        assert (await s.execute(select(InstanceApplication))).scalars().all() == []
