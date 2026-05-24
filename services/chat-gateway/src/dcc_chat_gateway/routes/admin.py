"""Admin-only routes: chat-side stats, DM-limits, audit log.

Mounted at ``/admin/*`` on chat-gateway. Gated by ``require_admin`` so a
plain bearer token isn't enough — the JWT must carry ``admin: true``.
auth-svc owns the source of truth for the admin flag; this service just
reads the claim.

Three concerns split across endpoints:
* ``GET /admin/stats`` — counts for the Übersicht-Tab (guild_count etc.).
  auth-svc has its own ``/admin/stats`` for user-side counts.
* ``GET/PATCH /admin/dm-limits`` — read/write the singleton
  ``chat_settings`` row that gates DM attachments. Future attachments
  feature will read this on every upload-url request.
* ``GET /admin/audit-log`` — paginated history of chat-side admin
  actions. Each PATCH appends a row; the UI fetches both this and
  auth-svc's audit-log and merges client-side.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select


async def _broadcast(request: Request, payload: dict) -> None:
    """Best-effort guild:events publish — never raises."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    try:
        await mgr.publish_guild_event(payload)
    except Exception:  # noqa: BLE001
        import structlog
        structlog.get_logger(__name__).exception("permissions broadcast failed")

from dcc_chat_gateway import s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    AdminAuditLog,
    Channel,
    ChatSettings,
    DirectMessageChannel,
    Guild,
    Message,
)
from dcc_chat_gateway.schemas import (
    AdminAuditLogEntry,
    AdminStatsOut,
    ChatSettingsOut,
    ChatSettingsPatch,
    PermissionsOut,
    PermissionsPatch,
)
from dcc_chat_gateway.security import AdminUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(prefix="/admin")


def _audit(
    session,
    *,
    actor_id: int,
    action: str,
    target_id: int | None = None,
    payload: dict | None = None,
) -> None:
    session.add(
        AdminAuditLog(
            id=next_id(),
            actor_id=actor_id,
            action=action,
            target_id=target_id,
            payload=payload or {},
        )
    )


@router.get("/stats", response_model=AdminStatsOut)
async def get_stats(session: SessionDep, _actor: AdminUser):
    """Four counts in three round-trips (Postgres can't do all four in one
    aggregate query without UNIONing — three small SELECTs is cheaper)."""
    guild_count = (await session.execute(select(func.count()).select_from(Guild))).scalar_one()
    channel_count = (
        await session.execute(select(func.count()).select_from(Channel))
    ).scalar_one()
    dm_channel_count = (
        await session.execute(select(func.count()).select_from(DirectMessageChannel))
    ).scalar_one()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    messages_24h = (
        await session.execute(
            select(func.count())
            .select_from(Message)
            .where(Message.created_at >= cutoff, Message.deleted_at.is_(None))
        )
    ).scalar_one()
    # Fire bucket-sum + disk-info in parallel so the slowest of the two caps
    # the whole stats endpoint, not their sum.
    bucket_bytes, disk = await asyncio.gather(
        s3.total_bucket_bytes(),
        s3.cluster_disk_info(),
    )
    return AdminStatsOut(
        guild_count=guild_count,
        channel_count=channel_count,
        dm_channel_count=dm_channel_count,
        messages_24h=messages_24h,
        storage_bytes=bucket_bytes,
        storage_total_bytes=disk[0] if disk else None,
        storage_free_bytes=disk[1] if disk else None,
    )


@router.get("/dm-limits", response_model=ChatSettingsOut)
async def get_dm_limits(session: SessionDep, _actor: AdminUser):
    row = await session.get(ChatSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="chat_settings singleton missing — re-run migration 0006",
        )
    return row


@router.patch("/dm-limits", response_model=ChatSettingsOut)
async def patch_dm_limits(
    payload: ChatSettingsPatch,
    session: SessionDep,
    actor: AdminUser,
):
    row = await session.get(ChatSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="chat_settings singleton missing — re-run migration 0006",
        )

    changes: dict[str, Any] = {}
    if (
        payload.dm_attachment_max_size_bytes is not None
        and payload.dm_attachment_max_size_bytes != row.dm_attachment_max_size_bytes
    ):
        changes["dm_attachment_max_size_bytes"] = {
            "from": row.dm_attachment_max_size_bytes,
            "to": payload.dm_attachment_max_size_bytes,
        }
        row.dm_attachment_max_size_bytes = payload.dm_attachment_max_size_bytes

    if (
        payload.dm_attachment_max_count_per_message is not None
        and payload.dm_attachment_max_count_per_message != row.dm_attachment_max_count_per_message
    ):
        changes["dm_attachment_max_count_per_message"] = {
            "from": row.dm_attachment_max_count_per_message,
            "to": payload.dm_attachment_max_count_per_message,
        }
        row.dm_attachment_max_count_per_message = payload.dm_attachment_max_count_per_message

    if changes:
        _audit(session, actor_id=actor.id, action="dm_limits.patch", payload=changes)
        await session.commit()
        await session.refresh(row)
    return row


@router.get("/permissions", response_model=PermissionsOut)
async def get_permissions(session: SessionDep, _actor: AdminUser):
    row = await session.get(ChatSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="chat_settings singleton missing — re-run migration 0006",
        )
    return row


@router.patch("/permissions", response_model=PermissionsOut)
async def patch_permissions(
    payload: PermissionsPatch,
    session: SessionDep,
    actor: AdminUser,
    request: Request,
):
    row = await session.get(ChatSettings, 1)
    if row is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="chat_settings singleton missing — re-run migration 0006",
        )

    changes: dict[str, Any] = {}
    if (
        payload.allow_guild_creation is not None
        and payload.allow_guild_creation != row.allow_guild_creation
    ):
        changes["allow_guild_creation"] = {
            "from": row.allow_guild_creation,
            "to": payload.allow_guild_creation,
        }
        row.allow_guild_creation = payload.allow_guild_creation

    if (
        payload.allow_member_invites is not None
        and payload.allow_member_invites != row.allow_member_invites
    ):
        changes["allow_member_invites"] = {
            "from": row.allow_member_invites,
            "to": payload.allow_member_invites,
        }
        row.allow_member_invites = payload.allow_member_invites

    if (
        payload.guild_sound_max_size_bytes is not None
        and payload.guild_sound_max_size_bytes != row.guild_sound_max_size_bytes
    ):
        changes["guild_sound_max_size_bytes"] = {
            "from": row.guild_sound_max_size_bytes,
            "to": payload.guild_sound_max_size_bytes,
        }
        row.guild_sound_max_size_bytes = payload.guild_sound_max_size_bytes

    if changes:
        _audit(session, actor_id=actor.id, action="permissions.patch", payload=changes)
        await session.commit()
        await session.refresh(row)
        # Push the new flags out so connected clients can re-gate their
        # create-guild / create-invite buttons without a page reload.
        from dcc_shared.events import PermissionsUpdatedEvent

        await _broadcast(
            request,
            PermissionsUpdatedEvent(
                allow_guild_creation=row.allow_guild_creation,
                allow_member_invites=row.allow_member_invites,
                guild_sound_max_size_bytes=row.guild_sound_max_size_bytes,
            ),
        )
    return row


@router.get("/audit-log", response_model=list[AdminAuditLogEntry])
async def get_audit_log(
    session: SessionDep,
    _actor: AdminUser,
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """Newest-first, snowflake-id cursor."""
    stmt = select(AdminAuditLog).order_by(AdminAuditLog.id.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(AdminAuditLog.id < before)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)
