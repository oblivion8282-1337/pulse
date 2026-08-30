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

import asyncio
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

import dcc_chat_gateway.app as chat_app  # noqa: E402
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
    # `localhost` resolviert unter Windows zuerst auf IPv6 ::1 und stallt dann
    # ~2 s pro neuer Verbindung, bevor es auf IPv4 (127.0.0.1, wo Redis lauscht)
    # zurückfällt. Dieser Cold-Connect reißt den 1-s-Redis-Ping-Timeout des
    # /health-Endpoints (→ falsches „degraded") und bremst die ganze Suite.
    # Auf IPv4 pinnen — no-op auf Linux/CI, wo localhost ohnehin sofort auf
    # 127.0.0.1 auflöst.
    redis_url=os.environ.get("REDIS_URL", "redis://localhost:6380/0").replace(
        "localhost", "127.0.0.1"
    ),
    auth_jwks_url="http://stub/jwks",
    database_schema="main",
    # A valid "approved self-host" config: non-zero instance id satisfies the
    # lifespan fail-fast guard (which prevents identical pairwise-subs across
    # self-hosts) while keeping the default self-host mode the other tests rely on.
    pulse_instance_id=100,
)


@pytest.fixture(autouse=True)
def _isolate_chat_settings():
    import dcc_chat_gateway.ratelimit as chat_ratelimit

    chat_ratelimit.reset()
    chat_cfg.get_settings.cache_clear()
    # Reset instance-mode fields on the shared settings singleton: several tests
    # mutate these directly (not via monkeypatch) to exercise cloud-mode paths,
    # which would otherwise leak into later tests (e.g. mention-search's
    # cloud-only guild-member JOIN).
    _TEST_SETTINGS.pulse_instance_mode = "self-host"
    _TEST_SETTINGS.pulse_instance_id = 100
    # Cloud upload-surface flags: same leak hazard as the instance-mode fields
    # above — tests that exercise the Cloud policy mutate them directly.
    _TEST_SETTINGS.cloud_dm_attachments_enabled = False
    _TEST_SETTINGS.cloud_dropbox_enabled = False
    _TEST_SETTINGS.cloud_attachment_mime_prefixes = "image/"
    # Private Gruppen (Etappe G1): derselbe Leak-Grund wie oben — Tests, die
    # den Schalter oder die Mitgliederobergrenze fuer sich brauchen (s.
    # test_private_gruppen.py), setzen sie ueber dasselbe Settings-Objekt
    # direkt, nicht per monkeypatch.
    _TEST_SETTINGS.private_groups_enabled = False
    _TEST_SETTINGS.private_group_max_members = 50
    # Geraete-Obergrenze: derselbe Leak-Grund, aber erst seit 2026-08-30
    # sichtbar. ``test_schluessel.py`` setzt sie fuer die Verdraengungs-Tests
    # direkt auf 2 und stellt sie nicht zurueck; das fiel nie auf, solange
    # KEIN anderer Test Buendel anlegte. Seit die Kopplungs-Routen ein
    # eingetragenes Geraet verlangen (Spec §3b), veroeffentlicht
    # ``test_kopplung.py`` drei davon — und das dritte verdraengte bei
    # geleaktem Limit das erste, mitten in einem Test ueber Rollen.
    _TEST_SETTINGS.schluessel_max_buendel_je_konto = 20

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


