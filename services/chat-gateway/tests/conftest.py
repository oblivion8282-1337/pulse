"""Test fixtures for the chat-gateway.

Strategy:
  - Use the auth-svc's JwtSigner (same RSA keypair in secrets/) to mint
    tokens and inject its public JWKS into the chat-gateway via
    `install_static_jwks`.
  - SQLite + aiosqlite for the DB, schema flattened on the metadata before
    create_all.
  - Real Redis at REDIS_URL (defaults to localhost:6380), so the
    ConnectionManager exercises actual pub/sub. Each test uses a unique
    channel-id space so cross-test pollution is impossible.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[3]
SECRETS = ROOT / "secrets"
os.environ.setdefault("JWT_PRIVATE_KEY_FILE", str(SECRETS / "jwt_private.pem"))
os.environ.setdefault("JWT_PUBLIC_KEY_FILE", str(SECRETS / "jwt_public.pem"))
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

# Make sure the auth-svc settings load from the same secrets.
os.environ.setdefault("CORS_ALLOW_ORIGINS", "http://test")

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

import dcc_chat_gateway.config as chat_cfg  # noqa: E402
import dcc_chat_gateway.security as chat_security  # noqa: E402
import dcc_chat_gateway.snowflake as chat_snow  # noqa: E402
from dcc_auth.config import Settings as AuthSettings  # noqa: E402
from dcc_auth.security import JwtSigner, reset_signer  # noqa: E402
from dcc_chat_gateway import models as _models  # noqa: F401,E402
from dcc_chat_gateway.app import create_app  # noqa: E402
from dcc_chat_gateway.db import Base, get_session  # noqa: E402


# Configure the test settings (database, JWT audience/issuer must match what
# the JwtSigner emits).
_TEST_SETTINGS = chat_cfg.Settings(
    database_url="sqlite+aiosqlite:///:memory:",
    redis_url=os.environ.get("REDIS_URL", "redis://localhost:6380/0"),
    auth_jwks_url="http://stub/jwks",
    database_schema="main",
)


@pytest.fixture(autouse=True)
def _isolate_chat_settings():
    import dcc_chat_gateway.ratelimit as chat_ratelimit

    chat_ratelimit.reset()
    chat_cfg.get_settings.cache_clear()

    def _provider() -> chat_cfg.Settings:
        return _TEST_SETTINGS

    original = chat_cfg.get_settings
    chat_cfg.get_settings = _provider  # type: ignore[assignment]
    chat_security.get_settings = _provider  # type: ignore[assignment]
    chat_snow.get_settings = _provider  # type: ignore[assignment]
    chat_snow._gen = None
    chat_security.reset_cache()
    yield _TEST_SETTINGS
    chat_cfg.get_settings = original  # type: ignore[assignment]
    chat_cfg.get_settings.cache_clear()
    chat_security.reset_cache()


@pytest_asyncio.fixture
async def _auth_signer(_isolate_chat_settings) -> JwtSigner:
    # Provide a fresh signer using a Settings that points at the same audience.
    auth_settings = AuthSettings(
        jwt_private_key_file=SECRETS / "jwt_private.pem",
        jwt_public_key_file=SECRETS / "jwt_public.pem",
        jwt_audience="dcc",
        jwt_issuer="dcc-auth",
    )
    import dcc_auth.config as auth_cfg
    original = auth_cfg.get_settings

    def _provider() -> AuthSettings:
        return auth_settings

    auth_cfg.get_settings = _provider  # type: ignore[assignment]
    import dcc_auth.security as sec
    sec.get_settings = _provider  # type: ignore[assignment]
    reset_signer()
    signer = JwtSigner()
    # Install JWKS in the chat-gateway's verifier
    chat_security.install_static_jwks(signer.jwks())
    yield signer
    auth_cfg.get_settings = original  # type: ignore[assignment]
    reset_signer()


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine(_TEST_SETTINGS.effective_database_url, future=True)
    async with eng.begin() as conn:
        for table in Base.metadata.tables.values():
            table.schema = None
        await conn.run_sync(Base.metadata.create_all)
        # Seed singletons (the prod migration does this; create_all doesn't).
        # ``allow_guild_creation=true`` is a test-suite convenience — most
        # tests register a non-admin user and POST /guilds without caring
        # about the production gate. Tests that *do* care about the gate
        # toggle it explicitly via the admin endpoint (see test_permissions).
        # Prod default is false (locked down — only the bootstrap admin
        # opens it up).
        await conn.exec_driver_sql(
            "INSERT INTO chat_settings (id, allow_guild_creation) VALUES (1, true)"
        )
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def session_factory(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest_asyncio.fixture
async def app(session_factory, _auth_signer):
    """REST-only app fixture (no live ConnectionManager).

    httpx.ASGITransport does not run lifespan handlers, so we wire the
    ConnectionManager up manually here, in the *current* event loop. The
    REST-side `post_message` checks the manager for None before
    publishing, so we install a real one for those tests.
    """
    import dcc_chat_gateway.routes.ws_op_send as routes_ws_op_send
    import dcc_chat_gateway.routes.ws_ops as routes_ws_ops
    import dcc_chat_gateway.routes.ws_ops_handlers as routes_ws_ops_handlers
    import dcc_chat_gateway.routes.ws_ready as routes_ws_ready
    from redis.asyncio import Redis

    from dcc_chat_gateway.pubsub import ConnectionManager

    # Schritt 2 (op-handler-registry) split the old single ws_ops.SessionLocal
    # across per-handler modules that each import SessionLocal directly.
    # ws_ops still re-exports it for push.py + app.py consumers, so we patch
    # every site to keep the SQLite test factory honoured.
    original_factory_ops = routes_ws_ops.SessionLocal
    original_factory_handlers = routes_ws_ops_handlers.SessionLocal
    original_factory_send = routes_ws_op_send.SessionLocal
    original_factory_ready = routes_ws_ready.SessionLocal
    routes_ws_ops.SessionLocal = session_factory
    routes_ws_ops_handlers.SessionLocal = session_factory
    routes_ws_op_send.SessionLocal = session_factory
    routes_ws_ready.SessionLocal = session_factory

    application = create_app(skip_redis=True)
    redis = Redis.from_url(_TEST_SETTINGS.redis_url, decode_responses=False)
    manager = ConnectionManager(redis)
    manager.set_session_factory(session_factory)
    await manager.start()
    application.state.redis = redis
    application.state.connection_manager = manager

    async def _override_get_session() -> AsyncIterator:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = _override_get_session
    try:
        yield application
    finally:
        application.dependency_overrides.clear()
        await manager.stop()
        try:
            await redis.aclose()
        except Exception:
            pass
        routes_ws_ops.SessionLocal = original_factory_ops
        routes_ws_ops_handlers.SessionLocal = original_factory_handlers
        routes_ws_op_send.SessionLocal = original_factory_send
        routes_ws_ready.SessionLocal = original_factory_ready


@pytest_asyncio.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def ws_app(_auth_signer, tmp_path):
    """WebSocket app fixture — let starlette's TestClient own the lifespan.

    SQLite must be file-backed because the TestClient runs in its own
    asyncio event loop and `:memory:` databases are per-connection. The
    ConnectionManager is created by the production lifespan inside that
    same loop, avoiding cross-loop Redis issues.
    """
    import dcc_chat_gateway.routes.ws_op_send as routes_ws_op_send
    import dcc_chat_gateway.routes.ws_ops as routes_ws_ops
    import dcc_chat_gateway.routes.ws_ops_handlers as routes_ws_ops_handlers
    import dcc_chat_gateway.routes.ws_ready as routes_ws_ready
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    db_url = f"sqlite+aiosqlite:///{tmp_path / 'ws_test.db'}"
    _TEST_SETTINGS.database_url = db_url

    bootstrap_engine = create_async_engine(db_url, future=True)
    async with bootstrap_engine.begin() as conn:
        for table in Base.metadata.tables.values():
            table.schema = None
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql(
            "INSERT INTO chat_settings (id, allow_guild_creation) VALUES (1, true)"
        )
    await bootstrap_engine.dispose()

    runtime_engine = create_async_engine(db_url, future=True)
    runtime_factory = async_sessionmaker(runtime_engine, expire_on_commit=False)

    # See `app` fixture above — Schritt 2 split SessionLocal across multiple
    # ws_ops modules; all need the test-time factory patched in (ws_ops still
    # re-exports it for push.py + app.py).
    original_factory_ops = routes_ws_ops.SessionLocal
    original_factory_handlers = routes_ws_ops_handlers.SessionLocal
    original_factory_send = routes_ws_op_send.SessionLocal
    original_factory_ready = routes_ws_ready.SessionLocal
    routes_ws_ops.SessionLocal = runtime_factory
    routes_ws_ops_handlers.SessionLocal = runtime_factory
    routes_ws_op_send.SessionLocal = runtime_factory
    routes_ws_ready.SessionLocal = runtime_factory

    application = create_app(skip_redis=False)

    async def _override_get_session() -> AsyncIterator:
        async with runtime_factory() as session:
            yield session

    application.dependency_overrides[get_session] = _override_get_session
    try:
        yield application
    finally:
        application.dependency_overrides.clear()
        routes_ws_ops.SessionLocal = original_factory_ops
        routes_ws_ops_handlers.SessionLocal = original_factory_handlers
        routes_ws_op_send.SessionLocal = original_factory_send
        routes_ws_ready.SessionLocal = original_factory_ready
        try:
            await runtime_engine.dispose()
        except Exception:
            pass
        _TEST_SETTINGS.database_url = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture
async def access_token(_auth_signer):
    # Issue a token for a synthetic user. Tests that need a specific user id
    # can ask the fixture for it.
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


@pytest_asyncio.fixture
async def admin_token(_auth_signer):
    """Like ``access_token`` but the JWT carries ``admin: true``."""
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"admin{uid}", is_admin=True), uid


def make_auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def friend_pair(session_factory):
    """Factory: install a Friendship row between (uid_a, uid_b).

    Etappe-2 added a hard friend-gate to ``POST /dm-channels`` (and the
    DM send-path) — tests that just want to use a DM as a "two-user
    fan-out vehicle" wire up the friendship via this fixture, NOT via
    a full /friend-requests → /accept round-trip (which would publish
    extra WS events into the test's event stream).

    Usage:
        async def test_thing(client, _auth_signer, friend_pair):
            t_a, uid_a = await _register(...)
            t_b, uid_b = await _register(...)
            await friend_pair(uid_a, uid_b)
            # now POST /dm-channels works between them
    """
    from dcc_chat_gateway.models import Friendship

    async def _install(uid_a: int, uid_b: int) -> None:
        lo, hi = sorted((uid_a, uid_b))
        async with session_factory() as s:
            s.add(Friendship(user_a_id=lo, user_b_id=hi))
            await s.commit()

    return _install


def install_friendship_sync(db_url: str, uid_a: int, uid_b: int) -> None:
    """Synchronously install a friendship row (for ws_app tests).

    ws_app uses its own runtime engine on a temp-file SQLite; this helper
    spawns a short-lived sync engine against the same URL so test setup
    can wire up friendships without going through REST (and without
    importing the chat-gateway's async session machinery cross-loop).
    """
    from sqlalchemy import create_engine

    sync_url = db_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url, future=True)
    lo, hi = sorted((uid_a, uid_b))
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO friendships (user_a_id, user_b_id, created_at) "
                "VALUES (?, ?, CURRENT_TIMESTAMP)",
                (lo, hi),
            )
    finally:
        eng.dispose()


def receive_skipping(ws, ignore: set[str] = frozenset({"presence_update"})):
    """Receive the next JSON frame, transparently dropping ops in ``ignore``.

    Presence broadcasts cross every connected socket of every other user, so
    any test that opens a second WS while the first is still around now sees a
    ``presence_update`` frame mixed into the per-test fan-out stream. The
    payload itself is not what these tests are exercising, so just skip it.
    """
    while True:
        m = ws.receive_json()
        if m.get("op") in ignore:
            continue
        return m
