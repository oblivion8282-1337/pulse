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

from dcc_auth.admin_events import publish_application_pending
from dcc_auth.bootstrap import generate_bootstrap_token, hash_bootstrap_token
from dcc_auth.browser_sessions import validate_session
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceApplication,
    InstanceBootstrapToken,
    RegisteredInstance,
    UserInstanceMembership,
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


def _require_self_host_enabled(user: User) -> None:
    """Cloud-Gate (④): blockt jeden Pfad, der dem Host echte Pairing-Credentials
    gibt, wenn der User nicht freigeschaltet ist. MUSS auf JEDEM credential-
    ausgebenden Endpoint sitzen (Bootstrap-Token-Mint UND env-file-Download),
    sonst ist das Gate umgehbar — beide liefern austauschbare Cloud-Credentials."""
    if not user.self_host_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="self-hosting not enabled")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class InstanceApplicationCreate(BaseModel):
    hostname: str = Field(min_length=4, max_length=253)
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
    # vps = klassischer Self-Host, app_host = Ein-Knopf-Container aus der App.
    # Das Frontend blendet app_host-Instanzen aus "Meine Instanzen" aus.
    origin: Literal["vps", "app_host"] = "vps"
    registered_at: datetime
    # Per-User-Präferenzen aus user_instance_memberships (account-basiert →
    # geräteübergreifend). NULL/Default, wenn keine Membership im Kontext.
    user_label: str | None = None
    notification_mode: Literal["all", "mentions", "none"] = "mentions"


class InstancePreferencesIn(BaseModel):
    """Partielles Update der geräteübergreifenden Server-Präferenzen. Nur
    gesetzte Felder werden geändert (``model_fields_set``); ``label=None``
    setzt den Anzeigenamen explizit zurück (= Hostname anzeigen)."""

    label: str | None = Field(default=None, max_length=100)
    notification_mode: Literal["all", "mentions", "none"] | None = None


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


