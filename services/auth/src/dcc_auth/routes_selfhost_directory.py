"""Direktpfad-Telefonbuch (Plan ``2026-07-09-direct-path-webrtc``, Phase 1).

Zwei Endpoints:

* ``POST /selfhost/directory/heartbeat`` — die Server-App meldet ihre
  STUN-ermittelte öffentliche Adresse + den DTLS-Fingerprint ihres
  direct-adapters. Auth wie ``relay_auth``: (instance_id, relay-Tunnel-Token)
  gegen den gespeicherten Hash — das Token besitzt nur der laufende Container,
  und der Vergleich ist billig (kein Argon2 im Heartbeat-Takt).
* ``POST /selfhost/directory/offline`` — der saubere Abschied: die Server-App
  meldet beim Runterfahren, dass sie weggeht. Löscht den Eintrag sofort, statt
  ihn bis zur Online-Schwelle (300 s) veralten zu lassen — in diesem Fenster
  würde sonst jeder Client-Dial auf einen toten UDP-Port die vollen
  ICE-Timeouts verbrennen (App-Hosting, 2026-10-03).
* ``GET /me/instances/{id}/direct-endpoint`` — Clients holen den Eintrag zum
  Verbindungsaufbau. Session- UND membership-gated (die Heim-IP des Hosters
  ist sensibel; 404 statt 403 gegen Existence-Leak, Muster Bootstrap-Mint).

Kein Inhalt läuft hier durch — nur Erreichbarkeitsdaten (wenige Bytes).
"""

from __future__ import annotations

import asyncio

import hmac
import ipaddress
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete

from dcc_shared.snowflake import kennung_aus_text

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.instance_status import melde, setze_online
from dcc_auth.models_instances import (
    InstanceDirectEndpoint,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.relay import hash_relay_token
from dcc_auth.security import verify_password
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
    # Heim-Server ohne Relay (Entscheid 2026-09-27): der Adapter hat kein
    # Tunnel-Token und weist sich stattdessen mit den Pairing-Creds aus
    # (client_id + client_secret als ``token``). ``client_id`` muss dann
    # mitkommen, damit die Cloud das Secret gezielt gegen DIESE Instanz
    # prüfen kann (ohne Would-be-Scanning über alle Instanzen).
    client_id: Annotated[str, Field(max_length=128)] | None = None
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
    db: SessionDep,
    instance_id: str,
    token: str,
    client_id: str | None = None,
) -> RegisteredInstance:
    iid = kennung_aus_text(instance_id)
    if iid is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.status != "active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    # Weg A (Relay-Instanzen): Tunnel-Token. Weg B (Heim-Server ohne Relay,
    # 2026-09-27): Pairing-Creds — client_id benennt die Instanz, ``token``
    # trägt das client_secret (argon2-Verify, asynchron).
    if (
        inst.relay_tunnel_token_hash is not None
        and hmac.compare_digest(hash_relay_token(token), inst.relay_tunnel_token_hash)
    ):
        return inst
    if client_id is not None and client_id == inst.client_id:
        if await asyncio.to_thread(verify_password, token, inst.client_secret):
            return inst
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")


