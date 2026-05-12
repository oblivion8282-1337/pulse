"""FastAPI application factory for media-svc."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_media_svc.config import get_settings
from dcc_media_svc.poller import run_poller
from dcc_media_svc.routes import router

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    redis: Redis | None = None
    poller_task: asyncio.Task | None = None
    stop_event: asyncio.Event | None = None
    if getattr(app.state, "skip_redis", False):
        # Tests pre-wire `app.state.redis` themselves and run the poller manually.
        pass
    else:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        app.state.redis = redis
        if not getattr(app.state, "skip_poller", False):
            stop_event = asyncio.Event()
            poller_task = asyncio.create_task(
                run_poller(redis, stop_event=stop_event), name="media-svc-poller"
            )
            app.state.poller_task = poller_task
    try:
        yield
    finally:
        if stop_event is not None:
            stop_event.set()
        if poller_task is not None:
            try:
                await asyncio.wait_for(poller_task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                poller_task.cancel()
        if redis is not None:
            try:
                await redis.aclose()
            except Exception:  # noqa: BLE001
                pass


def create_app(*, skip_redis: bool = False, skip_poller: bool = False) -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="dcc-media-svc", version="0.1.0", lifespan=lifespan)
    app.state.skip_redis = skip_redis
    app.state.skip_poller = skip_poller
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
