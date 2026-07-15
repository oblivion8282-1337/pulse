"""Complaint (abuse report) endpoints.

POST /reports                          — public, rate-limited 3/h per IP.
GET  /admin/complaints                 — admin only, filterable by status.
POST /admin/complaints/{id}/acknowledge — admin only, status='acknowledged'.
POST /admin/complaints/{id}/forward     — admin only, emails the operator + status='forwarded'.
POST /admin/complaints/{id}/resolve     — admin only, status='resolved'.

Schemas + lookup/enrichment helpers live in ``complaints_support.py``.
"""

from __future__ import annotations

import hmac
import logging
import smtplib
from datetime import UTC, datetime
from typing import Annotated

import httpx
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.security import JwtSigner, get_signer

from dcc_auth import config as _config
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

# Reserved "Pulse" system user-id — authors automated notices (the reporter's
# "your report was handled" DM). 0 is never a real snowflake, so it can't
# collide; the web client renders it as the neutral "Pulse" sender. Keep in
# sync with the frontend ``SYSTEM_USER_ID``.
PULSE_SYSTEM_USER_ID = 0
_REPORTER_RESOLVED_DM = (
    "Deine Meldung wurde vom Betreiberteam geprüft und bearbeitet. "
    "Danke für deinen Hinweis."
)


def _check_internal_secret(provided: str | None) -> None:
    """Mirror of ``routes_search.py::_check_internal_secret``. Fail-closed when
    the server-side secret is unset."""
    expected = _config.get_settings().internal_service_secret
    if not expected:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret"
        )


class InternalComplaintCreate(BaseModel):
    """Escalation payload from chat-gateway (a community moderator hands a
    guild report up to the platform operator). The body carries the full
    human-readable context (reason, original report, community, escalator),
    so no target is strictly required — but ``target_user_id`` is passed
    whenever the report identifies a user, so the operator's complaint list
    enriches with the reported user's name."""

    body: Annotated[str, Field(min_length=1, max_length=5000)]
    target_user_id: int | None = None
    # Reporter's cloud user-id (server-derived by the trusted caller from its
    # authenticated principal) → enables the automated resolve-DM back to them.
    submitter_user_id: int | None = None


@router.post("/internal/complaints", status_code=status.HTTP_201_CREATED)
async def create_internal_complaint(
    payload: InternalComplaintCreate,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
):
    """Create a complaint on behalf of another service (escalation path).

    Trusted internal caller (chat-gateway) — authenticated by the shared
    internal secret, not a user token. Lands in the operator's complaint
    inbox with ``status='new'`` exactly like a public abuse report.
    """
    _check_internal_secret(x_pulse_internal_secret)

    complaint = Complaint(
        id=next_id(),
        body=payload.body,
        target_user_id=payload.target_user_id,
        submitter_user_id=payload.submitter_user_id,
        status="new",
    )
    session.add(complaint)
    await session.commit()

    await _notify_admins_new_complaint(session)
    return {"id": str(complaint.id), "status": "received"}


# ---------------------------------------------------------------------------
# Public: POST /reports
# ---------------------------------------------------------------------------


async def _notify_admins_new_complaint(session: SessionDep) -> None:
    """Best-effort: tell chat-gateway to live-push a ``complaint_new`` to every
    admin, so the operator's inbox badge + list update without a reload. A
    failure here never affects the complaint that was just created."""
    settings = _config.get_settings()
    secret = settings.internal_service_secret
    if not secret:
        return
    result = await session.execute(select(User.id).where(User.is_admin.is_(True)))
    admin_ids = list(result.scalars())
    if not admin_ids:
        return
    url = settings.chat_gateway_url.rstrip("/") + "/internal/complaint-notify"
    try:
        async with httpx.AsyncClient(
            timeout=settings.chat_gateway_purge_timeout_s
        ) as http:
            await http.post(
                url,
                json={"admin_user_ids": admin_ids},
                headers={"X-Pulse-Internal-Secret": secret},
            )
    except httpx.HTTPError as exc:
        log.warning("complaint_notify_admins_failed: %s", type(exc).__name__)