@router.post("/selfhost/directory/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def directory_heartbeat(
    body: HeartbeatIn, request: Request, db: SessionDep
) -> Response:
    """Upsert des Telefonbuch-Eintrags der Instanz (ein Eintrag, überschreibend)."""
    settings = get_settings()
    await _check_rate(request, "directory_heartbeat", settings.rate_limit_directory_heartbeat)
    inst = await _authed_instance(db, body.instance_id, body.token, body.client_id)
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
    # Server läuft: Mitglieder bekommen ihn in die Leiste (nur beim Wechsel).
    await setze_online(getattr(request.app.state, "redis", None), db, inst, True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class OfflineIn(BaseModel):
    """Abschieds-Meldung — identische Auth wie der Heartbeat, nur ohne Daten."""

    model_config = ConfigDict(extra="forbid")
    instance_id: Annotated[str, Field(min_length=1, max_length=32)]
    token: Annotated[str, Field(min_length=1, max_length=128)]
    client_id: Annotated[str, Field(max_length=128)] | None = None


@router.post("/selfhost/directory/offline", status_code=status.HTTP_204_NO_CONTENT)
async def directory_offline(body: OfflineIn, request: Request, db: SessionDep) -> Response:
    """Löscht den Telefonbuch-Eintrag der Instanz sofort (idempotent).

    Teilt das Rate-Limit mit dem Heartbeat — der Abschied kommt genau einmal
    pro Stopp, fällt dort also nicht auf. Löscht auch die letzte bekannte
    Heim-Adresse (gleiches Versiegeln wie beim Kill-Switch).
    """
    settings = get_settings()
    await _check_rate(request, "directory_heartbeat", settings.rate_limit_directory_heartbeat)
    inst = await _authed_instance(db, body.instance_id, body.token, body.client_id)
    await db.execute(
        delete(InstanceDirectEndpoint).where(InstanceDirectEndpoint.instance_id == inst.id)
    )
    await db.commit()
    # Geordneter Stopp: sofort aus der Leiste aller Mitglieder.
    await setze_online(getattr(request.app.state, "redis", None), db, inst, False)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class AnzeigenameIn(BaseModel):
    """Der Server meldet den Namen, den ihm sein Betreiber gegeben hat —
    identische Auth wie der Heartbeat. ``None``/leer = Name entfernt."""

    model_config = ConfigDict(extra="forbid")
    instance_id: Annotated[str, Field(min_length=1, max_length=32)]
    token: Annotated[str, Field(min_length=1, max_length=128)]
    client_id: Annotated[str, Field(max_length=128)] | None = None
    # 60 wie ``instance_name`` im chat-gateway (schemas.py), dessen Wert hier
    # ankommt.
    anzeigename: Annotated[str, Field(max_length=60)] | None = None


@router.post("/selfhost/anzeigename", status_code=status.HTTP_204_NO_CONTENT)
async def setze_anzeigename(body: AnzeigenameIn, request: Request, db: SessionDep) -> Response:
    """Anzeigename der Instanz setzen und den Mitgliedern melden (idempotent)."""
    settings = get_settings()
    await _check_rate(request, "directory_heartbeat", settings.rate_limit_directory_heartbeat)
    inst = await _authed_instance(db, body.instance_id, body.token, body.client_id)
    # Steuerzeichen raus, Ränder weg — der Wert landet in jeder Server-Leiste.
    name = "".join(z for z in (body.anzeigename or "") if z.isprintable()).strip() or None
    if name != inst.anzeigename:
        inst.anzeigename = name
        await db.commit()
        await melde(getattr(request.app.state, "redis", None), db, inst)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/me/instances/{instance_id}/direct-endpoint", response_model=DirectEndpointOut
)
async def get_direct_endpoint(
    instance_id: str, request: Request, db: SessionDep
) -> DirectEndpointOut:
    """Telefonbuch-Lookup für Owner UND gemerkte Mitglieder der Instanz
    (404 sonst — kein Leak). Bis 2026-09-23 owner-only (IP-Schutz); mit dem
    Heim-Server-V1-Entscheid (2026-09-27, kein Relay) ist der Direktweg der
    einzige Zugang für Mitglieder — Weg 1 aus
    docs/2026-09-07-direktweg-berechtigung.md."""
    settings = get_settings()
    await _check_rate(request, "directory_lookup", settings.rate_limit_directory_lookup)
    user = await _require_user(request, db)

    iid = kennung_aus_text(instance_id)
    if iid is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    # Direktpfad ist Owner-Sache: der Mitglied-Eintrag ist eine Merkhilfe ohne
    # Nachweis („beitreten" braucht keinen Beleg), und der Lookup gibt die
    # Heim-IP des Betreibers her — docs/2026-09-07-direktweg-berechtigung.md,
    # Weg 1. Suspendierte Instanz: Kill-Switch versiegelt auch die letzte
    # bekannte Heimadresse.
    # Heim-Server V1 (2026-09-27): ohne Relay ist der Direktweg der EINZIGE
    # Weg für Mitglieder — geöffnet für Owner und gemerkte Mitgliedschaft
    # (Weg 1 aus docs/2026-09-07-direktweg-berechtigung.md, Produktentscheid).
    # Die echte Schranke bleibt das Sitzungs-Ticket + Beitritts-Gate (Invite-
    # Codes) auf dem Server dahinter; Suspend-versiegelt bleibt beides.
    membership = await db.get(UserInstanceMembership, (user.id, iid))
    if membership is None or membership.role not in ("owner", "member"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.status != "active":
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
