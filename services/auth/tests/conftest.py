"""Test fixtures for the auth service.

Uses aiosqlite for fast isolated tests. Schema mapping is dropped (we treat
"auth" as the default schema by stripping it on SQLite). This keeps tests
hermetic — production migrations still target Postgres.
"""

from __future__ import annotations

import os
import datetime as _dt
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

# Ensure the auth service uses the test keys *before* importing the app.
ROOT = Path(__file__).resolve().parents[3]
SECRETS = ROOT / "secrets"
os.environ.setdefault("JWT_PRIVATE_KEY_FILE", str(SECRETS / "jwt_private.pem"))
os.environ.setdefault("JWT_PUBLIC_KEY_FILE", str(SECRETS / "jwt_public.pem"))
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("CORS_ALLOW_ORIGINS", "http://test")
# Tests model the Cloud by default (matches prod howispulse.com), so the
# cloud-only Self-Host-instance admin routes are reachable. test_admin_instances
# flips this to "self-host" to assert the 403 gate.
os.environ.setdefault("PULSE_INSTANCE_MODE", "cloud")

import httpx  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from dcc_auth import models as _models  # noqa: F401,E402 - register metadata
from dcc_auth.app import create_app  # noqa: E402
from dcc_auth.config import Settings, get_settings  # noqa: E402
from dcc_auth.db import Base, get_session  # noqa: E402
from dcc_auth.routes import _invalidate_smtp_cache, _reset_rate  # noqa: E402
from dcc_auth.security import reset_signer  # noqa: E402


@pytest.fixture(scope="session")
def _registry_cert():
    """Self-signed x509-Cert (PEM) aus dem Test-JWT-Keypair — damit der
    JwtSigner Registry-Tokens mit ``x5c``-Header minten kann (prod provisioniert
    ops dasselbe Cert neben den Keys). Session-scoped: einmal erzeugt."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.x509.oid import NameOID

    priv = serialization.load_pem_private_key(
        (SECRETS / "jwt_private.pem").read_bytes(), password=None
    )
    now = _dt.datetime.now(_dt.timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pulse-registry-test")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(priv.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + _dt.timedelta(days=3650))
        .sign(priv, hashes.SHA256())
    )
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".crt")
    os.close(fd)
    Path(path).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return Path(path)


@pytest.fixture(autouse=True)
def _isolate_settings(_registry_cert):
    get_settings.cache_clear()
    reset_signer()
    # The SMTP-config cache is a module-level global with a 60s TTL; flush it
    # between tests so a config written directly to the DB in one test (the
    # admin route, which normally invalidates, is bypassed) does not leak a
    # stale value into the next.
    _invalidate_smtp_cache()
    # Der CRL-Endpunkt fuellt ein leeres Redis-ZSET hoechstens einmal je Minute
    # aus der Datenbank nach. Der Merker ist prozessweit — ohne Reset erbte ein
    # Test die Sperre des vorigen und saehe eine leere Sperrliste.
    import dcc_auth.routes_crl as _crl

    _crl._last_reseed = None
    # Force the test DB and small ttl so refresh-expired path is testable.
    s = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        jwt_private_key_file=SECRETS / "jwt_private.pem",
        jwt_public_key_file=SECRETS / "jwt_public.pem",
        jwt_cert_file=_registry_cert,
        database_schema="main",  # sqlite default schema
    )

    def _provider() -> Settings:
        return s

    get_settings.cache_clear()
    import dcc_auth.config as cfg

    original = cfg.get_settings
    cfg.get_settings = _provider  # type: ignore[assignment]
    # Patch already-imported references in other modules.
    import dcc_auth.security as security
    import dcc_auth.snowflake as snowflake_mod
    security.get_settings = _provider  # type: ignore[assignment]
    snowflake_mod.get_settings = _provider  # type: ignore[assignment]
    snowflake_mod._gen = None
    reset_signer()

    yield s

    cfg.get_settings = original  # type: ignore[assignment]
    get_settings.cache_clear()
    reset_signer()


@pytest_asyncio.fixture
async def engine(_isolate_settings):
    eng = create_async_engine(_isolate_settings.effective_database_url, future=True)
    async with eng.begin() as conn:
        # Strip schema for sqlite: copy tables into the default schema.
        # Easiest path is to mutate metadata in place.
        for table in Base.metadata.tables.values():
            table.schema = None
        await conn.run_sync(Base.metadata.create_all)
        # Seed singletons (the prod migration does this; create_all doesn't).
        await conn.exec_driver_sql("INSERT INTO auth_settings (id) VALUES (1)")
        await conn.exec_driver_sql("INSERT INTO smtp_settings (id) VALUES (1)")
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def session_factory(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest_asyncio.fixture
async def app(session_factory):
    application = create_app()
    application.state.rate_buckets = {}

    async def _override_get_session() -> AsyncIterator:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = _override_get_session
    yield application
    application.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    _reset_rate(app)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
