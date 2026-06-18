"""User-facing Self-Hoster endpoints — Phase 2.2.

POST   /me/instance-applications        -- Antrag einreichen
GET    /me/instance-applications        -- eigene Anträge abrufen
GET    /me/instances                    -- eigene registrierte Instanzen
POST   /me/instances/{id}/env-file            -- fertige .env (inkl. frischem Secret)
"""

from __future__ import annotations

import asyncio
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, delete, select

from dcc_auth.bootstrap import generate_bootstrap_token, hash_bootstrap_token
from dcc_auth.browser_sessions import validate_session
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceApplication,
    InstanceBootstrapToken,
    RegisteredInstance,
)
from dcc_auth.routes import _check_rate
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id

router = APIRouter(tags=["self-host"])

# FQDN: mindestens zwei Labels, nur lowercase+Ziffern+Bindestrich.
# Label darf NICHT mit Bindestrich beginnen oder enden (RFC 1123).
# TLD ≥2 Alpha.
_FQDN_RE = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")

# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


async def _require_user(request: Request, db) -> User:
    """Validate session cookie → User.  Raises HTTP 401 on failure."""
    import uuid

    raw = request.cookies.get("pulse_session")
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing session cookie")
    try:
        sid = uuid.UUID(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid session cookie"
        ) from exc
    row = await validate_session(db, sid)
    if row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="session expired or not found"
        )
    user = await db.get(User, row.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="user not found")
    if user.disabled or user.is_suspended:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
    return user


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class InstanceApplicationCreate(BaseModel):
    hostname: str = Field(min_length=4, max_length=253)
    purpose: Literal["privat", "verein", "firma", "sonst"]
    expected_users: int = Field(ge=1, le=10000)
    contact_email: EmailStr
    notes: str | None = Field(default=None, max_length=2000)


class InstanceApplicationOut(BaseModel):
    id: str  # Snowflake-String-API
    applicant_user_id: str
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


class InstanceOut(BaseModel):
    id: str  # Snowflake-String-API
    hostname: str
    client_id: str
    worker_id_chat: int
    worker_id_voice: int
    worker_id_media: int
    status: Literal["active", "suspended"]
    registered_at: datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _app_to_out(app: InstanceApplication) -> InstanceApplicationOut:
    return InstanceApplicationOut(
        id=str(app.id),
        applicant_user_id=str(app.applicant_user_id),
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


def _instance_to_out(inst: RegisteredInstance) -> InstanceOut:
    return InstanceOut(
        id=str(inst.id),
        hostname=inst.hostname,
        client_id=inst.client_id,
        worker_id_chat=inst.worker_id_chat,
        worker_id_voice=inst.worker_id_voice,
        worker_id_media=inst.worker_id_media,
        status=inst.status,  # type: ignore[arg-type]
        registered_at=inst.registered_at,
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
    """Antrag auf Self-Host-Instanz-Registrierung einreichen."""
    user = await _require_user(request, db)

    # FQDN-Check: kein Single-Label, kein raw-IP, kein localhost.
    hostname = payload.hostname.lower()
    if not _FQDN_RE.match(hostname):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="hostname muss ein vollständiger Domain-Name (FQDN) sein",
        )

    # Duplicate-Check: pending-Antrag desselben Users für denselben Hostname.
    dup_stmt = select(InstanceApplication).where(
        and_(
            InstanceApplication.applicant_user_id == user.id,
            InstanceApplication.hostname == hostname,
            InstanceApplication.status == "pending",
        )
    )
    dup = (await db.execute(dup_stmt)).scalars().first()
    if dup is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="du hast bereits einen offenen Antrag für diesen Hostname",
        )

    # Hostname-Konflikt: existiert der Hostname schon in registered_instances?
    conflict_stmt = select(RegisteredInstance).where(
        RegisteredInstance.hostname == hostname
    )
    conflict = (await db.execute(conflict_stmt)).scalars().first()
    if conflict is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="dieser Hostname ist bereits registriert",
        )

    app = InstanceApplication(
        id=next_id(),
        applicant_user_id=user.id,
        hostname=hostname,
        purpose=payload.purpose,
        expected_users=payload.expected_users,
        contact_email=str(payload.contact_email),
        notes=payload.notes,
        status="pending",
    )
    db.add(app)
    await db.flush()
    await db.commit()
    await db.refresh(app)
    return _app_to_out(app)


@router.get(
    "/me/instance-applications",
    response_model=list[InstanceApplicationOut],
)
async def list_my_instance_applications(
    request: Request,
    db: SessionDep,
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "all"] | None,
        Query(alias="status"),
    ] = None,
) -> list[InstanceApplicationOut]:
    """Eigene Anträge abrufen, optional nach Status gefiltert."""
    user = await _require_user(request, db)

    stmt = (
        select(InstanceApplication)
        .where(InstanceApplication.applicant_user_id == user.id)
        .order_by(InstanceApplication.created_at.desc())
    )
    if status_filter and status_filter != "all":
        stmt = stmt.where(InstanceApplication.status == status_filter)

    rows = (await db.execute(stmt)).scalars().all()
    return [_app_to_out(r) for r in rows]


