"""FastAPI factory for the chat-gateway."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.pubsub import ConnectionManager
from dcc_chat_gateway.routes import router

log = logging.getLogger(__name__)

# Backoff used by the pubsub supervisor between restart attempts.
_SUPERVISOR_BACKOFF = [1.0, 2.0, 5.0, 10.0, 30.0]
_SUPERVISOR_POLL_SECONDS = 5.0


async def _supervise_pubsub(manager: ConnectionManager) -> None:
    """Restart the ConnectionManager's listener if it dies.

    `ConnectionManager._listen` resets `_started` on a fatal error but cannot
    re-spawn itself; without this watchdog the gateway would silently stop
    fanning out messages until the next request happened to call `start()`.
    """
    attempt = 0
    while True:
        await asyncio.sleep(_SUPERVISOR_POLL_SECONDS)
        if manager.listener_alive():
            attempt = 0
            continue
        wait = _SUPERVISOR_BACKOFF[min(attempt, len(_SUPERVISOR_BACKOFF) - 1)]
        attempt += 1
        log.warning("pubsub listener not alive; restarting in %.0fs (attempt %d)", wait, attempt)
        await asyncio.sleep(wait)
        try:
            await manager.start()
        except Exception:  # noqa: BLE001
            log.exception("pubsub restart failed; will retry")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    redis: Redis | None = None
    manager: ConnectionManager | None = None
    supervisor: asyncio.Task | None = None
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
        supervisor = asyncio.create_task(_supervise_pubsub(manager), name="dcc-pubsub-supervisor")
    try:
        yield
    finally:
        if owns_manager:
            if supervisor is not None:
                supervisor.cancel()
                try:
                    await supervisor
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
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
