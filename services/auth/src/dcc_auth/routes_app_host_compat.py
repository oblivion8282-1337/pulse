"""DEPRECATED: alte App-Host-Antrags-Pfade als dünne Delegations-Wrapper.

Das Antragssystem ist vereint (Migration 0044, ``routes_applications.py`` +
``routes_admin_applications.py``); diese Pfade existieren nur noch, damit ein
noch nicht umgestelltes / gecachtes Frontend nicht bricht (API-Bruch vermeiden):

POST /me/app-host-application                   → submit (origin='app_host')
GET  /me/app-host-applications                  → list  (origin='app_host')
GET  /admin/app-host-applications               → Admin-Liste (origin='app_host')
POST /admin/app-host-applications/{id}/approve  → vereinter Approve
POST /admin/app-host-applications/{id}/reject   → vereinter Reject

Nach dem Frontend-Umbau auf die vereinten Pfade kann dieses Modul weg.
Der Revoke-Pfad (``routes_admin_app_host_revoke.py``) ist KEIN Wrapper —
er hat keinen vereinten Zwilling und bleibt eigenständig.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import InstanceApplication
from dcc_auth.routes import _require_admin, _require_owner
from dcc_auth.routes_admin_applications import (
    RejectIn,
    approve_application,
    reject_application,
)
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_applications import (
    InstanceApplicationCreate,
    list_my_instance_applications,
    submit_instance_application,
)

router = APIRouter(tags=["self-host"])
admin_router = APIRouter(prefix="/admin", dependencies=[Depends(_require_cloud)])


# ---------------------------------------------------------------------------
# Alte Response-Shapes (unverändert gegenüber routes_app_host_applications.py /
# routes_admin_app_host.py — das ist der Sinn der Wrapper)
# ---------------------------------------------------------------------------


class AppHostApplicationCreate(BaseModel):
    purpose: Literal["privat", "verein", "firma", "sonst"]
    message: str | None = Field(default=None, max_length=2000)


class AppHostApplicationOut(BaseModel):
    id: str  # Snowflake-String-API
    user_id: str
    purpose: str
    message: str | None
    # 'revoked' war in der alten Out-Literal vergessen (Zeilen in der Tabelle
    # gab es trotzdem) — hier ergänzt, sonst 500 beim Listen nach einem Revoke.
    status: Literal["pending", "approved", "rejected", "revoked"]
    reviewed_at: datetime | None
    rejection_reason: str | None
    created_at: datetime


class AdminAppHostApplicationOut(BaseModel):
    """Trägt applicant_username für die Admin-Liste."""

    id: str  # Snowflake-String-API
    user_id: str
    applicant_username: str
    purpose: str
    message: str | None = None
    status: str
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    rejection_reason: str | None = None
    created_at: datetime


class RejectPayload(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


def _to_user_out(app) -> AppHostApplicationOut:
    """Vereinte Out-Shape → alte User-Shape (message = notes)."""
    return AppHostApplicationOut(
        id=app.id,
        user_id=app.applicant_user_id,
        purpose=app.purpose,
        message=app.notes,
        status=app.status,  # type: ignore[arg-type]
        reviewed_at=app.reviewed_at,
        rejection_reason=app.rejection_reason,
        created_at=app.created_at,
    )


async def _get_app_host_row(db: SessionDep, app_id: str) -> InstanceApplication:
    """Antrag laden + sicherstellen, dass er WIRKLICH ein App-Host-Antrag ist —
    die alten Pfade dürfen keine VPS-Anträge anfassen (sonst gäbe der
    approve-Wrapper z.B. VPS-Credentials über einen App-Host-Pfad heraus)."""
    try:
        aid = int(app_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")
    row = await db.get(InstanceApplication, aid)
    if row is None or row.origin != "app_host":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")
    return row


# ---------------------------------------------------------------------------
# User-Wrapper
# ---------------------------------------------------------------------------


@router.post(
    "/me/app-host-application",
    response_model=AppHostApplicationOut,
    status_code=status.HTTP_201_CREATED,
)
async def submit_app_host_application(
    payload: AppHostApplicationCreate,
    request: Request,
    db: SessionDep,
) -> AppHostApplicationOut:
    """DEPRECATED — delegiert an den vereinten Submit (origin='app_host')."""
    out = await submit_instance_application(
        InstanceApplicationCreate(
            origin="app_host", purpose=payload.purpose, notes=payload.message
        ),
        request,
        db,
    )
    return _to_user_out(out)


@router.get(
    "/me/app-host-applications",
    response_model=list[AppHostApplicationOut],
)
async def list_my_app_host_applications(
    request: Request,
    db: SessionDep,
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "all"] | None,
        Query(alias="status"),
    ] = None,
) -> list[AppHostApplicationOut]:
    """DEPRECATED — delegiert an die vereinte Liste (origin='app_host')."""
    rows = await list_my_instance_applications(
        request, db, status_filter=status_filter, origin="app_host"
    )
    return [_to_user_out(r) for r in rows]


# ---------------------------------------------------------------------------
# Admin-Wrapper
# ---------------------------------------------------------------------------


@admin_router.get(
    "/app-host-applications",
    response_model=list[AdminAppHostApplicationOut],
)
async def list_app_host_applications(
    db: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "revoked", "all"] | None,
        Query(alias="status"),
    ] = None,
) -> list[AdminAppHostApplicationOut]:
    """DEPRECATED — Admin-Liste in alter Shape (username-hydriert)."""
    stmt = (
        select(InstanceApplication)
        .where(InstanceApplication.origin == "app_host")
        .order_by(InstanceApplication.created_at.desc())
    )
    if status_filter and status_filter != "all":
        stmt = stmt.where(InstanceApplication.status == status_filter)
    rows = (await db.execute(stmt)).scalars().all()
    # Usernames in einem Round-Trip (kein N+1).
    user_ids = list({r.applicant_user_id for r in rows})
    users = (
        (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        if user_ids
        else []
    )
    username_by_id = {u.id: u.username for u in users}
    return [
        AdminAppHostApplicationOut(
            id=str(r.id),
            user_id=str(r.applicant_user_id),
            applicant_username=username_by_id.get(r.applicant_user_id, "(unknown)"),
            purpose=r.purpose,
            message=r.notes,
            status=r.status,
            reviewed_at=r.reviewed_at,
            reviewed_by=str(r.reviewed_by) if r.reviewed_by is not None else None,
            rejection_reason=r.rejection_reason,
            created_at=r.created_at,
        )
        for r in rows
    ]


@admin_router.post("/app-host-applications/{app_id}/approve")
async def approve_app_host_application(
    app_id: str,
    request: Request,
    db: SessionDep,
    actor: Annotated[User, Depends(_require_owner)],
):
    """DEPRECATED — delegiert an den vereinten Approve (app_host-Zweig)."""
    row = await _get_app_host_row(db, app_id)
    return await approve_application(row.id, request, db, actor)


@admin_router.post(
    "/app-host-applications/{app_id}/reject",
    response_model=AdminAppHostApplicationOut,
)
async def reject_app_host_application(
    app_id: str,
    payload: RejectPayload,
    request: Request,
    db: SessionDep,
    actor: Annotated[User, Depends(_require_owner)],
) -> AdminAppHostApplicationOut:
    """DEPRECATED — delegiert an den vereinten Reject, antwortet in alter Shape."""
    row = await _get_app_host_row(db, app_id)
    await reject_application(
        row.id, RejectIn(rejection_reason=payload.reason), request, db, actor
    )
    await db.refresh(row)
    applicant = await db.get(User, row.applicant_user_id)
    return AdminAppHostApplicationOut(
        id=str(row.id),
        user_id=str(row.applicant_user_id),
        applicant_username=applicant.username if applicant else "(unknown)",
        purpose=row.purpose,
        message=row.notes,
        status=row.status,
        reviewed_at=row.reviewed_at,
        reviewed_by=str(row.reviewed_by) if row.reviewed_by is not None else None,
        rejection_reason=row.rejection_reason,
        created_at=row.created_at,
    )
