"""FastAPI application factory for the auth service."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from dcc_auth.cleanup import cleanup_loop
from dcc_auth.config import get_settings
from dcc_auth.db import engine
from dcc_auth.routes import router
from dcc_auth.routes_account import router as account_router
from dcc_auth.routes_admin import router as admin_router
from dcc_auth.routes_admin_backup import router as admin_backup_router
from dcc_auth.routes_admin_smtp import router as admin_smtp_router
from dcc_auth.routes_avatar import router as avatar_router
from dcc_auth.routes_recovery import router as recovery_router
from dcc_auth.routes_search import router as search_router
from dcc_auth.routes_sessions import router as sessions_router
from dcc_auth.routes_totp import router as totp_router
from dcc_auth.routes_webauthn import router as webauthn_router
from dcc_auth.routes_webauthn_login import router as webauthn_login_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.rate_buckets = {}
    settings = get_settings()
    # Token-cleanup background task. Skipped under tests (the conftest sets
    # ``app.state.skip_cleanup = True`` after create_app so the per-test
    # in-memory SQLite engine isn't held open by a stray task).
    cleanup_task: asyncio.Task | None = None
    if not getattr(app.state, "skip_cleanup", False):
        cleanup_task = asyncio.create_task(
            cleanup_loop(settings, engine), name="dcc-auth-token-cleanup"
        )
    try:
        yield
    finally:
        if cleanup_task is not None:
            cleanup_task.cancel()
            try:
                await cleanup_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="dcc-auth", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.include_router(account_router)
    app.include_router(avatar_router)
    app.include_router(admin_router)
    app.include_router(admin_smtp_router)
    app.include_router(admin_backup_router)
    app.include_router(recovery_router)
    app.include_router(search_router)
    app.include_router(sessions_router)
    app.include_router(totp_router)
    app.include_router(webauthn_router)
    app.include_router(webauthn_login_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
