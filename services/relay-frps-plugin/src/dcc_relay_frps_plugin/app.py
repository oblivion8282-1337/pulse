"""FastAPI app factory for the frps relay auth plugin."""
from __future__ import annotations
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import httpx
import structlog
from fastapi import FastAPI

from dcc_relay_frps_plugin.config import get_settings
from dcc_relay_frps_plugin.routes import router

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    own = False
    if getattr(app.state, "http", None) is None:
        app.state.http = httpx.AsyncClient(timeout=get_settings().auth_timeout_seconds)
        own = True
    # Security-Audit 2026-09-16: Relay-Tokens und das Internal-Secret gehen im
    # Klartext auf die Leitung, sobald AUTH_SVC_URL auf einen anderen Host
    # zeigt. Loopback und der Docker-Dienstname im prod-Compose (punktloser
    #Hostname = Compose-eigenes Netz) sind okay, alles andere ueber http://
    # wird laut bemängelt statt still hingenommen.
    auth_url = urlparse(get_settings().auth_svc_url)
    host = (auth_url.hostname or "").lower()
    verlaesst_die_maschine = "." in host or host.count(":") >= 1  # FQDN/IP(v6)
    if (
        auth_url.scheme == "http"
        and host not in ("127.0.0.1", "::1", "localhost")
        and verlaesst_die_maschine
    ):
        log.warning(
            "relay_auth_svc_unencrypted",
            auth_svc_url=get_settings().auth_svc_url,
            hint="AUTH_SVC_URL nutzt http:// zu einem Nicht-Loopback-Host — "
                 "Relay-Tokens reisen unverschluesselt",
        )
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
