"""Interner Relay-Validierungs-Endpoint (②a).

Der Pulse-betriebene Relay-Dienst (Cloud) prüft hier eine Tunnel-Anmeldung:
Stimmt (Subdomain, Token) gegen den gespeicherten Hash + ist die Instanz aktiv?
Auth-Hook-Gegenstück zu ``mediamtx-auth-hook`` — so liegt nie ein Klartext-
Tunnel-Token in der DB. Cloud-only + internal-service-secret-gated.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.relay import hash_relay_token
from dcc_auth.routes_admin_instances import _require_cloud

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


class RelayAuthIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subdomain: Annotated[str, Field(min_length=1, max_length=255)]
    token: Annotated[str, Field(min_length=1, max_length=128)]


class RelayAuthOut(BaseModel):
    instance_id: str
    subdomain: str


def _check_internal_secret(provided: str | None) -> None:
    """Fail-closed wenn das server-seitige Secret nicht gesetzt ist
    (Muster: routes_search.py::_check_internal_secret)."""
    expected = get_settings().internal_service_secret
    if not expected:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret")


@router.post("/selfhost/relay/auth", response_model=RelayAuthOut)
async def relay_auth(
    body: RelayAuthIn,
    db: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> RelayAuthOut:
    """Validiert eine Tunnel-Anmeldung des Relay-Dienstes."""
    _check_internal_secret(x_pulse_internal_secret)

    inst = (
        await db.execute(
            select(RegisteredInstance).where(
                RegisteredInstance.relay_subdomain == body.subdomain
            )
        )
    ).scalar_one_or_none()

    if inst is None or inst.relay_tunnel_token_hash is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unknown relay subdomain")
    if not hmac.compare_digest(hash_relay_token(body.token), inst.relay_tunnel_token_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid relay token")
    if inst.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance is not available")

    return RelayAuthOut(instance_id=str(inst.id), subdomain=body.subdomain)
