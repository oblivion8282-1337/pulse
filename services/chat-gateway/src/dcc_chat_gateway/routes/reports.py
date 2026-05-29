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

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Report
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()

_VALID_REASON_CODES = {"spam", "harassment", "illegal", "csam", "other"}


class ReportCreate(BaseModel):
    target_message_id: SnowflakeId | None = None
    target_user_id: SnowflakeId | None = None
    target_channel_id: SnowflakeId | None = None
    reason_code: Literal["spam", "harassment", "illegal", "csam", "other"]
    body: str = Field(min_length=10, max_length=5000)


class ReportOut(BaseModel):
    id: str
    status: str


@router.post("/reports", response_model=ReportOut, status_code=status.HTTP_201_CREATED)
async def create_report(
    payload: ReportCreate,
    session: SessionDep,
    current: CurrentUser,
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
        reason_code=payload.reason_code,
        body=payload.body,
        status="new",
    )
    session.add(report)
    await session.commit()
    await session.refresh(report)
    # Response contract returns the literal "received" (a user-facing receipt
    # confirmation), NOT the internal moderation-queue status (which starts at
    # "new"). Keep these distinct — the frontend + tests rely on "received".
    return ReportOut(id=str(report.id), status="received")
