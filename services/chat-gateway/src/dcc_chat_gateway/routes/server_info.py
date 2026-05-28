"""GET /.well-known/pulse-server-info — public, no auth (Phase 3.3).

Returns the server version, OIDC issuer, instance identity, and capability
list so that clients can negotiate compatibility before opening a WS
connection.

Shape::

    {
        "server_version": "0.8.0",
        "pulse_oidc_issuer": "https://howispulse.com",
        "instance_id": "<snowflake-string>|null",
        "capabilities": []
    }

``instance_id`` is null when ``PULSE_INSTANCE_MODE=cloud`` (the Cloud
instance has no separate ID; everything is identified by the issuer).
Self-hosted instances carry the Snowflake-ID they received from the Cloud
on registration (``PULSE_INSTANCE_ID`` env var, stored in settings).
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from dcc_chat_gateway import __version__
from dcc_chat_gateway.config import get_settings

router = APIRouter()


class ServerInfo(BaseModel):
    server_version: str
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
        pulse_oidc_issuer=settings.pulse_oidc_issuer,
        instance_id=instance_id,
        capabilities=[],
    )
