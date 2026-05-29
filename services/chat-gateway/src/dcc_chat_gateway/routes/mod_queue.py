"""Mod-queue and audit-log endpoints for guild moderators.

Endpoints:
  * ``GET  /guilds/{guild_id}/mod-queue``              — list reports (MANAGE_MESSAGES | BAN_MEMBERS | MANAGE_GUILD)
  * ``POST /guilds/{guild_id}/mod-queue/{report_id}/resolve`` — resolve a report (same perm)
  * ``GET  /guilds/{guild_id}/mod-audit-log``           — audit trail (MANAGE_GUILD only)

Cross-guild leak prevention
---------------------------
Reports are guild-scoped by JOIN:
  * If ``target_channel_id`` is set → only if the channel belongs to this guild.
  * If only ``target_user_id`` is set → only if the user is a member of this guild.
  * If ``target_message_id`` is set → join via the message's channel to this guild.

Queries use an OR chain so reports that set more than one target field
still appear exactly once per guild they belong to.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Channel, GuildMember, Message, Report
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()

_MOD_PERMS = (
    Permissions.MANAGE_MESSAGES | Permissions.BAN_MEMBERS | Permissions.MANAGE_GUILD
)


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------


class ReportItem(BaseModel):
    id: str
    reporter_user_id: str
    target_message_id: str | None
    target_user_id: str | None
    target_channel_id: str | None
    reason_code: str
    body: str
    status: str
    created_at: datetime
    resolver_user_id: str | None
    resolved_at: datetime | None
    resolution_note: str | None


class ResolveIn(BaseModel):
    resolution: Literal["resolved", "dismissed"]
    action_type: str | None = None
    target_kind: Literal["user", "channel", "role", "message"] | None = None
    target_id: SnowflakeId | None = None
    resolution_note: str | None = Field(default=None, max_length=2000)


class AuditLogItem(BaseModel):
    id: str
    guild_id: str
    actor_user_id: str
    action_type: str
    target_kind: str | None
    target_id: str | None
    payload: dict | None
    created_at: datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _report_to_out(r: Report) -> ReportItem:
    return ReportItem(
        id=str(r.id),
        reporter_user_id=str(r.reporter_user_id),
        target_message_id=str(r.target_message_id) if r.target_message_id else None,
        target_user_id=str(r.target_user_id) if r.target_user_id else None,
        target_channel_id=str(r.target_channel_id) if r.target_channel_id else None,
        reason_code=r.reason_code,
        body=r.body,
        status=r.status,
        created_at=r.created_at,
        resolver_user_id=str(r.resolver_user_id) if r.resolver_user_id else None,
        resolved_at=r.resolved_at,
        resolution_note=r.resolution_note,
    )


async def _has_any_mod_perm(session, current, guild_id: int) -> None:
    """403 if caller lacks *every* mod permission (needs any one of three)."""
    from dcc_chat_gateway.permissions import resolve_permissions
    from dcc_shared.permission_resolver import has_permission

    bits = await resolve_permissions(session, current, guild_id)
    if not (
        has_permission(bits, Permissions.MANAGE_MESSAGES)
        or has_permission(bits, Permissions.BAN_MEMBERS)
        or has_permission(bits, Permissions.MANAGE_GUILD)
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="missing permission: MANAGE_MESSAGES or BAN_MEMBERS or MANAGE_GUILD",
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/guilds/{guild_id}/mod-queue", response_model=list[ReportItem])
async def list_mod_queue(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    queue_status: str = Query(default="new", alias="status"),
) -> list[ReportItem]:
    """Return reports scoped to this guild, filtered by status.

    A report is in scope when *any* of its targets belongs to this guild:
      - target_channel_id → channel's guild_id matches
      - target_message_id → message's channel's guild_id matches
      - target_user_id only → user is a member of this guild
    """
    await _has_any_mod_perm(session, current, guild_id)

    # Subqueries for scope checks — avoids Python-side filtering.
    channel_ids_in_guild = select(Channel.id).where(Channel.guild_id == guild_id).scalar_subquery()
    msg_ids_in_guild = (
        select(Message.id)
        .join(Channel, Channel.id == Message.channel_id)
        .where(Channel.guild_id == guild_id)
        .scalar_subquery()
    )
    member_user_ids = (
        select(GuildMember.user_id).where(GuildMember.guild_id == guild_id).scalar_subquery()
    )

    stmt = (
        select(Report)
        .where(
            Report.status == queue_status,
            or_(
                Report.target_channel_id.in_(channel_ids_in_guild),
                Report.target_message_id.in_(msg_ids_in_guild),
                # user-only reports: user is a guild member and no channel/message target
                (
                    Report.target_user_id.in_(member_user_ids)
                    & Report.target_channel_id.is_(None)
                    & Report.target_message_id.is_(None)
                ),
            ),
        )
        .order_by(Report.created_at.asc())
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [_report_to_out(r) for r in rows]


async def _report_in_guild(session: SessionDep, report: Report, guild_id: int) -> bool:
    """True iff any of the report's targets belongs to ``guild_id``.

    Mirrors the scope predicate in ``list_mod_queue``. Without this a mod in
    guild A could resolve/dismiss a report targeting only guild B by POSTing its
    id under guild A (cross-guild moderation bypass + audit-log written under the
    wrong guild).
    """
    if report.target_channel_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id).where(Channel.id == report.target_channel_id)
        )
        return gid == guild_id
    if report.target_message_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id)
            .join(Message, Message.channel_id == Channel.id)
            .where(Message.id == report.target_message_id)
        )
        return gid == guild_id
    if report.target_user_id is not None:
        member = await session.scalar(
            select(GuildMember.user_id).where(
                GuildMember.guild_id == guild_id,
                GuildMember.user_id == report.target_user_id,
            )
        )
        return member is not None
    return False


@router.post(
    "/guilds/{guild_id}/mod-queue/{report_id}/resolve",
    response_model=ReportItem,
)
async def resolve_report(
    guild_id: int,
    report_id: int,
    payload: ResolveIn,
    session: SessionDep,
    current: CurrentUser,
) -> ReportItem:
    """Close a report and write an immutable audit-log entry."""
    await _has_any_mod_perm(session, current, guild_id)

    report = await session.get(Report, report_id)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")
    # Scope guard — the report must belong to THIS guild, not just any guild the
    # caller happens to moderate. 404 (not 403) so it's indistinguishable from a
    # non-existent id.
    if not await _report_in_guild(session, report, guild_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")
    if report.status in ("resolved", "dismissed"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="report already resolved")

    report.status = payload.resolution
    report.resolver_user_id = current.id
    report.resolved_at = datetime.now(UTC)
    report.resolution_note = payload.resolution_note

    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type=f"report_{payload.resolution}",
        target_kind=payload.target_kind,
        target_id=payload.target_id,
        payload={
            "report_id": str(report_id),
            "resolution_note": payload.resolution_note,
            "reason_code": report.reason_code,
            **({"action_type": payload.action_type} if payload.action_type else {}),
        },
    )
    await session.commit()
    await session.refresh(report)
    return _report_to_out(report)


@router.get("/guilds/{guild_id}/mod-audit-log", response_model=list[AuditLogItem])
async def list_audit_log(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    limit: int = Query(default=50, ge=1, le=200),
    before: datetime | None = Query(default=None),
) -> list[AuditLogItem]:
    """Return audit-log entries for this guild (MANAGE_GUILD only).

    Paginated by ``before`` timestamp (exclusive upper bound on
    ``created_at``); newest entries first within the window.
    """
    from dcc_chat_gateway.models import ModAuditLog

    await check_permission(session, current, guild_id, Permissions.MANAGE_GUILD)

    stmt = select(ModAuditLog).where(ModAuditLog.guild_id == guild_id)
    if before is not None:
        stmt = stmt.where(ModAuditLog.created_at < before)
    stmt = stmt.order_by(ModAuditLog.created_at.desc()).limit(limit)

    rows = (await session.execute(stmt)).scalars().all()
    return [
        AuditLogItem(
            id=str(e.id),
            guild_id=str(e.guild_id),
            actor_user_id=str(e.actor_user_id),
            action_type=e.action_type,
            target_kind=e.target_kind,
            target_id=str(e.target_id) if e.target_id is not None else None,
            payload=e.payload,
            created_at=e.created_at,
        )
        for e in rows
    ]
