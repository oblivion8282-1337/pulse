"""Direktpfad-Telefonbuch (Plan ``2026-07-09-direct-path-webrtc``, Phase 1).

Zwei Endpoints:

* ``POST /selfhost/directory/heartbeat`` — die Server-App meldet ihre
  STUN-ermittelte öffentliche Adresse + den DTLS-Fingerprint ihres
  direct-adapters. Auth wie ``relay_auth``: (instance_id, Relay-Tunnel-Token)
  gegen den gespeicherten Hash — das Token besitzt nur der laufende Container,
  und der Vergleich ist billig (kein Argon2 im Heartbeat-Takt).
* ``GET /me/instances/{id}/direct-endpoint`` — Clients holen den Eintrag zum
  Verbindungsaufbau. Session- UND membership-gated (die Heim-IP des Hosters
  ist sensibel; 404 statt 403 gegen Existence-Leak, Muster Bootstrap-Mint).

Kein Inhalt läuft hier durch — nur Erreichbarkeitsdaten (wenige Bytes).
"""

from __future__ import annotations

import hmac
import ipaddress
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import (
    InstanceDirectEndpoint,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.relay import hash_relay_token
from dcc_auth.routes import _check_rate
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_instance_applications import _require_user

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


class DirectCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ip: Annotated[str, Field(min_length=1, max_length=45)]
    port: Annotated[int, Field(ge=1, le=65535)]
    protocol: Literal["udp"] = "udp"


class HeartbeatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instance_id: Annotated[str, Field(min_length=1, max_length=32)]
    token: Annotated[str, Field(min_length=1, max_length=128)]
    candidates: Annotated[list[DirectCandidate], Field(min_length=1, max_length=8)]
    # Format wie die SDP-Fingerprint-Zeile, z.B. "sha-256 AB:CD:…".
    fingerprint: Annotated[str, Field(min_length=8, max_length=128)]


class DirectEndpointOut(BaseModel):
    candidates: list[DirectCandidate]
    fingerprint: str
    updated_at: datetime
    online: bool


def _public_ip_or_400(raw: str) -> str:
    """Nur globale Adressen ins Telefonbuch — private/Loopback-Angaben sind
    entweder Fehlkonfiguration oder ein Versuch, Clients ins LAN zu lenken."""
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid candidate ip")
    if not ip.is_global:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="candidate ip not public")
    return raw


async def _authed_instance(
    db: SessionDep, instance_id: str, token: str
) -> RegisteredInstance:
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    inst = await db.get(RegisteredInstance, iid)
    if (
        inst is None
        or inst.status != "active"
        or inst.relay_tunnel_token_hash is None
        or not hmac.compare_digest(hash_relay_token(token), inst.relay_tunnel_token_hash)
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    return inst


@router.post("/selfhost/directory/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def directory_heartbeat(
    body: HeartbeatIn, request: Request, db: SessionDep
) -> Response:
    """Upsert des Telefonbuch-Eintrags der Instanz (ein Eintrag, überschreibend)."""
    settings = get_settings()
    await _check_rate(request, "directory_heartbeat", settings.rate_limit_directory_heartbeat)
    inst = await _authed_instance(db, body.instance_id, body.token)
    for cand in body.candidates:
        _public_ip_or_400(cand.ip)

    # Delete+Insert statt Dialekt-Upsert — läuft identisch auf Postgres + SQLite.
    await db.execute(
        delete(InstanceDirectEndpoint).where(
            InstanceDirectEndpoint.instance_id == inst.id
        )
    )
    db.add(
        InstanceDirectEndpoint(
            instance_id=inst.id,
            candidates=[c.model_dump() for c in body.candidates],
            fingerprint=body.fingerprint,
            updated_at=datetime.now(UTC),
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/me/instances/{instance_id}/direct-endpoint", response_model=DirectEndpointOut
)
async def get_direct_endpoint(
    instance_id: str, request: Request, db: SessionDep
) -> DirectEndpointOut:
    """Telefonbuch-Lookup für Mitglieder der Instanz (404 sonst — kein Leak)."""
    settings = get_settings()
    await _check_rate(request, "directory_lookup", settings.rate_limit_directory_lookup)
    user = await _require_user(request, db)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    membership = await db.get(UserInstanceMembership, (user.id, iid))
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    row = await db.get(InstanceDirectEndpoint, iid)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    updated_at = row.updated_at
    if updated_at.tzinfo is None:  # SQLite (Tests) liefert naive UTC-Zeiten
        updated_at = updated_at.replace(tzinfo=UTC)
    age = (datetime.now(UTC) - updated_at).total_seconds()
    return DirectEndpointOut(
        candidates=[DirectCandidate(**c) for c in row.candidates],
        fingerprint=row.fingerprint,
        updated_at=updated_at,
        online=age < settings.directory_online_threshold_seconds,
    )
