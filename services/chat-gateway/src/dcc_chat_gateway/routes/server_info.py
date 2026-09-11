"""GET /.well-known/pulse-server-info — public, no auth (Phase 3.3).

Returns the server version, OIDC issuer, instance identity, and capability
list so that clients can negotiate compatibility before opening a WS
connection.

Shape::

    {
        "server_version": "0.8.0",
        "build_version": "48c405a",
        "pulse_oidc_issuer": "https://howispulse.com",
        "instance_id": "<snowflake-string>|null",
        "capabilities": ["token_refresh", "server-ticket"]
    }

``instance_id`` is null when ``PULSE_INSTANCE_MODE=cloud`` (the Cloud
instance has no separate ID; everything is identified by the issuer).
Self-hosted instances carry the Snowflake-ID they received from the Cloud
on registration (``PULSE_INSTANCE_ID`` env var, stored in settings).

``build_version`` ist der Baustempel des Laufs (2026-09-11): der kurze
Commit-SHA, den die CI beim Bauen ins Image schreibt — derselbe Stempel auf
Cloud und Self-Host bedeutet byte-identischen Stand. Ohne CI-Bau: ``dev``.
``server_version`` bleibt die handgesetzte KOMPATIBILITAETS-Nummer und
sagt nichts ueber den Stand (s. ``dcc_chat_gateway.build_version``).
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from dcc_chat_gateway import __version__, build_version
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.faehigkeiten import SERVER_FAEHIGKEITEN

router = APIRouter()


class ServerInfo(BaseModel):
    server_version: str
    build_version: str = "dev"
    pulse_oidc_issuer: str
    instance_id: str | None
    capabilities: list[str]


@router.get("/.well-known/pulse-server-info", response_model=ServerInfo)
async def server_info() -> ServerInfo:
    """Return public server metadata for client compatibility checks."""
    settings = get_settings()

    if settings.pulse_instance_mode == "cloud":
        instance_id = None
    else:
        raw_id = settings.pulse_instance_id
        instance_id = str(raw_id) if raw_id else None

    return ServerInfo(
        server_version=__version__,
        build_version=build_version(),
        pulse_oidc_issuer=settings.pulse_oidc_issuer,
        instance_id=instance_id,
        capabilities=list(SERVER_FAEHIGKEITEN),
    )
