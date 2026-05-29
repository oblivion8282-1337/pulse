"""FastAPI application factory."""

from __future__ import annotations

from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_voice_signaling.config import get_settings

log = structlog.get_logger(__name__)

_DEV_KEY = "devkey"
_DEV_SECRET = "devsecretdevsecretdevsecretdevsecret"
from dcc_voice_signaling.routes import router
from dcc_voice_signaling.webhook import router as webhook_router


@asynccontextmanager
async def lifespan(app: FastAPI):
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
    try:
        yield
    finally:
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
