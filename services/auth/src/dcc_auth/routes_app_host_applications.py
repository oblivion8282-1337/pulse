"""User-facing App-Hosting-Antrag endpoints — Stufe 2 (lokal auf Gerät).

POST   /me/app-host-application    -- Antrag auf App-Hosting-Freischaltung
GET    /me/app-host-applications   -- eigene Anträge abrufen

Disjoint zum Server-Hosting-Antrag (``/me/instance-applications``):
App-Hosting läuft auf dem Gerät des Users, es gibt keinen VPS und keinen
Hostname. Approval setzt automatisch ``users.self_host_enabled=true`` (im
Admin-Endpoint ``routes_admin_app_host.py``).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.admin_events import publish_application_pending
from dcc_auth.browser_sessions import validate_session
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_app_host import AppHostApplication
from dcc_auth.snowflake import next_id

router = APIRouter(tags=["self-host"])

ApplicationPurpose = Literal["privat", "verein", "firma", "sonst"]


# ---------------------------------------------------------------------------
# Auth helper (selbe Form wie in routes_instance_applications.py — bewusst
# dupliziert, jede Route-Datei hat ihre eigene Session-Lookup-Logik)
# ---------------------------------------------------------------------------


async def _require_user(request: Request, db) -> User:
    """Validate session cookie → User.  Raises HTTP 401 on failure."""
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


class AppHostApplicationCreate(BaseModel):
    purpose: ApplicationPurpose
    message: str | None = Field(default=None, max_length=2000)


class AppHostApplicationOut(BaseModel):
    id: str  # Snowflake-String-API
    user_id: str
    purpose: str
    message: str | None
    status: Literal["pending", "approved", "rejected"]
    reviewed_at: datetime | None
    rejection_reason: str | None
    created_at: datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _app_to_out(app: AppHostApplication) -> AppHostApplicationOut:
    return AppHostApplicationOut(
        id=str(app.id),
        user_id=str(app.user_id),
        purpose=app.purpose,
        message=app.message,
        status=app.status,  # type: ignore[arg-type]
        reviewed_at=app.reviewed_at,
        rejection_reason=app.rejection_reason,
        created_at=app.created_at,
    )


# ---------------------------------------------------------------------------
# Routes
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
    """Antrag auf App-Hosting-Freischaltung einreichen.

    Gates:
      * ``user.self_host_enabled`` muss ``false`` sein — wer schon freigeschaltet
        ist, braucht keinen Antrag (422).
      * Es darf kein offener ``pending``-Antrag existieren — sonst 409, der
        User wartet auf den alten Antrag.
    """
    user = await _require_user(request, db)

    if user.self_host_enabled:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="self-hosting bereits freigeschaltet",
        )

    # Dedup: ein pending Antrag pro User.
    dup_stmt = select(AppHostApplication).where(
        AppHostApplication.user_id == user.id,
        AppHostApplication.status == "pending",
    )
    dup = (await db.execute(dup_stmt)).scalars().first()
    if dup is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="du hast bereits einen offenen Antrag",
        )

    app = AppHostApplication(
        id=next_id(),
        user_id=user.id,
        purpose=payload.purpose,
        message=payload.message,
        status="pending",
    )
    db.add(app)
    await db.flush()
    await db.commit()
    await db.refresh(app)
    # Erst nach dem Commit: die Admins sollen nichts sehen, was ein
    # zurückgerollter Antrag nie war.
    await publish_application_pending(request, "app_host")
    return _app_to_out(app)


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
    """Eigene App-Hosting-Anträge abrufen, optional nach Status gefiltert."""
    user = await _require_user(request, db)

    stmt = (
        select(AppHostApplication)
        .where(AppHostApplication.user_id == user.id)
        .order_by(AppHostApplication.created_at.desc())
    )
    if status_filter and status_filter != "all":
        stmt = stmt.where(AppHostApplication.status == status_filter)

    rows = (await db.execute(stmt)).scalars().all()
    return [_app_to_out(r) for r in rows]