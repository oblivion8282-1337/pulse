"""FastAPI factory for the chat-gateway."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_chat_gateway import s3
from dcc_chat_gateway.cleanup import cleanup_loop as push_cleanup_loop
from dcc_chat_gateway.presence_status import idle_sweeper_loop
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import engine
from dcc_chat_gateway.plugins import load_all as load_plugins
from dcc_chat_gateway.pubsub import ConnectionManager
from dcc_chat_gateway.push import ensure_vapid
from dcc_chat_gateway.routes import router
from dcc_chat_gateway.routes.attachments import reaper_loop as attachments_reaper

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
    # Resolve / auto-generate the Web-Push VAPID keypair. Logs the
    # *public* half (the browser needs it; not secret) on first call;
    # NEVER logs the private PEM. ``ensure_vapid`` is idempotent so
    # tests + repeated startups are safe.
    vapid = ensure_vapid(settings)
    if vapid is not None:
        log.info("web-push VAPID public key: %s", vapid.public_b64url)
    else:
        log.warning("web-push disabled: VAPID key unavailable")
    redis: Redis | None = None
    manager: ConnectionManager | None = None
    supervisor: asyncio.Task | None = None
    reaper: asyncio.Task | None = None
    push_cleanup: asyncio.Task | None = None
    idle_sweeper: asyncio.Task | None = None
    owns_manager = False
    if getattr(app.state, "skip_redis", False):
        # Tests pre-wire connection_manager onto the app — leave it alone.
        pass
    else:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        manager = ConnectionManager(redis)
        # Wire the permission filter's DB access through ``routes.ws_ops`` —
        # tests rebind ``routes.ws_ops.SessionLocal`` to a file-backed DB
        # (that module owns the WS op-loop's DB access since Phase B), and
        # this indirection lets the manager pick up the same factory the
        # WS endpoint already uses. Late import dodges the routes ↔ pubsub
        # circular dependency at module load.
        from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops
        manager.set_session_factory(lambda: _routes_ws_ops.SessionLocal())
        await manager.start()
        app.state.redis = redis
        app.state.connection_manager = manager
        owns_manager = True
        supervisor = asyncio.create_task(_supervise_pubsub(manager), name="dcc-pubsub-supervisor")
        # Orphan-attachment reaper — sweeps pending uploads >1 h old.
        reaper = asyncio.create_task(attachments_reaper(), name="dcc-attachments-reaper")
        # Web-Push subscription cleanup — drops subs idle >N days.
        push_cleanup = asyncio.create_task(
            push_cleanup_loop(settings, engine), name="dcc-push-subscription-cleanup"
        )
        # Presence idle sweeper — demotes ``online`` users with stale
        # activity to ``idle`` (Etappe 3).
        idle_sweeper = asyncio.create_task(
            idle_sweeper_loop(redis), name="dcc-presence-idle-sweeper"
        )
        # Plugin-System Schritt 4 + 5: discover + activate plugins in the
        # configured plugin directory. Behaviour-neutral when no plugin
        # is present (empty repo `plugins/` ⇒ no-op). Errors per-plugin
        # (incl. PluginPermissionError from the Schritt-5 gate) are logged
        # and the rest of startup proceeds. Mode is read from
        # ``$PULSE_PLUGIN_PERMISSIONS`` — see
        # ``dcc_chat_gateway.plugins.permissions`` for the contract.
        try:
            load_plugins()
        except Exception:  # noqa: BLE001
            log.exception("plugin loader failed; continuing without plugins")
    try:
        yield
    finally:
        if owns_manager:
            for task in (supervisor, reaper, push_cleanup, idle_sweeper):
                if task is not None:
                    task.cancel()
                    try:
                        await task
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001
                        pass
            if manager is not None:
                await manager.stop()
            if redis is not None:
                try:
                    await redis.aclose()
                except Exception:  # noqa: BLE001
                    pass
        # Close the lazily-initialised S3 clients regardless of which branch
        # we took above — they may have been created from a non-Redis test
        # path too.
        await s3.shutdown_clients()


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
