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
from dcc_auth.routes_account_security import router as account_security_router
from dcc_auth.routes_admin import router as admin_router
from dcc_auth.routes_admin_app_host import router as admin_app_host_router
from dcc_auth.routes_admin_instances import router as admin_instances_router
from dcc_auth.routes_admin_backup import router as admin_backup_router
from dcc_auth.routes_admin_smtp import router as admin_smtp_router
from dcc_auth.routes_avatar import router as avatar_router
from dcc_auth.routes_credentials import router as credentials_router
from dcc_auth.routes_crl import router as crl_router
from dcc_auth.routes_complaints import router as complaints_router
from dcc_auth.routes_app_host_applications import router as app_host_applications_router
from dcc_auth.routes_instance_applications import router as instance_applications_router
from dcc_auth.routes_instance_delete import router as instance_delete_router
from dcc_auth.routes_profile import router as profile_router
from dcc_auth.routes_suspended_instances import router as suspended_instances_router
from dcc_auth.routes_recovery import router as recovery_router
from dcc_auth.routes_search import router as search_router
from dcc_auth.routes_selfhost_bootstrap import router as selfhost_bootstrap_router
from dcc_auth.routes_selfhost_relay import router as selfhost_relay_router
from dcc_auth.routes_reachability import router as reachability_router
from dcc_auth.routes_registry_auth import router as registry_auth_router
from dcc_auth.routes_sessions import router as sessions_router
from dcc_auth.routes_totp import router as totp_router
from dcc_auth.routes_webauthn import router as webauthn_router
from dcc_auth.routes_webauthn_login import router as webauthn_login_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.rate_buckets = {}
    settings = get_settings()
    # Fail-fast: der .env.example-Platzhalter ist öffentlich bekannt — damit zu
    # starten hieße, /internal/* (Account-Purge etc.) mit einem allgemein
    # bekannten "Secret" zu schützen. Leer/None = Endpoint deaktiviert, ok.
    if settings.internal_service_secret == "__CHANGE_ME__":
        raise RuntimeError(
            "INTERNAL_SERVICE_SECRET is still the .env.example placeholder __CHANGE_ME__ — "
            "set a real secret (same value as chat-gateway) or leave it unset."
        )
    # Token-cleanup background task. Skipped under tests (the conftest sets
    # app.state.skip_cleanup = True after create_app so the per-test
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
    app.include_router(account_security_router)
    app.include_router(avatar_router)
    app.include_router(admin_router)
    app.include_router(admin_app_host_router)
    app.include_router(admin_instances_router)
    app.include_router(admin_smtp_router)
    app.include_router(admin_backup_router)
    app.include_router(recovery_router)
    app.include_router(search_router)
    app.include_router(sessions_router)
    app.include_router(totp_router)
    app.include_router(webauthn_router)
    app.include_router(webauthn_login_router)
    app.include_router(credentials_router)
    app.include_router(crl_router)
    app.include_router(complaints_router)
    app.include_router(suspended_instances_router)
    app.include_router(profile_router)
    app.include_router(app_host_applications_router)
    app.include_router(instance_applications_router)
    app.include_router(instance_delete_router)
    app.include_router(selfhost_bootstrap_router)
    app.include_router(selfhost_relay_router)
    app.include_router(reachability_router)
    app.include_router(registry_auth_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
