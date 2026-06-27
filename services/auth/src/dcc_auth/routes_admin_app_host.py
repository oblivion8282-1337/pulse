"""Cloud-Admin endpoints for App-Hosting-Anträge.

GET    /admin/app-host-applications           -- Liste, default status=pending
POST   /admin/app-host-applications/{id}/approve -- setzt self_host_enabled=true
POST   /admin/app-host-applications/{id}/reject  -- mit reason, setzt status=rejected

Cloud-only (Self-Host-Instanzen dürfen keine User-App-Hosting-Approval geben),
analog zu ``routes_admin_instances`` — die Cloud ist die einzige Instanz, die
Self-Hosting-Privilegien vergibt.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_app_host import AppHostApplication
from dcc_auth.routes import _require_admin
from dcc_auth.routes_admin import _audit


def _require_cloud() -> None:
    """App-Hosting-Freischaltung ist Cloud-only.

    Self-Hosts dürfen keine User-Approval geben — sonst könnten Self-Host-Admins
    sich gegenseitig befördern. Defense-in-depth neben dem Frontend, das den
    Tab ohnehin nur auf Cloud-Instanzen rendert (CLAUDE.md → ``routes_admin``).
    """
    if get_settings().pulse_instance_mode != "cloud":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="app-hosting approval is cloud-only",
        )


# Router-level dependency → jeder Route hier ist cloud-gated (und per-Route
# zusätzlich admin-gated via ``_require_admin``).
router = APIRouter(prefix="/admin", dependencies=[Depends(_require_cloud)])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class AdminAppHostApplicationOut(BaseModel):
    """Trägt applicant_username für die Admin-Liste."""

    model_config = {"from_attributes": True}

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


class ApproveOut(BaseModel):
    id: str  # Snowflake-String-API
    user_id: str
    self_host_enabled: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _hydrate_applicant_usernames(
    db: SessionDep, apps: list[AppHostApplication]
) -> list[AdminAppHostApplicationOut]:
    """Lädt die Usernames der Antragsteller in einem Round-Trip.

    Snowflake-IDs sind immer als String in der API — wir konvertieren nur für
    den IN-Lookup zurück. Spart N+1-Queries bei langen Listen.
    """
    if not apps:
        return []
    user_ids = list({a.user_id for a in apps})
    user_rows = (
        await db.execute(select(User).where(User.id.in_(user_ids)))
    ).scalars().all()
    username_by_id = {u.id: u.username for u in user_rows}
    out = []
    for a in apps:
        out.append(
            AdminAppHostApplicationOut(
                id=str(a.id),
                user_id=str(a.user_id),
                applicant_username=username_by_id.get(a.user_id, "(unknown)"),
                purpose=a.purpose,
                message=a.message,
                status=a.status,
                reviewed_at=a.reviewed_at,
                reviewed_by=str(a.reviewed_by) if a.reviewed_by is not None else None,
                rejection_reason=a.rejection_reason,
                created_at=a.created_at,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "/app-host-applications",
    response_model=list[AdminAppHostApplicationOut],
)
async def list_app_host_applications(
    db: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "all"] | None,
        Query(alias="status"),
    ] = None,
) -> list[AdminAppHostApplicationOut]:
    """Liste App-Hosting-Anträge, default pending.

    Admin-Panel nutzt diesen Endpoint zum Rendern der Tab-Liste. Approve/Reject
    sind separate POSTs.
    """
    stmt = select(AppHostApplication).order_by(AppHostApplication.created_at.desc())
    if status_filter and status_filter != "all":
        stmt = stmt.where(AppHostApplication.status == status_filter)
    rows = (await db.execute(stmt)).scalars().all()
    return await _hydrate_applicant_usernames(db, rows)


@router.post(
    "/app-host-applications/{app_id}/approve",
    response_model=ApproveOut,
)
async def approve_app_host_application(
    app_id: str,
    db: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
) -> ApproveOut:
    """Antrag genehmigen → setzt self_host_enabled=true im selben Tx.

    Setzt voraus, dass der Antrag noch ``pending`` ist. Nach Approval ist ein
    zweiter Approve 409 (idempotente Ablehnung).
    """
    try:
        aid = int(app_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")

    app = await db.get(AppHostApplication, aid, with_for_update=True)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")
    if app.status != "pending":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Antrag ist bereits '{app.status}'",
        )

    target_user = await db.get(User, app.user_id)
    if target_user is None:
        # User wurde gelöscht, während der Antrag offen war — CASCADE hat
        # den Antrag aber schon weg sein sollen. Defensive 404.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User nicht gefunden")

    now = datetime.now(UTC)
    app.status = "approved"
    app.reviewed_at = now
    app.reviewed_by = actor.id

    was_enabled = target_user.self_host_enabled
    target_user.self_host_enabled = True

    _audit(
        db,
        actor_id=actor.id,
        action="app_host_application.approve",
        target_id=target_user.id,
        payload={"application_id": app.id, "was_enabled": was_enabled},
    )

    await db.commit()
    await db.refresh(app)

    return ApproveOut(
        id=str(app.id),
        user_id=str(target_user.id),
        self_host_enabled=target_user.self_host_enabled,
    )


@router.post(
    "/app-host-applications/{app_id}/reject",
    response_model=AdminAppHostApplicationOut,
)
async def reject_app_host_application(
    app_id: str,
    payload: RejectPayload,
    db: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
) -> AdminAppHostApplicationOut:
    """Antrag ablehnen — bleibt sichtbar mit reason, User kann erneut stellen.

    Reject lässt ``self_host_enabled`` unverändert (false). Damit kann der User
    nach Adressieren der Begründung einen neuen Antrag stellen.
    """
    try:
        aid = int(app_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")

    app = await db.get(AppHostApplication, aid, with_for_update=True)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")
    if app.status != "pending":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Antrag ist bereits '{app.status}'",
        )

    now = datetime.now(UTC)
    app.status = "rejected"
    app.reviewed_at = now
    app.reviewed_by = actor.id
    app.rejection_reason = payload.reason

    _audit(
        db,
        actor_id=actor.id,
        action="app_host_application.reject",
        target_id=app.user_id,
        payload={"application_id": app.id, "reason": payload.reason},
    )

    await db.commit()
    await db.refresh(app)

    out = await _hydrate_applicant_usernames(db, [app])
    return out[0]