"""Report submission endpoint.

Endpoints:
  * ``POST /reports`` — authenticated user files a moderation report.

Rate-limited to 10 reports per hour per user (in-process token bucket,
same pattern as ``ratelimit.check("message", ...)``) so the queue
doesn't get flooded.  Target cross-guild scope is intentional — the
reporter doesn't necessarily know which guild a user_id belongs to;
the mod-queue routes handle scoping to the reviewing guild.
"""

from __future__ import annotations

from typing import Literal

from dcc_shared.events import ReportNewEvent
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.complaint_escalate import (
    EscalationUnavailable,
    escalate_report_to_operator,
)
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    DirectMessageChannel,
    Message,
    MessageAttachment,
    Report,
)
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()

_VALID_REASON_CODES = {"spam", "harassment", "illegal", "csam", "other"}
_REASON_LABELS = {
    "spam": "Spam",
    "harassment": "Belästigung",
    "illegal": "Illegal",
    "csam": "CSAM",
    "other": "Sonstiges",
}


class ReportCreate(BaseModel):
    target_message_id: SnowflakeId | None = None
    target_user_id: SnowflakeId | None = None
    target_channel_id: SnowflakeId | None = None
    # Pins a user report to the community it was raised in (member-list report),
    # so it doesn't fan out to every guild the target belongs to.
    target_guild_id: SnowflakeId | None = None
    reason_code: Literal["spam", "harassment", "illegal", "csam", "other"]
    # Free-text is optional — the reason_code carries the essential category.
    body: str = Field(default="", max_length=5000)


class ReportOut(BaseModel):
    id: str
    status: str


@router.post("/reports", response_model=ReportOut, status_code=status.HTTP_201_CREATED)
async def create_report(
    payload: ReportCreate,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> ReportOut:
    """File a moderation report.

    At least one of ``target_message_id``, ``target_user_id``, or
    ``target_channel_id`` must be set — a report with no target is a 422.
    Rate-limited to 10 per hour per user.
    """
    if (
        payload.target_message_id is None
        and payload.target_user_id is None
        and payload.target_channel_id is None
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="at least one target (message, user, or channel) is required",
        )

    if not ratelimit.check("report", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too many reports — try again later",
        )

    report = Report(
        id=next_id(),
        reporter_user_id=current.id,
        target_message_id=payload.target_message_id,
        target_user_id=payload.target_user_id,
        target_channel_id=payload.target_channel_id,
        target_guild_id=payload.target_guild_id,
        reason_code=payload.reason_code,
        body=payload.body,
        status="new",
    )
    session.add(report)
    await session.commit()
    await session.refresh(report)

    # Notify moderators of every affected guild (live badge + toast). The
    # guild:events listener narrows delivery to mod-perm holders, and the
    # envelope carries no PII (only reason_code + ids). Published AFTER commit
    # so the report row is durable before any moderator can act on the push.
    manager = getattr(request.app.state, "connection_manager", None)
    if manager is not None:
        from dcc_chat_gateway.routes.mod_queue import guilds_for_report

        for gid in await guilds_for_report(session, report):
            await manager.publish_guild_event(
                ReportNewEvent(
                    guild_id=str(gid),
                    report_id=str(report.id),
                    reason_code=report.reason_code,
                )
            )

    # Response contract returns the literal "received" (a user-facing receipt
    # confirmation), NOT the internal moderation-queue status (which starts at
    # "new"). Keep these distinct — the frontend + tests rely on "received".
    return ReportOut(id=str(report.id), status="received")


class OperatorReportCreate(BaseModel):
    target_message_id: SnowflakeId
    reason_code: Literal["spam", "harassment", "illegal", "csam", "other"]
    # Reporter's own description — optional (the reason_code carries the category).
    body: str = Field(default="", max_length=5000)


@router.post(
    "/operator-reports", response_model=ReportOut, status_code=status.HTTP_201_CREATED
)
async def create_operator_report(
    payload: OperatorReportCreate,
    session: SessionDep,
    current: CurrentUser,
) -> ReportOut:
    """Report a direct-message to the platform operator.

    A reported DM has no community moderator, so it goes to the operator's
    complaint inbox. The reported message's TEXT is snapshotted **server-side**
    (authoritative — never client-supplied, so it can't be spoofed to frame
    someone) so the operator can judge context. Any image/attachment is
    deliberately WITHHELD — only noted as present — so the operator is never
    shown potentially illegal media (CSAM safety).

    Authorization: the caller must be a participant of the conversation — you
    can't report a DM you're not part of. Rate-limited like ``/reports``.
    """
    msg = await session.get(Message, int(payload.target_message_id))
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="message not found")
    dm = await session.get(DirectMessageChannel, msg.channel_id)
    if dm is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="not a direct message"
        )
    if current.id not in (dm.user_a_id, dm.user_b_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="not a participant of this conversation"
        )
    if not ratelimit.check("report", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="too many reports — try again later"
        )

    # Authoritative attachment check (any live attachment → withhold + note it).
    has_attachment = (
        await session.scalar(
            select(MessageAttachment.id).where(
                MessageAttachment.message_id == msg.id,
                MessageAttachment.deleted_at.is_(None),
            )
        )
    ) is not None

    label = _REASON_LABELS.get(payload.reason_code, payload.reason_code)
    parts: list[str] = []
    if payload.body:
        parts.append(payload.body)
    parts.append(f"[Grund: {label}, gemeldete Direktnachricht]")
    parts.append("— Gemeldete Nachricht —")
    parts.append((msg.content or "(kein Text)")[:3000])
    if has_attachment:
        parts.append("[Bild/Anhang — aus Sicherheitsgründen nicht angezeigt]")
    complaint_body = "\n".join(parts)

    try:
        complaint_id = await escalate_report_to_operator(
            complaint_body,
            target_user_id=msg.author_id,
            submitter_user_id=current.id,
        )
    except EscalationUnavailable as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail="could not reach the operator inbox — try again later",
        ) from exc

    return ReportOut(id=complaint_id, status="received")
