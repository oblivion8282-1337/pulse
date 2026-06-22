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

from fastapi import APIRouter, HTTPException, Query, Request, status
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
    action_type: str | None = Field(default=None, max_length=100)
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


# Action types that trigger a real enforcement action on resolve. Everything
# else (``warn`` / ``role_change`` / ``other``) is recorded as metadata only.
_ENFORCEABLE = frozenset({"ban", "kick", "message_delete"})


async def _dispatch_enforcement(
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    guild_id: int,
    report: Report,
    action_type: str | None,
    reason: str | None,
) -> None:
    """Execute the moderator's chosen enforcement action against the report's
    target.

    Reuses the canonical route handlers (``ban_user`` / ``kick_member`` /
    ``delete_message``) so the specific permission gate (BAN_MEMBERS /
    KICK_MEMBERS / MANAGE_MESSAGES), the role-hierarchy check, the side
    effects (voice eviction, WS broadcasts) and the per-action audit entry all
    run exactly as a direct ban/kick/delete would. The handler's own
    ``HTTPException`` (403/404) propagates, which leaves the report *unresolved*
    — a moderator who lacks BAN_MEMBERS can't close a report "as banned"
    without the ban actually happening.

    The target is taken from the REPORT, never from client input, so the
    resolve payload can't redirect a ban to an arbitrary user.
    """
    if action_type not in _ENFORCEABLE:
        return

    if action_type == "ban":
        if report.target_user_id is None:
            raise HTTPException(400, detail="report has no user target to ban")
        from dcc_chat_gateway.routes.bans import ban_user
        from dcc_chat_gateway.schemas import BanIn

        # ``resolution_note`` allows up to 2000 chars but BanIn.reason caps at
        # 512 — truncate so a long note can't trip BanIn validation (→ 500).
        await ban_user(
            guild_id=guild_id,
            user_id=report.target_user_id,
            payload=BanIn(reason=(reason[:512] if reason else None)),
            session=session,
            current=current,
            request=request,
        )
    elif action_type == "kick":
        if report.target_user_id is None:
            raise HTTPException(400, detail="report has no user target to kick")
        from dcc_chat_gateway.routes.guilds import kick_member

        await kick_member(
            guild_id=guild_id,
            user_id=report.target_user_id,
            session=session,
            current=current,
            request=request,
        )
    elif action_type == "message_delete":
        if report.target_message_id is None:
            raise HTTPException(400, detail="report has no message target to delete")
        from dcc_chat_gateway.routes.messages import delete_message

        await delete_message(
            message_id=report.target_message_id,
            session=session,
            current=current,
            request=request,
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/guilds/{guild_id}/mod-queue", response_model=list[ReportItem])
async def list_mod_queue(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    queue_status: Literal["new", "triaged", "resolved", "dismissed"] = Query(
        default="new", alias="status"
    ),
    limit: int = Query(default=50, ge=1, le=200),
    before: datetime | None = Query(default=None),
) -> list[ReportItem]:
    """Return reports scoped to this guild, filtered by status.

    A report is in scope when *any* of its targets belongs to this guild:
      - target_channel_id → channel's guild_id matches
      - target_message_id → message's channel's guild_id matches
      - target_user_id only → user is a member of this guild

    Paginated by ``before`` timestamp (exclusive upper bound on ``created_at``);
    oldest entries first within the window. Use ``limit`` to control page size.
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
    )
    if before is not None:
        stmt = stmt.where(Report.created_at < before)
    stmt = stmt.order_by(Report.created_at.asc()).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return [_report_to_out(r) for r in rows]


async def _report_in_guild(session: SessionDep, report: Report, guild_id: int) -> bool:
    """True iff *any* of the report's targets belongs to ``guild_id``.

    Mirrors the OR-predicate in ``list_mod_queue``: checks every non-None target
    independently and returns True as soon as one of them scopes to the guild.
    Using an early-return chain (if channel → return) would cause divergence when
    a report has both target_channel_id *and* target_message_id pointing to
    different guilds — the list query would include the report for both guilds but
    the old guard would only check the first field.
    """
    if report.target_channel_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id).where(Channel.id == report.target_channel_id)
        )
        if gid == guild_id:
            return True

    if report.target_message_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id)
            .join(Message, Message.channel_id == Channel.id)
            .where(Message.id == report.target_message_id)
        )
        if gid == guild_id:
            return True

    # user-only check: mirrors the `target_channel_id IS NULL AND
    # target_message_id IS NULL` guard from list_mod_queue to avoid treating a
    # cross-guild report (channel→guild A, user in guild B) as guild-B-scoped via
    # the user branch alone.
    if (
        report.target_user_id is not None
        and report.target_channel_id is None
        and report.target_message_id is None
    ):
        member = await session.scalar(
            select(GuildMember.user_id).where(
                GuildMember.guild_id == guild_id,
                GuildMember.user_id == report.target_user_id,
            )
        )
        if member is not None:
            return True

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
    request: Request,
) -> ReportItem:
    """Close a report and write an immutable audit-log entry.

    When resolved with an enforceable ``action_type`` (``ban`` / ``kick`` /
    ``message_delete``) the corresponding action is actually executed against
    the report's target — gated on the action-specific permission + role
    hierarchy. A failure there (e.g. the moderator lacks BAN_MEMBERS or is
    outranked) leaves the report open instead of silently closing it.
    """
    await _has_any_mod_perm(session, current, guild_id)

    # Lock the report row so two moderators resolving the same report serialize:
    # the loser blocks here until the winner commits, then re-reads the resolved
    # status and hits the 409 guard instead of writing a duplicate resolution.
    report = await session.scalar(
        select(Report).where(Report.id == report_id).with_for_update()
    )
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")
    # Scope guard — the report must belong to THIS guild, not just any guild the
    # caller happens to moderate. 404 (not 403) so it's indistinguishable from a
    # non-existent id.
    if not await _report_in_guild(session, report, guild_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")
    if report.status in ("resolved", "dismissed"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="report already resolved")
    if report.target_user_id is not None and report.target_user_id == current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="cannot resolve a report targeting yourself")

    # Enforce the chosen action BEFORE marking the report resolved. The dispatch
    # helpers reuse the canonical handlers (own permission/hierarchy gate + their
    # own commit), so on success ``report`` is expired AND the FOR UPDATE row lock
    # taken above is released by that nested commit. Re-fetch the row WITH FOR
    # UPDATE so the status re-check + write below run under a fresh lock — a second
    # moderator that was blocked at the initial SELECT can otherwise slip in
    # between the commit and the re-read and produce a duplicate resolution. On a
    # 403/404 the exception propagates and the report stays open.
    if payload.resolution == "resolved" and payload.action_type in _ENFORCEABLE:
        await _dispatch_enforcement(
            session,
            current,
            request,
            guild_id,
            report,
            payload.action_type,
            payload.resolution_note,
        )
        report = await session.scalar(
            select(Report).where(Report.id == report_id).with_for_update()
        )
        if report is None or report.status in ("resolved", "dismissed"):
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


@router.post(
    "/guilds/{guild_id}/mod-queue/{report_id}/triage",
    response_model=ReportItem,
)
async def triage_report(
    guild_id: int,
    report_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> ReportItem:
    """Mark a ``new`` report as ``triaged`` (a moderator is handling it).

    Workflow state only — no audit entry, no enforcement. Already
    resolved/dismissed → 409; re-triaging a triaged report is an idempotent
    no-op success. Same any-mod-perm gate + guild scope guard as resolve.
    """
    await _has_any_mod_perm(session, current, guild_id)
    report = await session.get(Report, report_id)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")
    if not await _report_in_guild(session, report, guild_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")
    if report.status in ("resolved", "dismissed"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="report already resolved")
    if report.target_user_id is not None and report.target_user_id == current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="cannot triage a report targeting yourself")
    if report.status != "triaged":
        report.status = "triaged"
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
