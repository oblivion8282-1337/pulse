"""Test fixtures for voice-signaling."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SECRETS = ROOT / "secrets"
os.environ.setdefault("CORS_ALLOW_ORIGINS", "http://test")

import dcc_voice_signaling.config as voice_cfg  # noqa: E402
import dcc_voice_signaling.security as voice_security  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from dcc_auth.config import Settings as AuthSettings  # noqa: E402
from dcc_auth.security import JwtSigner, reset_signer  # noqa: E402
from dcc_voice_signaling.app import create_app  # noqa: E402

_TEST_SETTINGS = voice_cfg.Settings(
    livekit_api_key="testkey",
    livekit_api_secret="testsecrettestsecrettestsecrettestsecret",
    livekit_url="ws://livekit.test:7880",
)


@pytest.fixture(autouse=True)
def _isolate_voice_settings():
    voice_cfg.get_settings.cache_clear()

    def _provider() -> voice_cfg.Settings:
        return _TEST_SETTINGS

    original = voice_cfg.get_settings
    voice_cfg.get_settings = _provider  # type: ignore[assignment]
    voice_security.get_settings = _provider  # type: ignore[assignment]
    import dcc_voice_signaling.routes as voice_routes
    import dcc_voice_signaling.webhook as voice_webhook

    voice_routes.get_settings = _provider  # type: ignore[assignment]
    voice_webhook.get_settings = _provider  # type: ignore[assignment]
    voice_security.reset_cache()
    yield _TEST_SETTINGS
    voice_cfg.get_settings = original  # type: ignore[assignment]
    voice_cfg.get_settings.cache_clear()
    voice_security.reset_cache()


@pytest_asyncio.fixture
async def auth_signer(_isolate_voice_settings) -> JwtSigner:
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
    voice_security.install_static_jwks(signer.jwks())
    yield signer
    auth_cfg.get_settings = original  # type: ignore[assignment]
    reset_signer()


@pytest_asyncio.fixture
async def app(_isolate_voice_settings):
    return create_app()


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
