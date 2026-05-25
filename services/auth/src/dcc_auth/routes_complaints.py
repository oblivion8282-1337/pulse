"""Complaint (abuse report) endpoints.

POST /reports                      — public, rate-limited 3/h per IP.
GET  /admin/complaints             — admin only, filterable by status.
POST /admin/complaints/{id}/forward — admin only, set status='forwarded'.
POST /admin/complaints/{id}/resolve — admin only, set status='resolved'.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import Complaint, RegisteredInstance
from dcc_auth.routes import _check_rate, _require_admin
from dcc_auth.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()

# Snowflake validator: accept int or digit-string.
SnowflakeId = int | str

_VALID_STATUSES = {"new", "acknowledged", "forwarded", "resolved"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ComplaintCreate(BaseModel):
    body: Annotated[str, Field(min_length=10, max_length=5000)]
    target_url: Annotated[str | None, Field(default=None, max_length=500)] = None
    target_instance_id: int | None = None
    target_user_id: int | None = None
    submitter_email: EmailStr | None = None


class ComplaintOut(BaseModel):
    id: str
    status: str
    submitted_at: datetime
    body: str
    target_url: str | None = None
    target_instance_id: str | None = None
    target_user_id: str | None = None
    submitter_email: str | None = None
    resolution_note: str | None = None
    resolved_at: datetime | None = None

    @classmethod
    def from_row(cls, row: Complaint) -> "ComplaintOut":
        return cls(
            id=str(row.id),
            status=row.status,
            submitted_at=row.submitted_at,
            body=row.body,
            target_url=row.target_url,
            target_instance_id=(
                str(row.target_instance_id) if row.target_instance_id is not None else None
            ),
            target_user_id=(
                str(row.target_user_id) if row.target_user_id is not None else None
            ),
            submitter_email=row.submitter_email,
            resolution_note=row.resolution_note,
            resolved_at=row.resolved_at,
        )


class ForwardIn(BaseModel):
    notice_text: str


class ResolveIn(BaseModel):
    resolution_note: str


# ---------------------------------------------------------------------------
# Public: POST /reports
# ---------------------------------------------------------------------------


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def submit_report(
    payload: ComplaintCreate,
    request: Request,
    session: SessionDep,
):
    """Submit an abuse report. Rate-limited: 3/hour per IP. No auth required.

    At least one of target_url, target_instance_id, or target_user_id must be set.
    """
    await _check_rate(request, "reports_submit", "3/hour")

    if (
        payload.target_url is None
        and payload.target_instance_id is None
        and payload.target_user_id is None
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="at least one of target_url, target_instance_id, or target_user_id is required",
        )

    complaint = Complaint(
        id=next_id(),
        body=payload.body,
        target_instance_id=payload.target_instance_id,
        target_user_id=payload.target_user_id,
        submitter_email=str(payload.submitter_email) if payload.submitter_email else None,
        status="new",
    )
    complaint.target_url = payload.target_url  # type: ignore[assignment]
    session.add(complaint)
    await session.commit()

    return {"id": str(complaint.id), "status": "received"}


# ---------------------------------------------------------------------------
# Admin: GET /admin/complaints
# ---------------------------------------------------------------------------


@router.get("/admin/complaints")
async def list_complaints(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    complaint_status: Annotated[str, Query(alias="status")] = "new",
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[ComplaintOut]:
    """List complaints filtered by status. Newest-first, snowflake-cursor."""
    if complaint_status not in _VALID_STATUSES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status must be one of {sorted(_VALID_STATUSES)}",
        )

    stmt = (
        select(Complaint)
        .where(Complaint.status == complaint_status)
        .order_by(Complaint.id.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Complaint.id < before)

    rows = (await session.execute(stmt)).scalars().all()
    return [ComplaintOut.from_row(r) for r in rows]


# ---------------------------------------------------------------------------
# Admin: POST /admin/complaints/{id}/forward
# ---------------------------------------------------------------------------


@router.post("/admin/complaints/{complaint_id}/forward")
async def forward_complaint(
    complaint_id: int,
    payload: ForwardIn,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Mark complaint as forwarded to the instance operator.

    # FIXME(Phase-5): Actually send an email to the Self-Host admin at
    # instance.contact_email. Currently only updates status + logs the
    # notice_text so the audit trail exists. Requires SMTP + instance
    # contact-email field (not yet in RegisteredInstance model).
    """
    complaint = await session.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="complaint not found")

    complaint.status = "forwarded"
    # Store notice_text in resolution_note as interim until Phase-5 email is built.
    complaint.resolution_note = payload.notice_text
    await session.commit()

    log.info(
        "complaint %s forwarded; notice_text length=%d",
        complaint_id,
        len(payload.notice_text),
    )
    return {"id": str(complaint.id), "status": complaint.status}


# ---------------------------------------------------------------------------
# Admin: POST /admin/complaints/{id}/resolve
# ---------------------------------------------------------------------------


@router.post("/admin/complaints/{complaint_id}/resolve")
async def resolve_complaint(
    complaint_id: int,
    payload: ResolveIn,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Mark complaint as resolved."""
    complaint = await session.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="complaint not found")

    complaint.status = "resolved"
    complaint.resolution_note = payload.resolution_note
    complaint.resolved_at = datetime.now(UTC)
    await session.commit()

    return {"id": str(complaint.id), "status": complaint.status}
