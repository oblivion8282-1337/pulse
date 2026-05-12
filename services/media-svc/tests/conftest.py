"""Test fixtures for media-svc.

  - Uses the auth-svc's JwtSigner (same RSA keypair in secrets/) to mint Pulse
    access tokens, injects its public JWKS via `install_static_jwks`.
  - Real Redis at REDIS_URL but on index ``/1`` for test isolation; each test
    uses a unique channel-id space.
  - The MediaMTX presence poller is *not* started by the app fixture
    (`skip_poller=True`); tests drive `reconcile_once` directly with a mocked
    httpx response. No real MediaMTX needed.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import pytest
import pytest_asyncio
from redis.asyncio import Redis

ROOT = Path(__file__).resolve().parents[3]
SECRETS = ROOT / "secrets"
os.environ.setdefault("CORS_ALLOW_ORIGINS", "http://test")


def _test_redis_url() -> str:
    base = os.environ.get("REDIS_URL", "redis://localhost:6380/0")
    parts = urlsplit(base)
    return urlunsplit((parts.scheme, parts.netloc, "/1", parts.query, parts.fragment))


import dcc_media_svc.config as media_cfg  # noqa: E402
import dcc_media_svc.security as media_security  # noqa: E402
from dcc_auth.config import Settings as AuthSettings  # noqa: E402
from dcc_auth.security import JwtSigner, reset_signer  # noqa: E402
from dcc_media_svc.app import create_app  # noqa: E402

_TEST_SETTINGS = media_cfg.Settings(
    redis_url=_test_redis_url(),
    auth_jwks_url="http://stub/jwks",
    mediamtx_api_url="http://mediamtx.test:9997/v3/paths/list",
    mediamtx_ingest_host="ingest.test",
    mediamtx_public_base="http://stream.test:8889",
)


@pytest.fixture(autouse=True)
def _isolate_settings():
    media_cfg.get_settings.cache_clear()

    def _provider() -> media_cfg.Settings:
        return _TEST_SETTINGS

    original = media_cfg.get_settings
    media_cfg.get_settings = _provider  # type: ignore[assignment]
    media_security.get_settings = _provider  # type: ignore[assignment]
    import dcc_media_svc.poller as media_poller
    import dcc_media_svc.routes as media_routes

    media_routes.get_settings = _provider  # type: ignore[assignment]
    media_poller.get_settings = _provider  # type: ignore[assignment]
    media_security.reset_cache()
    yield _TEST_SETTINGS
    media_cfg.get_settings = original  # type: ignore[assignment]
    media_cfg.get_settings.cache_clear()
    media_security.reset_cache()


@pytest_asyncio.fixture
async def auth_signer(_isolate_settings) -> AsyncIterator[JwtSigner]:
    auth_settings = AuthSettings(
        jwt_private_key_file=SECRETS / "jwt_private.pem",
        jwt_public_key_file=SECRETS / "jwt_public.pem",
        jwt_audience="dcc",
        jwt_issuer="dcc-auth",
    )
    import dcc_auth.config as auth_cfg
    import dcc_auth.security as sec

    original = auth_cfg.get_settings

    def _provider() -> AuthSettings:
        return auth_settings

    auth_cfg.get_settings = _provider  # type: ignore[assignment]
    sec.get_settings = _provider  # type: ignore[assignment]
    reset_signer()
    signer = JwtSigner()
    media_security.install_static_jwks(signer.jwks())
    yield signer
    auth_cfg.get_settings = original  # type: ignore[assignment]
    reset_signer()


@pytest_asyncio.fixture
async def redis() -> AsyncIterator[Redis]:
    r = Redis.from_url(_TEST_SETTINGS.redis_url, decode_responses=False)
    yield r
    await r.aclose()


@pytest_asyncio.fixture
async def app(_isolate_settings, redis):
    application = create_app(skip_redis=True, skip_poller=True)
    application.state.redis = redis
    return application


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
