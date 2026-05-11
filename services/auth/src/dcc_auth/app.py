"""FastAPI application factory for the auth service."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from dcc_auth.config import get_settings
from dcc_auth.routes import router
from dcc_auth.routes_avatar import router as avatar_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.rate_buckets = {}
    yield


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
    app.include_router(avatar_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
