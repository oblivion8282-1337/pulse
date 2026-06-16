"""Complaint (abuse report) endpoints.

POST /reports                          — public, rate-limited 3/h per IP.
GET  /admin/complaints                 — admin only, filterable by status.
POST /admin/complaints/{id}/acknowledge — admin only, status='acknowledged'.
POST /admin/complaints/{id}/forward     — admin only, emails the operator + status='forwarded'.
POST /admin/complaints/{id}/resolve     — admin only, status='resolved'.

Schemas + lookup/enrichment helpers live in ``complaints_support.py``.
"""

from __future__ import annotations

import logging
import smtplib
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select

from dcc_auth.complaints_support import (
    VALID_STATUSES,
    ComplaintCreate,
    ComplaintOut,
    ForwardIn,
    ForwardResult,
    ResolveIn,
    enrich_complaints,
    resolve_operator,
)
from dcc_auth.db import SessionDep
from dcc_auth.email import (
    compose_complaint_forward_email,
    resolve_smtp_config,
    send_email,
)
from dcc_auth.models import User
from dcc_auth.models_instances import Complaint
from dcc_auth.routes import _check_rate, _require_admin
from dcc_auth.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()


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
    """List complaints filtered by status. Newest-first, snowflake-cursor.

    Each row is enriched (instance hostname, operator contact, reported user
    name) so the admin sees who a complaint is about and whether forwarding is
    even possible.
    """
    if complaint_status not in VALID_STATUSES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status must be one of {sorted(VALID_STATUSES)}",
        )

    stmt = (
        select(Complaint)
        .where(Complaint.status == complaint_status)
        .order_by(Complaint.id.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Complaint.id < before)

    rows = list((await session.execute(stmt)).scalars().all())
    return await enrich_complaints(session, rows)


# ---------------------------------------------------------------------------
# Admin: POST /admin/complaints/{id}/acknowledge
# ---------------------------------------------------------------------------


@router.post("/admin/complaints/{complaint_id}/acknowledge")
async def acknowledge_complaint(
    complaint_id: int,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Mark a complaint as acknowledged ("we're looking at this")."""
    complaint = await session.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="complaint not found")

    complaint.status = "acknowledged"
    await session.commit()
    return {"id": str(complaint.id), "status": complaint.status}


# ---------------------------------------------------------------------------
# Admin: POST /admin/complaints/{id}/forward
# ---------------------------------------------------------------------------


@router.post("/admin/complaints/{complaint_id}/forward", response_model=ForwardResult)
async def forward_complaint(
    complaint_id: int,
    payload: ForwardIn,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
) -> ForwardResult:
    """Forward a complaint to the instance operator and mark it forwarded.

    Sends an email to the operator's contact address (resolved from the approved
    instance application) with the Cloud moderation's notice + the complaint
    details. The status is advanced regardless of email outcome — the admin's
    decision is recorded — but ``email_sent``/``email_error`` tell the UI whether
    the notice actually went out. Never logs the notice text or recipient body.
    """
    complaint = await session.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="complaint not found")

    hostname, operator_email = await resolve_operator(session, complaint.target_instance_id)

    email_sent = False
    email_error: str | None = None

    if operator_email is None:
        email_error = "no_operator_email"
    elif (await resolve_smtp_config(session)) is None:
        email_error = "smtp_not_configured"
    else:
        subject, body = compose_complaint_forward_email(
            hostname or "(unbekannt)",
            complaint.body,
            complaint.target_url,
            payload.notice_text,
        )
        try:
            await send_email(operator_email, subject, body, session=session)
            email_sent = True
        except (smtplib.SMTPException, OSError) as exc:
            email_error = type(exc).__name__
            log.warning("complaint_forward_email_failed: %s", type(exc).__name__)

    complaint.status = "forwarded"
    complaint.forwarded_at = datetime.now(UTC)
    complaint.forwarded_to_email = operator_email if email_sent else None
    complaint.forward_notice = payload.notice_text
    await session.commit()

    return ForwardResult(
        id=str(complaint.id),
        status=complaint.status,
        email_sent=email_sent,
        email_error=email_error,
        forwarded_to_email=operator_email if email_sent else None,
    )


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
