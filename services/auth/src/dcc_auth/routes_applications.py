"""Vereintes User-Antragssystem für Hosting-Freischaltung (Migration 0044).

POST   /me/instance-applications  -- Antrag einreichen (origin: vps | app_host)
GET    /me/instance-applications  -- eigene Anträge abrufen (origin-filterbar)

Ersetzt den früheren getrennten App-Host-Antragsweg
(``routes_app_host_applications.py``); dessen alte Pfade leben als dünne
Deprecation-Wrapper in ``routes_app_host_compat.py`` weiter, bis das Frontend
umgestellt ist. Ausgelagert aus ``routes_instance_applications.py``
(Größen-Policy) — dort bleiben die ``/me/instances``-Endpoints.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, select

from dcc_auth.admin_events import publish_application_pending
from dcc_auth.db import SessionDep
from dcc_auth.instance_provisioning import app_host_placeholder_hostname
from dcc_auth.models import User
from dcc_auth.models_instances import InstanceApplication, RegisteredInstance
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.snowflake import next_id

router = APIRouter(tags=["self-host"])

# FQDN: mindestens zwei Labels, nur lowercase+Ziffern+Bindestrich.
# Label darf NICHT mit Bindestrich beginnen oder enden (RFC 1123).
# TLD ≥2 Alpha.
_FQDN_RE = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")

ApplicationOrigin = Literal["vps", "app_host"]


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class InstanceApplicationCreate(BaseModel):
    # vps = klassischer Self-Host (Hostname Pflicht) · app_host = Ein-Knopf-
    # Hosting aus der App (kein Hostname vom User — Platzhalter, s. Modell).
    origin: ApplicationOrigin = "vps"
    hostname: str | None = Field(default=None, min_length=4, max_length=253)
    # Das Formular erfasst nur noch den Hostname. Die restlichen Felder sind
    # optional (für Alt-Clients / API-Nutzer noch akzeptiert): ``contact_email``
    # wird sonst aus dem eingeloggten User abgeleitet (haben wir ohnehin),
    # purpose/expected_users bekommen unauffällige Defaults.
    purpose: Literal["privat", "verein", "firma", "sonst"] = "sonst"
    expected_users: int = Field(default=1, ge=1, le=10000)
    contact_email: EmailStr | None = None
    notes: str | None = Field(default=None, max_length=2000)


class InstanceApplicationOut(BaseModel):
    id: str  # Snowflake-String-API
    applicant_user_id: str
    origin: ApplicationOrigin
    hostname: str
    purpose: str
    expected_users: int
    contact_email: str
    notes: str | None
    status: str
    reviewed_at: datetime | None
    rejection_reason: str | None
    approved_instance_id: str | None
    created_at: datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def app_to_out(app: InstanceApplication) -> InstanceApplicationOut:
    return InstanceApplicationOut(
        id=str(app.id),
        applicant_user_id=str(app.applicant_user_id),
        origin=app.origin,  # type: ignore[arg-type]
        hostname=app.hostname,
        purpose=app.purpose,
        expected_users=app.expected_users,
        contact_email=app.contact_email,
        notes=app.notes,
        status=app.status,
        reviewed_at=app.reviewed_at,
        rejection_reason=app.rejection_reason,
        approved_instance_id=(
            str(app.approved_instance_id) if app.approved_instance_id is not None else None
        ),
        created_at=app.created_at,
    )


async def _guard_vps(db: SessionDep, user: User, payload: InstanceApplicationCreate) -> str:
    """VPS-Guards: FQDN-Format, kein doppelter pending-Antrag für den Hostname,
    Hostname nicht schon registriert. Gibt den normalisierten Hostname zurück."""
    if not payload.hostname:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="hostname ist für VPS-Anträge Pflicht",
        )
    hostname = payload.hostname.lower()
    # FQDN-Check: kein Single-Label, kein raw-IP, kein localhost.
    if not _FQDN_RE.match(hostname):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="hostname muss ein vollständiger Domain-Name (FQDN) sein",
        )
    dup = (
        await db.execute(
            select(InstanceApplication).where(
                and_(
                    InstanceApplication.applicant_user_id == user.id,
                    InstanceApplication.hostname == hostname,
                    InstanceApplication.status == "pending",
                )
            )
        )
    ).scalars().first()
    if dup is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="du hast bereits einen offenen Antrag für diesen Hostname",
        )
    conflict = (
        await db.execute(
            select(RegisteredInstance).where(RegisteredInstance.hostname == hostname)
        )
    ).scalars().first()
    if conflict is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="dieser Hostname ist bereits registriert",
        )
    return hostname


async def _guard_app_host(db: SessionDep, user: User) -> None:
    """App-Host-Guards (aus dem alten ``routes_app_host_applications.py``):
    wer schon freigeschaltet ist, braucht keinen Antrag; nur EIN offener
    app_host-Antrag pro User."""
    if user.self_host_enabled:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="self-hosting bereits freigeschaltet",
        )
    dup = (
        await db.execute(
            select(InstanceApplication).where(
                InstanceApplication.applicant_user_id == user.id,
                InstanceApplication.origin == "app_host",
                InstanceApplication.status == "pending",
            )
        )
    ).scalars().first()
    if dup is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="du hast bereits einen offenen Antrag",
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/me/instance-applications",
    response_model=InstanceApplicationOut,
    status_code=status.HTTP_201_CREATED,
)
async def submit_instance_application(
    payload: InstanceApplicationCreate,
    request: Request,
    db: SessionDep,
) -> InstanceApplicationOut:
    """Antrag auf Hosting-Freischaltung einreichen (VPS oder App-Host)."""
    user = await _require_user(request, db)

    app_id = next_id()
    if payload.origin == "app_host":
        await _guard_app_host(db, user)
        hostname = app_host_placeholder_hostname(app_id)
    else:
        hostname = await _guard_vps(db, user, payload)

    app = InstanceApplication(
        id=app_id,
        applicant_user_id=user.id,
        origin=payload.origin,
        hostname=hostname,
        purpose=payload.purpose,
        expected_users=payload.expected_users,
        # Antragsteller ist der eingeloggte User → seine E-Mail ist die Quelle.
        # Ein explizit mitgeschicktes ``contact_email`` (Alt-Client) gewinnt.
        contact_email=str(payload.contact_email) if payload.contact_email else user.email,
        notes=payload.notes,
        status="pending",
    )
    db.add(app)
    await db.flush()
    await db.commit()
    await db.refresh(app)
    # Erst nach dem Commit: die Admins sollen nichts sehen, was ein
    # zurückgerollter Antrag nie war. Event-Kind bleibt origin-getrennt —
    # das Frontend unterscheidet die Toast-/Refresh-Ziele danach.
    await publish_application_pending(
        request, "app_host" if payload.origin == "app_host" else "instance"
    )
    return app_to_out(app)


@router.get(
    "/me/instance-applications",
    response_model=list[InstanceApplicationOut],
)
async def list_my_instance_applications(
    request: Request,
    db: SessionDep,
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "closed", "revoked", "all"] | None,
        Query(alias="status"),
    ] = None,
    # Default 'vps' = exakte Abwärtskompatibilität: Alt-Clients (gecachte SPA)
    # kennen kein origin und erwarten hier NUR VPS-Anträge — sonst tauchten
    # migrierte App-Host-Anträge mit Platzhalter-Hostname in der VPS-Karte auf.
    # Das neue Frontend fragt explizit ``?origin=all`` bzw. ``app_host``.
    origin: Annotated[Literal["vps", "app_host", "all"], Query()] = "vps",
) -> list[InstanceApplicationOut]:
    """Eigene Anträge abrufen, optional nach Status/Origin gefiltert."""
    user = await _require_user(request, db)

    stmt = (
        select(InstanceApplication)
        .where(InstanceApplication.applicant_user_id == user.id)
        .order_by(InstanceApplication.created_at.desc())
    )
    if status_filter and status_filter != "all":
        stmt = stmt.where(InstanceApplication.status == status_filter)
    if origin != "all":
        stmt = stmt.where(InstanceApplication.origin == origin)

    rows = (await db.execute(stmt)).scalars().all()
    return [app_to_out(r) for r in rows]