def _instance_to_out(
    inst: RegisteredInstance, membership: UserInstanceMembership | None = None
) -> InstanceOut:
    return InstanceOut(
        id=str(inst.id),
        # App-Host-Instanzen tragen als ``hostname`` nur einen synthetischen
        # Platzhalter (``app-<id>.…``, bei der Approval vergeben, existiert im
        # DNS nicht). Erreichbar sind sie unter der Relay-Subdomain, die erst
        # beim Pairing entsteht. Der Client baut aus diesem Feld seine
        # Server-URL — ohne den Fallback zeigt er auf einen toten Host und der
        # Cert-Login scheitert mit 401 (``cert_invalid``).
        hostname=inst.relay_subdomain or inst.hostname,
        client_id=inst.client_id,
        worker_id_chat=inst.worker_id_chat,
        worker_id_voice=inst.worker_id_voice,
        worker_id_media=inst.worker_id_media,
        status=inst.status,  # type: ignore[arg-type]
        origin=inst.origin,  # type: ignore[arg-type]
        registered_at=inst.registered_at,
        user_label=membership.user_label if membership else None,
        notification_mode=(
            membership.notification_mode if membership else "mentions"  # type: ignore[arg-type]
        ),
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
    # zurückgerollter Antrag nie war.
    await publish_application_pending(request, "instance")
    return _app_to_out(app)


@router.get(
    "/me/instance-applications",
    response_model=list[InstanceApplicationOut],
)
async def list_my_instance_applications(
    request: Request,
    db: SessionDep,
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "closed", "all"] | None,
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

    # Liest aus ``user_instance_memberships`` (= Account-basierte Server-Liste).
    # Vor dem Vault-Drop (Migration 0026 → 0037) war das ein Filter über
    # ``registered_by`` — die neue Tabelle ist die Quelle der Wahrheit und
    # erlaubt später auch eingeladene Nicht-Owner-User (Phase 4-6).
    # Soft-delete (routes_instance_delete) ausblenden.
    stmt = (
        select(RegisteredInstance, UserInstanceMembership)
        .join(
            UserInstanceMembership,
            UserInstanceMembership.instance_id == RegisteredInstance.id,
        )
        .where(
            UserInstanceMembership.user_id == user.id,
            RegisteredInstance.status != "deleted",
        )
        .order_by(RegisteredInstance.registered_at.desc())
    )
    rows = (await db.execute(stmt)).all()
    return [_instance_to_out(inst, membership) for inst, membership in rows]


@router.post(
    "/me/instances/{instance_id}/membership",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def join_instance_membership(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Den eingeloggten Cloud-User als Mitglied einer Self-Host-Instanz
    eintragen — so erscheint ein per Einladung beigetretener Server auch auf
    anderen Geräten (Account-basierte Server-Liste, ``GET /me/instances``).

    Bisher legte nur der Owner-Pfad (Approval/Bootstrap-Redeem) eine Membership
    an; ein eingeladener Nicht-Owner hatte nur den gerätelokalen
    ``pulse.servers``-Eintrag → im Browser unsichtbar. Dieser Endpoint schließt
    die Lücke (die in ``UserInstanceMembership`` vorbereitete Phase-4-6-Rolle).

    Idempotent. Eine bestehende ``owner``-Rolle wird NICHT herabgestuft. Die
    Cloud verifiziert die Self-Host-seitige Mitgliedschaft bewusst NICHT
    (Cert-Modell: Self-Hosts sind isolierte DB-Welten) — die Server-Liste war
    immer nur eine schwache Tracking-Dimension, kein Zugriffsbeweis. Ohne echten
    Cert-Grant kommt der User auf dem Self-Host trotzdem nicht rein; der Client
    ruft den Endpoint ohnehin erst nach erfolgreichem Cert-Login auf.
    """
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    if await db.get(UserInstanceMembership, (user.id, iid)) is None:
        db.add(
            UserInstanceMembership(user_id=user.id, instance_id=iid, role="member")
        )
        await db.commit()


@router.delete(
    "/me/instances/{instance_id}/membership",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def leave_instance_membership(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Cloud-seitige Membership entfernen, wenn der User einen Self-Host-Server
    entfernt (= austritt). Gegenstück zu :func:`join_instance_membership` —
    ohne das würde der Server beim nächsten ``GET /me/instances`` auf anderen
    Geräten wieder auftauchen.

    Der Owner kann seine Membership so NICHT wegwerfen (er bleibt Owner; zum
    Loswerden dient ``DELETE /me/instances/{id}`` = Instanz löschen) → 403.
    Idempotent: keine Membership → 204.
    """
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    existing = await db.get(UserInstanceMembership, (user.id, iid))
    if existing is None:
        return
    if existing.role == "owner":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="owner_cannot_leave_instance"
        )
    await db.delete(existing)
    await db.commit()


@router.patch(
    "/me/instances/{instance_id}/preferences",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def update_instance_preferences(
    instance_id: str,
    payload: InstancePreferencesIn,
    request: Request,
    db: SessionDep,
) -> None:
    """Geräteübergreifende Server-Präferenzen (Anzeigename + Notification-Modus)
    setzen. Damit gelten Umbenennung und Stummschaltung eines Self-Host-Servers
    auf allen Geräten, nicht nur lokal. Partiell: nur gesetzte Felder ändern.
    404, wenn der User keine Membership auf der Instanz hat."""
    user = await _require_user(request, db)
    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    membership = await db.get(UserInstanceMembership, (user.id, iid))
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")
    fields = payload.model_fields_set
    if "label" in fields:
        membership.user_label = payload.label
    if "notification_mode" in fields and payload.notification_mode is not None:
        membership.notification_mode = payload.notification_mode
    await db.commit()


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
    **frisch generierten** ``PULSE_CLOUD_CLIENT_SECRET``.

    **One-shot nach erstem Download:** der erste Aufruf rotiert das Secret und
    setzt ``env_file_downloaded_at``; jeder weitere → 403. Verhindert, dass
    dieser Pfad die One-Shot-Semantik von ``mint_bootstrap_token`` aushebelt
    (Side-Channel auf frische Credentials).

    Der Klartext des Secrets geht **ausschließlich** hier in der Antwort raus;
    in der DB liegt nur der Argon2-Hash. Secret wird NIE geloggt. Die
    Var-Namen MÜSSEN exakt die sein, die der Container liest
    (``10-check-cloud-creds.sh`` / ``07-render-env.sh``): ``PULSE_CLOUD_CLIENT_*``
    (nicht ``PULSE_INSTANCE_CLIENT_*``) plus ``PULSE_INSTANCE_OWNER_ID``,
    ``PULSE_HOSTNAME`` und ``PULSE_ADMIN_EMAIL``. Worker-IDs tauchen NICHT auf
    (der Single-Container nutzt feste interne IDs).
    """
    user = await _require_user(request, db)
    _require_self_host_enabled(user)
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    inst = await db.get(RegisteredInstance, iid, with_for_update=True)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    # One-shot-Markierung (siehe Docstring) — Credential-Rotation als
    # Side-Channel auf den Bootstrap-Token-One-Shot sperren.
    if inst.env_file_downloaded_at is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Env-File bereits heruntergeladen — für eine neue Instanz neuen Antrag stellen",
        )

    new_secret = secrets.token_urlsafe(32)
    inst.client_secret = await asyncio.to_thread(hash_password, new_secret)
    inst.env_file_downloaded_at = datetime.now(UTC)  # atomar mit Secret-Rotation
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


class BootstrapTokenMintIn(BaseModel):
    """Optionaler Body: ``reset=true`` erlaubt den Re-Mint nach bereits
    eingelöstem Bootstrap — der bewusste „Zugang zurücksetzen"-Pfad für
    App-Hosts nach Gerätewechsel/Store-Verlust. Das Einlösen rotiert wie
    immer client_secret + Tunnel-Token, alte Credentials sterben also sofort."""

    reset: bool = False


@router.post(
    "/me/instances/{instance_id}/bootstrap-token",
    response_model=BootstrapTokenOut,
    status_code=status.HTTP_201_CREATED,
)
async def mint_bootstrap_token(
    instance_id: str,
    request: Request,
    db: SessionDep,
    payload: BootstrapTokenMintIn | None = None,
) -> BootstrapTokenOut:
    """Mintet einen One-Time-Bootstrap-Token für den Ein-Befehl-Installer.

    Nur der Owner der Instanz (404 statt 403 gegen Existence-Leak). Räumt alle
    vorherigen, nicht-eingelösten Tokens dieser Instanz weg — ein „neu
    generieren" entwertet den alten sofort. Nach erfolgreichem Redeem sind
    weitere Mints geblockt (Hijack-Härtung: eine gekaperte Session kann keine
    laufende Instanz still übernehmen) — AUSSER der Owner setzt explizit
    ``reset=true``: der bewusste Recovery-Pfad nach Gerätewechsel/Creds-Verlust.
    Das Einlösen rotiert client_secret + Tunnel-Token, ein alter Server verliert
    damit sofort seinen Cloud-Zugang — es entstehen nie zwei lebende Server aus
    einer Instanz. Token-Verlust vor Redeem (TTL abgelaufen) erlaubt weiteres
    Mint.
    """
    user = await _require_user(request, db)
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    try:
        iid = int(instance_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.registered_by != user.id or inst.status == "deleted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    # One-shot nach erfolgreichem Setup: ein bereits eingelöstes Token
    # blockiert weitere Mints — außer beim expliziten Reset (s. Docstring).
    # Audit-Spur bleibt in der Token-Tabelle (Redeem setzt nur consumed_at,
    # löscht nicht; auch der Reset löscht nur uneingelöste Tokens).
    already_consumed = (
        await db.execute(
            select(InstanceBootstrapToken.id)
            .where(
                InstanceBootstrapToken.instance_id == iid,
                InstanceBootstrapToken.consumed_at.is_not(None),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if already_consumed is not None and not (payload and payload.reset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Bootstrap bereits eingelöst — für weitere Server neuen Antrag stellen",
        )

    await db.execute(
        delete(InstanceBootstrapToken).where(
            InstanceBootstrapToken.instance_id == iid,
            InstanceBootstrapToken.consumed_at.is_(None),
        )
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