@pytest.fixture(autouse=True)
def _no_cloud_polling(monkeypatch):
    """Keep the lifespan's cloud pollers off the network.

    Both loops poll ``settings.pulse_cloud_origin`` once immediately, and the
    test settings keep the production default (https://howispulse.com — invite
    links assert against it), so every ``TestClient(ws_app)`` would fire a real
    HTTPS request at prod. The loops' own coverage (test_crl_poller.py,
    test_cloud_policy_poller.py) calls the real functions directly, so it is
    unaffected by this stub.
    """

    async def _inert(*_args, **_kwargs) -> None:
        await asyncio.Event().wait()  # idle until the lifespan cancels us

    monkeypatch.setattr(chat_app, "cloud_policy_poller_loop", _inert)
    monkeypatch.setattr(chat_app, "jwks_poller_loop", _inert)


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
    # Import every model + route module so its ``Base`` table is
    # registered *before* ``create_all`` walks the registry. ``models``
    # ``__init__`` already re-exports them, but new tables added in
    # the same test session can land there too late if the engine
    # fixture fires first — and pytest fixture order doesn't
    # guarantee a module's top-level imports have run by the time
    # the engine is built.
    from dcc_chat_gateway import models as _models  # noqa: F401
    from dcc_chat_gateway import routes as _routes  # noqa: F401
    # :memory: SQLite needs StaticPool so every connection shares
    # the same in-memory DB — otherwise the test's direct
    # ``session_factory()`` writes go to one DB and the ServerDep
    # session inside the FastAPI route reads from a sibling DB.
    from sqlalchemy.pool import StaticPool

    eng = create_async_engine(
        _TEST_SETTINGS.effective_database_url,
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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
        # ``locked`` defaults false (the column server_default) — the instance
        # is open to the per-community access paths; cert-login tests that
        # exercise the "Server gesperrt" lock set it explicitly.
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

    # Phase 3.1 JWKS cold-start gate: seed the JWKS into the test-Redis so
    # the lifespan finds it and sets jwks_ready=True. Without this every ws_app
    # test fails with 4046 because the test-Redis index (/1) has no cached JWKS.
    import json as _json

    from redis.asyncio import Redis as _Redis
    from dcc_chat_gateway.jwks_pinning import REDIS_JWKS_KEY as _JWKS_KEY

    _seed_redis = _Redis.from_url(_TEST_SETTINGS.redis_url, decode_responses=False)
    try:
        await _seed_redis.set(_JWKS_KEY, _json.dumps(_auth_signer.jwks()))
    finally:
        await _seed_redis.aclose()

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


@pytest_asyncio.fixture
async def owner_token(_auth_signer):
    """Like ``admin_token`` but the JWT also carries ``owner: true`` — the
    single Cloud operator. Owner-gated routes only resolve the claim in cloud
    mode (chat-gateway forces owner=False on self-host), so tests using this
    must also request the ``cloud_mode`` fixture."""
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    token = _auth_signer.issue_access(
        uid, f"owner{uid}", is_admin=True, is_owner=True
    )
    return token, uid


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


@pytest_asyncio.fixture
async def second_member(session_factory):
    """Factory: install a GuildMember row for (guild_id, user_id).

    For tests that need a user that's a regular guild member — neither
    owner nor holder of MANAGE_CHANNELS — to assert that ownership-
    gated mutations refuse the second user. The schema-flattening in
    the ``engine`` fixture is what makes raw ``GuildMember(...)``
    inserts land in the test DB without a ``chat.`` prefix."""

    from datetime import datetime, timezone

    from dcc_chat_gateway.models import GuildMember

    async def _install(guild_id: int, user_id: int) -> None:
        async with session_factory() as s:
            s.add(
                GuildMember(
                    guild_id=guild_id,
                    user_id=user_id,
                    joined_at=datetime.now(timezone.utc),
                )
            )
            await s.commit()

    return _install


@pytest.fixture
def cloud_mode(_isolate_chat_settings):
    """Switch the test settings to cloud mode for the duration of one test.

    Friend-system / DM / Block routes are cloud-only (``require_cloud``
    dependency returns 404 on self-host).  Test modules that cover those
    routes must opt-in via a ``pytestmark`` or a per-test fixture request:

        pytestmark = pytest.mark.usefixtures("cloud_mode")

    The fixture depends on ``_isolate_chat_settings`` so it runs *after*
    the per-test reset (which resets to "self-host") and can safely
    override the mode for this single test.
    """
    _isolate_chat_settings.pulse_instance_mode = "cloud"
    return _isolate_chat_settings


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


def receive_skipping(ws, ignore: set[str] = frozenset({"presence_update", "hello"})):
    """Receive the next JSON frame, transparently dropping ops in ``ignore``.

    Presence broadcasts cross every connected socket of every other user, so
    any test that opens a second WS while the first is still around now sees a
    ``presence_update`` frame mixed into the per-test fan-out stream. Phase 3.3
    added a ``hello`` frame as the very first server→client message (before
    ``ready``); tests that only care about ready / chat frames can ignore it
    via the default ignore set.
    """
    while True:
        m = ws.receive_json()
        if m.get("op") in ignore:
            continue
        return m


def trenne(ws):
    """Die Trennung schicken — ohne den Abbruch, den der ``with``-Block gleich
    hinterherwirft.

    ``WebSocketTestSession.__exit__`` (starlette ``testclient.py``) tut ZWEI
    Dinge unmittelbar nacheinander: es stellt ``websocket.disconnect`` zu und
    bricht danach **sofort die Server-Task ab**. Der Abbau einer Verbindung
    läuft aber im ``finally`` GENAU DIESER Task (``routes/ws_ops.py``) und
    verschickt dort Frames an ANDERE Sockets. Trifft der Abbruch ihn vorher,
    fällt das Frame lautlos aus (``CancelledError`` ist eine ``BaseException``
    und geht an jedem ``except Exception`` vorbei), und die Gegenseite wartet
    ewig. Gemessen am 2026-08-13: rund 25 % Hänger in
    ``test_remote_disconnect_notifies_peer``.

    **Reines Artefakt des TestClients.** uvicorn bricht die Task beim Trennen
    nicht ab, es legt ``websocket.disconnect`` nur in die Warteschlange — im
    Betrieb gibt es dieses Fenster derzeit nicht (es entstünde erst mit einem
    gesetzten ``timeout_graceful_shutdown``, und das ist nirgends gesetzt).

    Zugedeckt wird damit nichts: wer die Trennung selbst schickt und die Folge
    NOCH IM Block liest, prüft dieselbe Zusage — bleibt das Frame aus, hängt
    der Test genauso wie zuvor. Während der Test im Empfangen blockiert, läuft
    die Serverschleife frei.
    """
    ws.close(1000)


def ping_barrier(ws):
    """Block until every op sent on ``ws`` so far has been processed.

    ``subscribe`` answers only on failure, so a test that subscribes and then
    publishes through another path (an HTTP POST, a second socket) races the
    server: pub/sub is fire-and-forget, and a message published before the
    subscribe handler has registered the socket is dropped — the test then
    blocks in ``receive_json`` forever. The op loop awaits each handler in turn
    (``routes/ws_ops.py``), so a ``pong`` proves every earlier op on this socket
    is done. Call this between the subscribe and whatever triggers the message.
    """
    ws.send_json({"op": "ping"})
    m = receive_skipping(ws)
    if m.get("op") != "pong":
        raise AssertionError(f"expected pong, got {m}")


def skip_init_frames(ws):
    """Consume the hello + ready frames sent on every new WS connection.

    Phase 3.3 added a ``hello`` frame before ``ready``.  Tests that want to
    jump straight into the chat interaction (and don't assert on the
    connection-establishment frames) call this helper instead of two
    successive ``ws.receive_json()`` calls.
    """
    # hello
    ws.receive_json()
    # ready (skip presence_update interleaved while another user is also online)
    while True:
        m = ws.receive_json()
        if m.get("op") == "presence_update":
            continue
        break
