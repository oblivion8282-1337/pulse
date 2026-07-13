"""Cloud-Admin: eine erteilte App-Hosting-Freischaltung zurücknehmen.

POST /admin/app-host-applications/{id}/revoke

Eigenes Modul (statt ``routes_admin_app_host.py`` zu erweitern) wegen der
Größen-Policy; teilt sich die Guards mit den Nachbar-Routen.

Warum ein eigener Endpoint statt "reject auf einem approved Antrag":
Approval hat drei Wirkungen (Flag, auto-provisionierte Instanz, Antragsstatus),
und alle drei müssen zurückgenommen werden. Ein bloßer Statuswechsel ließe den
User weiter hosten. Konkret:

1. ``users.self_host_enabled = false`` — kein Download/Start mehr.
2. Die auto-provisionierten ``origin='app_host'``-Instanzen des Users werden
   **suspendiert** (nicht gelöscht): der Kill-Switch über die öffentliche
   ``pulse-suspended-instances``-Liste stoppt einen noch laufenden Container,
   auch wenn der Owner sein Volume nie anfasst. Löschen wäre unumkehrbar und
   verbrennt die Worker-IDs.
3. ``status='revoked'`` — der Antrag ist Historie; der User kann einen neuen
   stellen (der Duplicate-Guard prüft nur auf ``pending``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceApplication,
    RegisteredInstance,
    SuspendedInstance,
)
from dcc_auth.routes import _require_owner
from dcc_auth.routes_admin import _audit
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_suspended_instances import _get_redis, suspended_list_add

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(_require_cloud)])


@router.post(
    "/app-host-applications/{app_id}/revoke",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_app_host_application(
    app_id: str,
    request: Request,
    db: SessionDep,
    actor: Annotated[User, Depends(_require_owner)],
    reason: Annotated[str | None, Query(max_length=500)] = None,
) -> None:
    """Freischaltung zurücknehmen: Flag aus, App-Host-Instanzen suspendiert."""
    try:
        aid = int(app_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")

    app = await db.get(InstanceApplication, aid, with_for_update=True)
    # Nur App-Host-Anträge sind revokebar — VPS-Instanzen suspendiert der Admin
    # direkt über /admin/instances/{id} (404 statt 403 gegen Enumeration).
    if app is None or app.origin != "app_host":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Antrag nicht gefunden")
    if app.status != "approved":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"nur genehmigte Anträge sind zurücknehmbar (ist '{app.status}')",
        )

    target_user = await db.get(User, app.applicant_user_id)
    if target_user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User nicht gefunden")

    rows = (
        await db.execute(
            select(RegisteredInstance).where(
                RegisteredInstance.registered_by == target_user.id,
                RegisteredInstance.origin == "app_host",
                RegisteredInstance.status == "active",
            )
        )
    ).scalars().all()

    now = datetime.now(UTC)
    suspended_ids = [row.id for row in rows]
    for row in rows:
        row.status = "suspended"
        db.add(SuspendedInstance(instance_id=row.id, suspended_at=now, reason=reason))

    app.status = "revoked"
    app.reviewed_at = now
    app.reviewed_by = actor.id
    app.rejection_reason = reason
    target_user.self_host_enabled = False

    _audit(
        db,
        actor_id=actor.id,
        action="app_host_application.revoke",
        target_id=target_user.id,
        payload={
            "application_id": app.id,
            "suspended_instance_ids": suspended_ids,
            "reason": reason,
        },
    )
    await db.commit()

    # Erst nach dem Commit: der Kill-Switch darf nichts stoppen, was ein
    # zurückgerollter Vorgang nie suspendiert hat.
    redis = await _get_redis(request)
    if redis is not None:
        for instance_id in suspended_ids:
            await suspended_list_add(redis, instance_id, reason)
