"""Admin endpoints for Self-Host instance management (Phase 2.3).

Endpoints
---------
GET  /admin/instance-applications          -- list applications by status
POST /admin/instance-applications/{id}/approve
POST /admin/instance-applications/{id}/reject
GET  /admin/instances                      -- list registered instances
DELETE /admin/instances/{id}               -- suspend (soft)
POST /admin/instances/{id}/unsuspend
POST /admin/instances/{id}/rotate-secret
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import (
    InstanceApplication,
    RegisteredInstance,
    SuspendedInstance,
)
from dcc_auth.models import User
from dcc_auth.routes import _require_admin
from dcc_auth.routes_suspended_instances import (
    _get_redis,
    suspended_list_add,
    suspended_list_remove,
)
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id


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


class ApplicationOut(BaseModel):
    model_config = {"from_attributes": True}

    id: str  # Snowflake-String-API
    hostname: str
    purpose: str
    expected_users: int
    contact_email: str
    notes: str | None = None
    status: str
    created_at: datetime
    applicant_username: str


_SECRET_WARNING = "Speichere das client_secret jetzt — es wird nicht mehr angezeigt."


class ApprovalOut(BaseModel):
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


class RejectIn(BaseModel):
    rejection_reason: Annotated[str, Field(max_length=1000)]


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


class RotateSecretOut(BaseModel):
    instance_id: str  # Snowflake-String-API
    client_secret: str
    warning: str = _SECRET_WARNING


# --------------------------------------------------------------------------- #
# Helpers                                                                       #
# --------------------------------------------------------------------------- #

_SELF_HOST_WORKER_START = 100  # Worker-IDs 1-99 reserviert für Cloud


def _stamp_review(app_row: InstanceApplication, actor: User) -> None:
    """Set reviewed_by / reviewed_at on an application row."""
    app_row.reviewed_by = actor.id
    app_row.reviewed_at = datetime.now(UTC)


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
# 1. GET /admin/instance-applications                                           #
# --------------------------------------------------------------------------- #


@router.get("/instance-applications", response_model=list[ApplicationOut])
async def list_applications(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    status_filter: Annotated[str, Query(alias="status")] = "pending",
):
    """List applications, sorted oldest-first."""
    if status_filter not in ("pending", "approved", "rejected"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="status must be pending, approved or rejected",
        )
    stmt = (
        select(InstanceApplication)
        .where(InstanceApplication.status == status_filter)
        .order_by(InstanceApplication.created_at.asc())
        .options(selectinload(InstanceApplication.applicant))
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [
        ApplicationOut(
            id=str(row.id),
            hostname=row.hostname,
            purpose=row.purpose,
            expected_users=row.expected_users,
            contact_email=row.contact_email,
            notes=row.notes,
            status=row.status,
            created_at=row.created_at,
            applicant_username=row.applicant.username,
        )
        for row in rows
    ]


# --------------------------------------------------------------------------- #
# 2. POST /admin/instance-applications/{app_id}/approve                        #
# --------------------------------------------------------------------------- #


@router.post("/instance-applications/{app_id}/approve", response_model=ApprovalOut)
async def approve_application(
    app_id: int,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    """Approve an application, create the RegisteredInstance, allocate worker IDs."""
    # Generate credentials once — hash is independent of worker IDs / DB row.
    client_id = secrets.token_urlsafe(16)
    client_secret_plain = secrets.token_urlsafe(32)
    client_secret_hash = await asyncio.to_thread(hash_password, client_secret_plain)

    # Retry loop for worker-ID UNIQUE conflicts (max 5 attempts)
    for attempt in range(5):
        # SELECT FOR UPDATE — serialises parallel approvals
        app_row = await session.get(
            InstanceApplication,
            app_id,
            with_for_update=True,
        )
        if app_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="application not found")

        if app_row.status == "approved":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="application already approved — credentials were shown once at approval time",
            )
        if app_row.status == "rejected":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="application was rejected; cannot approve a rejected application",
            )

        # Allocate worker IDs
        wid_chat, wid_voice, wid_media = await _allocate_worker_ids(session)

        instance_id = next_id()
        instance = RegisteredInstance(
            id=instance_id,
            hostname=app_row.hostname,
            client_id=client_id,
            client_secret=client_secret_hash,
            worker_id_chat=wid_chat,
            worker_id_voice=wid_voice,
            worker_id_media=wid_media,
            status="active",
            registered_by=app_row.applicant_user_id,
        )
        session.add(instance)

        app_row.status = "approved"
        _stamp_review(app_row, actor)
        app_row.approved_instance_id = instance_id

        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            if attempt == 4:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="worker-id allocation conflict, try again",
                )

        return ApprovalOut(
            instance_id=str(instance_id),
            hostname=app_row.hostname,
            client_id=client_id,
            client_secret=client_secret_plain,
            worker_id_chat=wid_chat,
            worker_id_voice=wid_voice,
            worker_id_media=wid_media,
            owner_user_id=str(app_row.applicant_user_id),
        )

    # unreachable: loop only exits via return/raise
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="approval failed")


# --------------------------------------------------------------------------- #
# 3. POST /admin/instance-applications/{app_id}/reject                         #
# --------------------------------------------------------------------------- #


@router.post("/instance-applications/{app_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
async def reject_application(
    app_id: int,
    body: RejectIn,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
):
    """Reject a pending application. Idempotent: already-rejected → 409."""
    app_row = await session.get(InstanceApplication, app_id, with_for_update=True)
    if app_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="application not found")
    if app_row.status == "rejected":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="application already rejected")
    if app_row.status == "approved":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="application already approved; cannot reject",
        )

    app_row.status = "rejected"
    _stamp_review(app_row, actor)
    app_row.rejection_reason = body.rejection_reason
    await session.commit()


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
    if status_filter not in ("active", "suspended", "all"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="status must be active, suspended or all",
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
            registrar_username=row.registrar.username,
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

    new_secret_plain = secrets.token_urlsafe(32)
    instance.client_secret = await asyncio.to_thread(hash_password, new_secret_plain)
    await session.commit()

    return RotateSecretOut(
        instance_id=str(instance_id),
        client_secret=new_secret_plain,
    )
