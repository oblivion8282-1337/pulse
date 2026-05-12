"""FastAPI application factory for the MediaMTX auth hook."""

from __future__ import annotations

from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from redis.asyncio import Redis

from dcc_mediamtx_auth_hook.config import get_settings
from dcc_mediamtx_auth_hook.routes import router

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
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
    app = FastAPI(title="dcc-mediamtx-auth-hook", version="0.1.0", lifespan=lifespan)
    app.state.skip_redis = skip_redis
    app.include_router(router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
