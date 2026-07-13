"""Admin endpoints for Self-Host instance management (Phase 2.3).

Endpoints
---------
GET  /admin/instances                      -- list registered instances
DELETE /admin/instances/{id}               -- suspend (soft)
POST /admin/instances/{id}/unsuspend
POST /admin/instances/{id}/rotate-secret

Die Antrags-Endpoints (``/admin/instance-applications``) leben seit dem
vereinten Antragssystem (Migration 0044) in ``routes_admin_applications.py``.
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.routes import _require_admin
from dcc_auth.routes_suspended_instances import (
    _get_redis,
    suspended_list_add,
    suspended_list_remove,
)
from dcc_auth.security import hash_password


def _require_cloud() -> None:
    """Gate the whole Self-Host-instance admin surface to the Cloud.

    Approving/suspending Self-Host instances is a cloud-only privilege — the
    Cloud (howispulse.com) is the single authority that decides who may
    self-host. On any non-cloud deployment (``PULSE_INSTANCE_MODE`` defaults to
    ``self-host``) these routes 403, so a self-host admin can't authorise
    further instances. Defense-in-depth alongside the frontend hiding the tab.
    """
    if get_settings().pulse_instance_mode != "cloud":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="self-host instance management is cloud-only",
        )


# Router-level dependency → every route here is cloud-gated (and still
# admin-gated per-route via ``_require_admin``).
router = APIRouter(prefix="/admin", dependencies=[Depends(_require_cloud)])

# --------------------------------------------------------------------------- #
# Pydantic schemas                                                              #
# --------------------------------------------------------------------------- #


_SECRET_WARNING = "Speichere das client_secret jetzt — es wird nicht mehr angezeigt."


class InstanceOut(BaseModel):
    model_config = {"from_attributes": True}

    id: str  # Snowflake-String-API
    hostname: str
    client_id: str
    worker_id_chat: int
    worker_id_voice: int
    worker_id_media: int
    status: str
    registered_at: datetime
    registrar_username: str
    # 'app_host'-Instanzen entstehen automatisch bei der App-Hosting-Approval —
    # das Admin-UI blendet sie in "Self-Host-Instanzen" aus (sie leben im
    # App-Hosting-Anträge-Tab). Ohne das Feld konnte es nicht unterscheiden.
    origin: str = "vps"


class RotateSecretOut(BaseModel):
    instance_id: str  # Snowflake-String-API
    client_secret: str
    warning: str = _SECRET_WARNING


# --------------------------------------------------------------------------- #
# Helpers                                                                       #
# --------------------------------------------------------------------------- #

_SELF_HOST_WORKER_START = 100  # Worker-IDs 1-99 reserviert für Cloud


_WORKER_ID_MAX = 1023  # Snowflake 10-bit-Range


async def _allocate_worker_ids(session) -> tuple[int, int, int]:
    """Find and return the next 3 free worker IDs >= 100.

    Allocates chat/voice/media IDs sequentially starting from the
    current maximum.  The caller holds a FOR UPDATE lock on the
    application row so parallel approvals will serialise here.
    Raises RuntimeError on allocation failure (> 5 retries).
    """
    # Find max of all three worker ID columns
    row = (
        await session.execute(
            select(
                func.max(RegisteredInstance.worker_id_chat).label("mx_chat"),
                func.max(RegisteredInstance.worker_id_voice).label("mx_voice"),
                func.max(RegisteredInstance.worker_id_media).label("mx_media"),
            )
        )
    ).one()

    current_max = max(
        row.mx_chat or 0,
        row.mx_voice or 0,
        row.mx_media or 0,
    )
    base = max(current_max + 1, _SELF_HOST_WORKER_START)

    if base + 2 > _WORKER_ID_MAX:
        raise HTTPException(
            status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
            detail=(
                "worker-id range exhausted (max ~307 Self-Host-Instanzen). "
                "Erweiterung des Snowflake-Worker-ID-Bits in Planung (DE 14)."
            ),
        )

    return base, base + 1, base + 2


# --------------------------------------------------------------------------- #
# 4. GET /admin/instances                                                       #
# --------------------------------------------------------------------------- #


@router.get("/instances", response_model=list[InstanceOut])
async def list_instances(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    status_filter: Annotated[str, Query(alias="status")] = "all",
):
    """List registered instances. Never exposes client_secret."""
    if status_filter not in ("active", "suspended", "deleted", "all"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="status must be active, suspended, deleted or all",
        )
    stmt = (
        select(RegisteredInstance)
        .order_by(RegisteredInstance.registered_at.desc())
        .options(selectinload(RegisteredInstance.registrar))
    )
    if status_filter != "all":
        stmt = stmt.where(RegisteredInstance.status == status_filter)

    rows = (await session.execute(stmt)).scalars().all()
    return [
        InstanceOut(
            id=str(row.id),
            hostname=row.hostname,
            client_id=row.client_id,
            worker_id_chat=row.worker_id_chat,
            worker_id_voice=row.worker_id_voice,
            worker_id_media=row.worker_id_media,
            status=row.status,
            registered_at=row.registered_at,
            # registrar ist NULL, wenn der Owner sein Konto gelöscht hat
            # (Migration 0043: SET NULL statt FK-Blockade).
            registrar_username=row.registrar.username if row.registrar else "(Konto gelöscht)",
            origin=row.origin,
        )
        for row in rows
    ]


# --------------------------------------------------------------------------- #
# 5. DELETE /admin/instances/{id}  (soft-suspend)                              #
# --------------------------------------------------------------------------- #


@router.delete("/instances/{instance_id}", status_code=status.HTTP_204_NO_CONTENT)
async def suspend_instance(
    instance_id: int,
    request: Request,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    reason: Annotated[str | None, Query(max_length=500)] = None,
):
    """Soft-suspend: sets status='suspended', inserts into suspended_instances."""
    instance = await session.get(RegisteredInstance, instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status == "deleted":
        # Vom Owner gelöscht (routes_instance_delete) — Kill-Switch besteht schon.
        raise HTTPException(status.HTTP_409_CONFLICT, detail="instance was deleted by its owner")
    if instance.status == "suspended":
        return  # idempotent

    instance.status = "suspended"
    session.add(
        SuspendedInstance(
            instance_id=instance_id,
            suspended_at=datetime.now(UTC),
            reason=reason,
        )
    )
    await session.commit()

    # Bust the public suspended-instances cache so the next poll sees the change.
    redis = await _get_redis(request)
    if redis is not None:
        await suspended_list_add(redis, instance_id, reason)


# --------------------------------------------------------------------------- #
# 6. POST /admin/instances/{id}/unsuspend                                       #
# --------------------------------------------------------------------------- #


@router.post("/instances/{instance_id}/unsuspend", status_code=status.HTTP_204_NO_CONTENT)
async def unsuspend_instance(
    instance_id: int,
    request: Request,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Unsuspend: sets status='active', removes suspended_instances row."""
    instance = await session.get(RegisteredInstance, instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status == "deleted":
        # Owner-Löschung ist endgültig — der Platzhalter-Hostname (deleted-*.invalid)
        # darf nie wieder aktiv werden.
        raise HTTPException(status.HTTP_409_CONFLICT, detail="instance was deleted by its owner")
    if instance.status == "active":
        return  # idempotent

    instance.status = "active"
    # Remove from suspended_instances via the relationship
    await session.refresh(instance, ["suspended_entry"])
    if instance.suspended_entry is not None:
        await session.delete(instance.suspended_entry)
    await session.commit()

    # Bust the public suspended-instances cache so the next poll sees the change.
    redis = await _get_redis(request)
    if redis is not None:
        await suspended_list_remove(redis, instance_id)


# --------------------------------------------------------------------------- #
# 7. POST /admin/instances/{id}/rotate-secret                                   #
# --------------------------------------------------------------------------- #


@router.post("/instances/{instance_id}/rotate-secret", response_model=RotateSecretOut)
async def rotate_secret(
    instance_id: int,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Generate a new client_secret. Returns plaintext once; old secret invalidated."""
    instance = await session.get(RegisteredInstance, instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status == "deleted":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="instance was deleted by its owner")

    new_secret_plain = secrets.token_urlsafe(32)
    instance.client_secret = await asyncio.to_thread(hash_password, new_secret_plain)
    await session.commit()

    return RotateSecretOut(
        instance_id=str(instance_id),
        client_secret=new_secret_plain,
    )