@router.get(
    "/me/instances",
    response_model=list[InstanceOut],
)
async def list_my_instances(
    request: Request,
    db: SessionDep,
) -> list[InstanceOut]:
    """Eigene registrierte Instanzen abrufen. client_secret wird NIE zurückgegeben."""
    user = await _require_user(request, db)

    stmt = (
        select(RegisteredInstance)
        .where(
            RegisteredInstance.registered_by == user.id,
            # Vom Owner gelöschte Instanzen (Soft-Delete, s. routes_instance_delete)
            # sind für ihn unsichtbar.
            RegisteredInstance.status != "deleted",
        )
        .order_by(RegisteredInstance.registered_at.desc())
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [_instance_to_out(r) for r in rows]


@router.post(
    "/me/instances/{instance_id}/env-file",
    response_class=Response,
)
async def generate_env_file(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> Response:
    """Erzeugt die komplette, sofort lauffähige ``.env`` für den allinone-Container.

    Nur der Eigentümer (404 statt 403 gegen Existence-Leak). Anders als ein
    bloßes Template enthält diese ``.env`` ALLE Werte gesetzt — inklusive eines
    **frisch generierten** ``PULSE_CLOUD_CLIENT_SECRET``:

    * Jeder Aufruf rotiert das Secret. Der Klartext geht **ausschließlich** hier
      in der Antwort raus; in der DB liegt nur der Argon2-Hash. Ein erneuter
      Download entwertet damit das vorherige Secret (UI warnt davor) — genau wie
      der Bootstrap-Redeem (``routes_selfhost_bootstrap``).
    * Die Var-Namen MÜSSEN exakt die sein, die der Container liest
      (``10-check-cloud-creds.sh`` / ``07-render-env.sh``): ``PULSE_CLOUD_CLIENT_*``
      (nicht ``PULSE_INSTANCE_CLIENT_*``) plus ``PULSE_INSTANCE_OWNER_ID``,
      ``PULSE_HOSTNAME`` und ``PULSE_ADMIN_EMAIL``. Worker-IDs tauchen NICHT auf
      (der Single-Container nutzt feste interne IDs).
    * Secret wird NIE geloggt.
    """
    user = await _require_user(request, db)
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    inst = await db.get(RegisteredInstance, iid, with_for_update=True)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    # Secret rotieren — Klartext nur hier, DB hält nur den Hash.
    new_secret = secrets.token_urlsafe(32)
    inst.client_secret = await asyncio.to_thread(hash_password, new_secret)
    await db.commit()

    admin_email = user.email or f"admin@{inst.hostname}"
    snippet = (
        f"# Pulse Self-Host — Instance {inst.id}\n"
        f"# Hostname: {inst.hostname}\n"
        f"#\n"
        f"# Fertige .env für den allinone-Container — alle Werte sind gesetzt.\n"
        f"# Das client_secret unten ist FRISCH erzeugt; ein erneuter Download\n"
        f"# erzeugt ein neues und entwertet dieses. Bewahr die Datei sicher auf.\n"
        f"# Start: docker compose up -d   (docker-compose.yml + diese .env)\n"
        f"\n"
        f"PULSE_HOSTNAME={inst.hostname}\n"
        f"PULSE_INSTANCE_ID={inst.id}\n"
        f"PULSE_INSTANCE_OWNER_ID={inst.registered_by}\n"
        f"PULSE_INSTANCE_MODE=self-host\n"
        f"PULSE_CLOUD_ORIGIN={settings.pulse_oidc_issuer}\n"
        f"\n"
        f"# Cloud-Pairing-Credentials (frisch erzeugt):\n"
        f"PULSE_CLOUD_CLIENT_ID={inst.client_id}\n"
        f"PULSE_CLOUD_CLIENT_SECRET={new_secret}\n"
        f"\n"
        f"PULSE_ADMIN_EMAIL={admin_email}\n"
    )

    return Response(
        content=snippet,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="pulse-instance-{inst.id}.env"'
        },
    )


# ---------------------------------------------------------------------------
# Ein-Befehl-Installer — Mint eines One-Time-Bootstrap-Tokens
# ---------------------------------------------------------------------------


class BootstrapTokenOut(BaseModel):
    token: str
    expires_at: datetime
    ttl_seconds: int


@router.post(
    "/me/instances/{instance_id}/bootstrap-token",
    response_model=BootstrapTokenOut,
    status_code=status.HTTP_201_CREATED,
)
async def mint_bootstrap_token(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> BootstrapTokenOut:
    """Mintet einen One-Time-Bootstrap-Token für den Ein-Befehl-Installer.

    Nur der Owner der Instanz (404 statt 403 gegen Existence-Leak). Räumt alle
    vorherigen Tokens dieser Instanz weg — es gilt immer höchstens einer, ein
    „neu generieren" entwertet den alten sofort.
    """
    user = await _require_user(request, db)
    if not user.self_host_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="self-hosting not enabled")
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    await db.execute(
        delete(InstanceBootstrapToken).where(InstanceBootstrapToken.instance_id == iid)
    )

    token = generate_bootstrap_token()
    ttl = settings.bootstrap_token_ttl_seconds
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
    db.add(
        InstanceBootstrapToken(
            id=next_id(),
            instance_id=iid,
            token_hash=hash_bootstrap_token(token),
            expires_at=expires_at,
        )
    )
    await db.commit()
    return BootstrapTokenOut(token=token, expires_at=expires_at, ttl_seconds=ttl)
