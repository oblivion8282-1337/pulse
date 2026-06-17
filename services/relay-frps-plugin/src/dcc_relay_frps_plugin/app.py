"""FastAPI app factory for the frps relay auth plugin."""
from __future__ import annotations
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from dcc_relay_frps_plugin.config import get_settings
from dcc_relay_frps_plugin.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    own = False
    if getattr(app.state, "http", None) is None:
        app.state.http = httpx.AsyncClient(timeout=get_settings().auth_timeout_seconds)
        own = True
    try:
        yield
    finally:
        if own:
            try:
                await app.state.http.aclose()
            except Exception:  # noqa: BLE001
                pass


def create_app(*, http_client: httpx.AsyncClient | None = None) -> FastAPI:
    app = FastAPI(title="dcc-relay-frps-plugin", version="0.1.0", lifespan=lifespan)
    app.state.http = http_client
    app.include_router(router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