async def _optional_reporter_id(
    authorization: str | None, session: SessionDep, signer: JwtSigner
) -> int | None:
    """The reporter's user-id from a valid access token, or None.

    NEVER raises (``/reports`` stays anonymous-capable) and NEVER trusts a
    client-supplied body field — this is the ONLY path that may set
    ``submitter_user_id``. A spoofed body value would let an attacker aim the
    automated resolve-DM at an arbitrary user, so the id must come from the
    authenticated principal alone."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = signer.decode(token, expected_type="access")
        uid = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
    user = await session.get(User, uid)
    if user is None or user.disabled or user.is_suspended:
        return None
    return user.id


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def submit_report(
    payload: ComplaintCreate,
    request: Request,
    session: SessionDep,
    authorization: Annotated[str | None, Header()] = None,
    signer: JwtSigner = Depends(get_signer),
):
    """Submit an abuse report. Rate-limited: 3/hour per IP. Auth OPTIONAL.

    At least one of target_url, target_instance_id, or target_user_id must be
    set. When a valid access token is present, the reporter is recorded
    (server-derived, never from the body) so the resolve-DM can reach them.
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
        submitter_user_id=await _optional_reporter_id(authorization, session, signer),
        status="new",
    )
    complaint.target_url = payload.target_url  # type: ignore[assignment]
    session.add(complaint)
    await session.commit()

    await _notify_admins_new_complaint(session)
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


class NotifyUserIn(BaseModel):
    message: Annotated[str, Field(min_length=1, max_length=2000)]


class NotifyUserResult(BaseModel):
    sent: bool
    error: str | None = None


async def _send_operator_dm(
    from_user_id: int, to_user_id: int, content: str
) -> tuple[bool, str | None]:
    """Ask chat-gateway to deliver a gate-free operator→user DM. Returns
    ``(sent, error_tag)``; the error tag is for logging, never the client."""
    settings = _config.get_settings()
    secret = settings.internal_service_secret
    if not secret:
        return False, "no_internal_secret"
    url = settings.chat_gateway_url.rstrip("/") + "/internal/moderation-dm"
    body = {
        "from_user_id": from_user_id,
        "to_user_id": to_user_id,
        "content": content,
    }
    try:
        async with httpx.AsyncClient(
            timeout=settings.chat_gateway_purge_timeout_s
        ) as http:
            resp = await http.post(
                url, json=body, headers={"X-Pulse-Internal-Secret": secret}
            )
    except httpx.HTTPError as exc:
        return False, f"network_error:{type(exc).__name__}"
    if 200 <= resp.status_code < 300:
        return True, None
    return False, f"status_{resp.status_code}"


@router.post("/admin/complaints/{complaint_id}/notify-user", response_model=NotifyUserResult)
async def notify_reported_user(
    complaint_id: int,
    payload: NotifyUserIn,
    session: SessionDep,
    actor: Annotated[User, Depends(_require_admin)],
) -> NotifyUserResult:
    """Send the operator's message to the reported user as a private DM.

    The DM is authored by the acting super-admin and bypasses the friend-gate
    (chat-gateway ``/internal/moderation-dm``). Only valid when the complaint
    names a user (e.g. a reported direct message) — otherwise there's no one to
    notify (400). The complaint status is left untouched; notifying and
    resolving are independent actions.
    """
    complaint = await session.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="complaint not found")
    if complaint.target_user_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="complaint has no reported user to notify",
        )

    sent, error = await _send_operator_dm(
        actor.id, complaint.target_user_id, payload.message
    )
    if not sent:
        log.warning("complaint_notify_user_failed: %s", error)
    return NotifyUserResult(sent=sent, error=error)


@router.post("/admin/complaints/{complaint_id}/resolve")
async def resolve_complaint(
    complaint_id: int,
    payload: ResolveIn,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Mark complaint as resolved.

    When the reporter is a known Cloud user, a confirmation DM goes out from the
    neutral "Pulse" system sender. The operator's ``resolution_note`` becomes
    THAT message when set (so they can tell the reporter what was done); an empty
    note falls back to the standard thank-you. Best-effort: a DM failure never
    undoes the resolve (the status change is already committed).
    """
    complaint = await session.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="complaint not found")

    complaint.status = "resolved"
    complaint.resolution_note = payload.resolution_note
    complaint.resolved_at = datetime.now(UTC)
    reporter_id = complaint.submitter_user_id
    reporter_message = payload.resolution_note.strip() or _REPORTER_RESOLVED_DM
    await session.commit()

    # Only DM a reporter who still exists and is active. ``submitter_user_id``
    # was already validated at submit time (token-derived), but the account may
    # have been deleted/disabled since — re-check so a stale id can't target a
    # recycled or dangling row.
    if reporter_id is not None:
        reporter = await session.get(User, reporter_id)
        if reporter is not None and not reporter.disabled and not reporter.is_suspended:
            sent, error = await _send_operator_dm(
                PULSE_SYSTEM_USER_ID, reporter_id, reporter_message
            )
            if not sent:
                log.warning("complaint_resolve_reporter_dm_failed: %s", error)

    return {"id": str(complaint.id), "status": complaint.status}
