"""Cloud-Admin: vereintes Antragssystem (VPS + App-Host, Migration 0044).

GET  /admin/instance-applications              -- Liste (origin-/status-filterbar)
POST /admin/instance-applications/{id}/approve -- verzweigt nach origin
POST /admin/instance-applications/{id}/reject

Ausgelagert aus ``routes_admin_instances.py`` (Größen-Policy); dort bleiben
die Instanz-Endpoints (suspend/unsuspend/rotate-secret). Approve verzweigt:
``vps`` → RegisteredInstance mit Worker-IDs + einmalig gezeigtem client_secret;
``app_host`` → ``self_host_enabled=true`` + auto-provisionierte Relay-Instanz
(``instance_provisioning``). Die alten ``/admin/app-host-applications``-Pfade
delegieren als Deprecation-Wrapper hierher (``routes_app_host_compat.py``).
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from dcc_auth.admin_events import publish_application_decided
from dcc_auth.db import SessionDep
from dcc_auth.instance_provisioning import (
    provision_app_host_instance,
    user_has_active_owner_instance,
)
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceApplication,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.routes import _require_admin, _require_owner
from dcc_auth.routes_admin import _audit
from dcc_auth.routes_admin_instances import (
    _SECRET_WARNING,
    _allocate_worker_ids,
    _require_cloud,
)
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id

# Router-level dependency → jede Route hier ist cloud-gated (und per-Route
# zusätzlich admin-/owner-gated).
router = APIRouter(prefix="/admin", dependencies=[Depends(_require_cloud)])

_APPLICATION_STATUSES = ("pending", "approved", "rejected", "closed", "revoked")


# --------------------------------------------------------------------------- #
# Schemas                                                                       #
# --------------------------------------------------------------------------- #


class ApplicationOut(BaseModel):
    model_config = {"from_attributes": True}

    id: str  # Snowflake-String-API
    applicant_user_id: str
    origin: str  # vps | app_host
    hostname: str
    purpose: str
    expected_users: int
    contact_email: str
    notes: str | None = None
    # Anschluss-Check-Ergebnis vom App-Host-Antrag (beratend, Chip im UI).
    network_check: str | None = None
    status: str
    created_at: datetime
    applicant_username: str


class ApprovalOut(BaseModel):
    """VPS-Approval: Credentials werden GENAU EINMAL gezeigt."""

    instance_id: str  # Snowflake-String-API
    hostname: str
    client_id: str
    client_secret: str
    worker_id_chat: int
    worker_id_voice: int
    worker_id_media: int
    # Cloud user-id of the instance owner (the applicant). The self-hoster sets
    # this as PULSE_INSTANCE_OWNER_ID so they auto-become admin at cert-login.
    owner_user_id: str
    warning: str = _SECRET_WARNING


class AppHostApprovalOut(BaseModel):
    """App-Host-Approval: kein Secret an den Admin — Pairing kommt später."""

    id: str  # Antrags-ID, Snowflake-String-API
    user_id: str
    self_host_enabled: bool
    # Bei der Genehmigung auto-provisionierte App-Host-Instanz (Relay). NULL,
    # wenn der User schon eine aktive App-Host-Instanz hatte (Idempotenz).
    instance_id: str | None = None


class RejectIn(BaseModel):
    rejection_reason: Annotated[str, Field(max_length=1000)]


# --------------------------------------------------------------------------- #
# Routes                                                                        #
# --------------------------------------------------------------------------- #


@router.get("/instance-applications", response_model=list[ApplicationOut])
async def list_applications(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    status_filter: Annotated[str, Query(alias="status")] = "pending",
    origin: Annotated[str, Query()] = "all",
):
    """List applications, sorted oldest-first. Beide Origins, filterbar."""
    if status_filter not in (*_APPLICATION_STATUSES, "all"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="status must be pending, approved, rejected, closed, revoked or all",
        )
    if origin not in ("vps", "app_host", "all"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="origin must be vps, app_host or all",
        )
    stmt = (
        select(InstanceApplication)
        .order_by(InstanceApplication.created_at.asc())
        .options(selectinload(InstanceApplication.applicant))
    )
    if status_filter != "all":
        stmt = stmt.where(InstanceApplication.status == status_filter)
    if origin != "all":
        stmt = stmt.where(InstanceApplication.origin == origin)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        ApplicationOut(
            id=str(row.id),
            applicant_user_id=str(row.applicant_user_id),
            origin=row.origin,
            hostname=row.hostname,
            purpose=row.purpose,
            expected_users=row.expected_users,
            contact_email=row.contact_email,
            notes=row.notes,
            network_check=row.network_check,
            status=row.status,
            created_at=row.created_at,
            applicant_username=row.applicant.username,
        )
        for row in rows
    ]


async def _approve_app_host(
    app_id: int,
    request: Request,
    session: SessionDep,
    actor: User,
) -> AppHostApprovalOut:
    """App-Host-Zweig: Flag + auto-provisionierte Relay-Instanz im selben Tx.

    Übernommen aus dem früheren ``routes_admin_app_host.py`` — Verhalten
    identisch, nur die Antrags-Tabelle ist jetzt die vereinte.
    """
    app_row = await session.get(InstanceApplication, app_id, with_for_update=True)
    if app_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="application not found")
    if app_row.status != "pending":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Antrag ist bereits '{app_row.status}'",
        )

    target_user = await session.get(User, app_row.applicant_user_id)
    if target_user is None:
        # User wurde gelöscht, während der Antrag offen war — CASCADE hätte den
        # Antrag mitnehmen sollen. Defensive 404.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User nicht gefunden")

    app_row.status = "approved"
    app_row.reviewed_at = datetime.now(UTC)
    app_row.reviewed_by = actor.id

    was_enabled = target_user.self_host_enabled
    target_user.self_host_enabled = True

    # Relay-Instanz provisionieren, damit der User sofort aus der App hosten
    # kann. Idempotent: besitzt er schon eine aktive App-Host-Instanz, nichts tun.
    provisioned_instance_id: int | None = None
    if not await user_has_active_owner_instance(session, target_user.id):
        provisioned_instance_id = await provision_app_host_instance(session, target_user.id)
        app_row.approved_instance_id = provisioned_instance_id

    _audit(
        session,
        actor_id=actor.id,
        action="app_host_application.approve",
        target_id=target_user.id,
        payload={
            "application_id": app_row.id,
            "was_enabled": was_enabled,
            "instance_id": provisioned_instance_id,
        },
    )
    await session.commit()
    await session.refresh(app_row)

    # Erst nach dem Commit: der Antragsteller darf nichts erfahren, was ein
    # zurückgerollter Vorgang nie war.
    await publish_application_decided(
        request, user_id=target_user.id, kind="app_host", status="approved"
    )
    return AppHostApprovalOut(
        id=str(app_row.id),
        user_id=str(target_user.id),
        self_host_enabled=target_user.self_host_enabled,
        instance_id=(
            str(provisioned_instance_id) if provisioned_instance_id is not None else None
        ),
    )


async def _approve_vps(
    app_id: int,
    request: Request,
    session: SessionDep,
    actor: User,
) -> ApprovalOut:
    """VPS-Zweig: RegisteredInstance + Worker-IDs + einmalig gezeigtes Secret."""
    # Secret is generated once — it's independent of worker IDs / DB row.
    # client_id is re-generated inside the loop: it has a unique constraint and
    # must be fresh on every attempt so a (vanishingly rare) collision doesn't
    # pin the loop to the same failing value.
    client_secret_plain = secrets.token_urlsafe(32)
    client_secret_hash = await asyncio.to_thread(hash_password, client_secret_plain)

    # Retry loop for worker-ID UNIQUE conflicts (max 5 attempts)
    for attempt in range(5):
        client_id = secrets.token_urlsafe(16)

        # SELECT FOR UPDATE — serialises parallel approvals
        app_row = await session.get(InstanceApplication, app_id, with_for_update=True)
        if app_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="application not found")

        if app_row.status == "approved":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="application already approved — credentials were shown once at approval time",
            )
        if app_row.status != "pending":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="application was rejected; cannot approve a rejected application",
            )

        # Snapshot scalar attrs before the commit — after a rollback the ORM
        # expires all attributes and accessing them would raise MissingGreenlet.
        app_hostname = app_row.hostname
        app_applicant_user_id = app_row.applicant_user_id

        # Allocate worker IDs
        wid_chat, wid_voice, wid_media = await _allocate_worker_ids(session)

        instance_id = next_id()
        instance = RegisteredInstance(
            id=instance_id,
            hostname=app_hostname,
            client_id=client_id,
            client_secret=client_secret_hash,
            worker_id_chat=wid_chat,
            worker_id_voice=wid_voice,
            worker_id_media=wid_media,
            status="active",
            registered_by=app_applicant_user_id,
        )
        session.add(instance)

        # Owner-Membership SOFORT anlegen — nicht erst beim Bootstrap-Redeem.
        # Sonst ist die frisch genehmigte Instanz in ``GET /me/instances``
        # (liest aus user_instance_memberships) unsichtbar → der Owner sieht
        # keinen „Server einrichten"-Button und kommt nie zum Redeem (Henne-Ei).
        # Der Redeem legt die Zeile idempotent erneut an, falls nötig.
        session.add(
            UserInstanceMembership(
                user_id=app_applicant_user_id,
                instance_id=instance_id,
                role="owner",
            )
        )

        app_row.status = "approved"
        app_row.reviewed_by = actor.id
        app_row.reviewed_at = datetime.now(UTC)
        app_row.approved_instance_id = instance_id

        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            # A non-worker-ID unique violation (hostname or client_id) will not
            # be fixed by retrying.  Detect the hostname case explicitly so the
            # caller gets a 409 instead of a 503 after five futile retries.
            hostname_taken = (
                await session.execute(
                    select(RegisteredInstance.id).where(
                        RegisteredInstance.hostname == app_hostname
                    )
                )
            ).scalar_one_or_none()
            if hostname_taken is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail="hostname already registered under a different instance",
                )
            if attempt == 4:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="worker-id allocation conflict, try again",
                )
            # Retry: a worker-id UNIQUE collision means the allocated IDs are
            # stale. After rollback the ORM attributes of app_row are expired,
            # so we must NOT fall through to the success ApprovalOut (that would
            # touch expired attrs → MissingGreenlet/500). Re-enter the loop to
            # re-lock the row and re-allocate.
            continue

        # Erst nach dem Commit: der Antragsteller darf nichts erfahren, was ein
        # zurückgerollter Vorgang nie war.
        await publish_application_decided(
            request, user_id=app_applicant_user_id, kind="instance", status="approved"
        )

        return ApprovalOut(
            instance_id=str(instance_id),
            hostname=app_hostname,
            client_id=client_id,
            client_secret=client_secret_plain,
            worker_id_chat=wid_chat,
            worker_id_voice=wid_voice,
            worker_id_media=wid_media,
            owner_user_id=str(app_applicant_user_id),
        )

    # unreachable: loop only exits via return/raise
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="approval failed")


@router.post(
    "/instance-applications/{app_id}/approve",
    response_model=ApprovalOut | AppHostApprovalOut,
)
async def approve_application(
    app_id: int,
    request: Request,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_owner)],
):
    """Approve — verzweigt nach ``origin`` des Antrags.

    Die Response-Shape unterscheidet sich bewusst: VPS liefert die einmalig
    gezeigten Pairing-Credentials, App-Host nur Flag + Instanz-ID (Pairing
    läuft später über den Bootstrap-Token).
    """
    origin = (
        await session.execute(
            select(InstanceApplication.origin).where(InstanceApplication.id == app_id)
        )
    ).scalar_one_or_none()
    if origin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="application not found")
    if origin == "app_host":
        return await _approve_app_host(app_id, request, session, actor)
    return await _approve_vps(app_id, request, session, actor)


@router.post("/instance-applications/{app_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
async def reject_application(
    app_id: int,
    body: RejectIn,
    request: Request,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_owner)],
):
    """Reject a pending application (beide Origins). Already-decided → 409."""
    app_row = await session.get(InstanceApplication, app_id, with_for_update=True)
    if app_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="application not found")
    if app_row.status == "rejected":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="application already rejected")
    if app_row.status != "pending":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="application already approved; cannot reject",
        )

    applicant_user_id = app_row.applicant_user_id
    kind = "app_host" if app_row.origin == "app_host" else "instance"
    app_row.status = "rejected"
    app_row.reviewed_by = actor.id
    app_row.reviewed_at = datetime.now(UTC)
    app_row.rejection_reason = body.rejection_reason
    if kind == "app_host":
        # Der alte App-Host-Weg auditierte Rejects (der VPS-Weg nie) —
        # Verhalten beibehalten.
        _audit(
            session,
            actor_id=actor.id,
            action="app_host_application.reject",
            target_id=applicant_user_id,
            payload={"application_id": app_row.id, "reason": body.rejection_reason},
        )
    await session.commit()

    await publish_application_decided(
        request,
        user_id=applicant_user_id,
        kind=kind,  # type: ignore[arg-type]
        status="rejected",
        rejection_reason=body.rejection_reason,
    )
