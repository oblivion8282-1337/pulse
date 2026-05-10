"""FastAPI factory for the chat-gateway."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.pubsub import ConnectionManager
from dcc_chat_gateway.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    redis: Redis | None = None
    manager: ConnectionManager | None = None
    owns_manager = False
    if getattr(app.state, "skip_redis", False):
        # Tests pre-wire connection_manager onto the app — leave it alone.
        pass
    else:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        manager = ConnectionManager(redis)
        await manager.start()
        app.state.redis = redis
        app.state.connection_manager = manager
        owns_manager = True
    try:
        yield
    finally:
        if owns_manager:
            if manager is not None:
                await manager.stop()
            if redis is not None:
                try:
                    await redis.aclose()
                except Exception:  # noqa: BLE001
                    pass


def create_app(*, skip_redis: bool = False) -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="dcc-chat-gateway", version="0.1.0", lifespan=lifespan)
    app.state.skip_redis = skip_redis
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
