"""FastAPI application factory."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_voice_signaling.config import get_settings
from dcc_voice_signaling.routes import chat_gateway as _chat_gateway

log = structlog.get_logger(__name__)


def _livekit_api_host(settings) -> str:  # noqa: ANN001
    """Resolve the host for server-side LiveKit API calls.

    Prefers ``livekit_api_url`` (a direct internal address that bypasses the
    web layer) and falls back to the public ``livekit_url``. Normalises the
    ws(s):// scheme the AccessToken/ws_url uses to the http(s):// the twirp
    API client needs.
    """
    raw = settings.livekit_api_url or settings.livekit_url
    return raw.replace("wss://", "https://").replace("ws://", "http://")


_DEV_KEY = "devkey"
_DEV_SECRET = "devsecretdevsecretdevsecretdevsecret"
from dcc_voice_signaling.routes import router
from dcc_voice_signaling.webhook import router as webhook_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    from livekit import api as lk

    settings = get_settings()
    if settings.livekit_api_key == _DEV_KEY or settings.livekit_api_secret == _DEV_SECRET:
        log.warning("livekit_dev_credentials", msg="using LiveKit dev credentials — set LIVEKIT_API_KEY/SECRET in production")
    if settings.chat_gateway_url is None:
        log.warning(
            "chat_gateway_url_unset",
            msg=(
                "CHAT_GATEWAY_URL is not set — membership checks are DISABLED. "
                "Any authenticated user can join arbitrary voice channels. "
                "Set CHAT_GATEWAY_URL in production."
            ),
        )
    redis: Redis | None = None
    if getattr(app.state, "skip_redis", False):
        # Tests pre-wire `app.state.redis` themselves.
        pass
    else:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        app.state.redis = redis

    # Initialize HTTP client for chat-gateway calls. Reusing a single
    # client avoids connection setup/teardown overhead on every request
    # and enables connection pooling + http/2.
    await _chat_gateway._init_http_client()

    # Initialize LiveKit API client singleton, reused across all admin
    # operations (mute/unmute/disconnect). This amortizes the cost of
    # TCP+TLS handshake and JWT signing across multiple calls.
    livekit_api_client: lk.LiveKitAPI | None = None
    if settings.livekit_api_key and settings.livekit_api_secret:
        host = _livekit_api_host(settings)
        livekit_api_client = lk.LiveKitAPI(
            host, api_key=settings.livekit_api_key, api_secret=settings.livekit_api_secret
        )
        app.state.livekit_api = livekit_api_client

    # Periodic LiveKit→Redis presence reconciliation. Needs both Redis and a
    # LiveKit API client; skipped in tests (skip_redis) and when disabled.
    reconcile_task: asyncio.Task | None = None
    if (
        redis is not None
        and livekit_api_client is not None
        and settings.voice_reconcile_enabled
    ):
        from dcc_voice_signaling.reconcile import reconcile_loop

        reconcile_task = asyncio.create_task(
            reconcile_loop(
                redis,
                livekit_api_client,
                interval_seconds=settings.voice_reconcile_interval_seconds,
                ttl_seconds=settings.voice_state_ttl_seconds,
            ),
            name="dcc-voice-reconcile",
        )

    try:
        yield
    finally:
        if reconcile_task is not None:
            reconcile_task.cancel()
            try:
                await reconcile_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await _chat_gateway._close_http_client()
        if livekit_api_client is not None:
            try:
                await livekit_api_client.aclose()
            except Exception:  # noqa: BLE001
                pass
        if redis is not None:
            try:
                await redis.aclose()
            except Exception:  # noqa: BLE001
                pass


def create_app(*, skip_redis: bool = False) -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="dcc-voice-signaling", version="0.1.0", lifespan=lifespan)
    app.state.skip_redis = skip_redis
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.include_router(webhook_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
