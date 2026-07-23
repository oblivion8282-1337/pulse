"""Owner-only routes: cloud-wide community oversight + emergency access.

Mounted at ``/owner/*``. Gated by ``require_owner`` — only the single Cloud
operator (auth-svc ``is_owner``, carried as the JWT ``owner`` claim) passes.
Self-Host tokens never carry the claim, so this surface is implicitly
Cloud-only.

Two concerns, both metadata-first and privacy-conscious:

* ``GET /owner/communities`` — a paginated, searchable list of every guild on
  the Cloud with *metadata only* (name, owner, member count, storage bytes,
  created_at, public/handle). Never any chat content. This is the operator's
  "shop directory" for a platform opened to strangers.
* ``POST /owner/communities/{id}/suspend`` + ``/unsuspend`` — freeze/unfreeze a
  single community. A suspended community is inaccessible to its members (every
  action 403s) while its data + memberships are preserved (reversible). Both
  are audit-logged and broadcast a ``guild_updated`` so live clients re-gate.
* ``GET /owner/reports/{report_id}/content`` — emergency access to the message
  a report targets, bypassing normal member-only visibility so the operator can
  act on a complaint. Media bytes are withheld (CSAM safety); every fetch is
  audit-logged.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildMember,
    Message,
    MessageAttachment,
    Report,
)
from dcc_chat_gateway.guild_limits import clamp_to_ceilings
from dcc_chat_gateway.routes._dropbox_policy import clamp_dropbox_quota_to_ceiling
from dcc_chat_gateway.routes.admin import _audit
from dcc_chat_gateway.schemas import (
    CommunityLimitsIn,
    CommunityListOut,
    CommunityOut,
    OwnerReportedAttachment,
    OwnerReportedContentOut,
    SuspendCommunityIn,
)
from dcc_chat_gateway.security import OwnerUser
from dcc_shared.events import GuildUpdatedEvent

router = APIRouter(prefix="/owner")


def _community_row(guild: Guild, member_count: int, storage_bytes: int) -> CommunityOut:
    """Assemble a ``CommunityOut`` from a guild plus its already-computed
    member count + storage bytes. Shared by the list endpoint (batched
    subqueries) and the suspend/unsuspend responses (per-row lookups)."""
    return CommunityOut(
        id=guild.id,
        name=guild.name,
        owner_id=guild.owner_id,
        icon_url=guild.icon_url,
        is_public=guild.is_public,
        handle=guild.handle,
        created_at=guild.created_at,
        member_count=member_count,
        storage_bytes=storage_bytes,
        suspended=guild.suspended_at is not None,
        suspended_reason=guild.suspension_reason,
        voice_bitrate_max_kbps=guild.voice_bitrate_max_kbps,
        stream_bitrate_max_kbps=guild.stream_bitrate_max_kbps,
        stream_fps_max=guild.stream_fps_max,
        stream_resolution_max=guild.stream_resolution_max,
        # Das Betreiber-Panel zeigt OBERGRENZEN. Bei diesen beiden liegt der
        # Wert der Community in der Altspalte, die Obergrenze in der neuen
        # (0057) — hier also bewusst die ``_ceiling``-Spalten.
        attachment_max_size_bytes=guild.attachment_max_size_ceiling_bytes,
        attachment_max_count_per_message=guild.attachment_max_count_ceiling,
        attachment_storage_quota_bytes=guild.attachment_storage_quota_bytes,
        max_members=guild.max_members,
        max_channels=guild.max_channels,
        max_roles=guild.max_roles,
        max_concurrent_streams=guild.max_concurrent_streams,
        dropbox_allowed=guild.dropbox_allowed,
        dropbox_quota_bytes=guild.dropbox_quota_bytes,
    )


async def _community_out(session: SessionDep, guild: Guild) -> CommunityOut:
    """Build the ``CommunityOut`` for a single guild — used by the suspend/
    unsuspend responses so the frontend can update the row in place. Two small
    scalar lookups (member count + live attachment bytes) mirror the batched
    subqueries the list endpoint uses."""
    member_count = (
        await session.execute(
            select(func.count()).where(GuildMember.guild_id == guild.id)
        )
    ).scalar_one()
    storage_bytes = (
        await session.execute(
            select(func.coalesce(func.sum(MessageAttachment.size), 0))
            .select_from(MessageAttachment)
            .join(Channel, Channel.id == MessageAttachment.channel_id)
            .where(Channel.guild_id == guild.id, MessageAttachment.deleted_at.is_(None))
        )
    ).scalar_one()
    return _community_row(guild, member_count, storage_bytes)


async def _broadcast_guild_updated(request: Request, guild: Guild) -> None:
    """Best-effort ``guild_updated`` so connected members re-gate immediately
    (the perm-filter busts its per-socket cache on this op). Never raises."""
    from dcc_chat_gateway.routes.guilds import _guild_dict

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(GuildUpdatedEvent(guild=_guild_dict(guild)))


@router.get("/communities", response_model=CommunityListOut)
async def list_communities(
    session: SessionDep,
    _actor: OwnerUser,
    q: Annotated[str | None, Query(max_length=64)] = None,
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> CommunityListOut:
    """Newest-first, snowflake-id cursor. Member count + storage bytes are
    correlated scalar subqueries so the whole page is a single round-trip."""
    member_count_sq = (
        select(func.count())
        .select_from(GuildMember)
        .where(GuildMember.guild_id == Guild.id)
        .correlate(Guild)
        .scalar_subquery()
    )
    # Storage = sum of live (non-deleted) attachment bytes in the guild's
    # channels. MessageAttachment.channel_id is polymorphic (guild OR DM
    # channel); the join to Channel restricts it to this guild's channels.
    storage_sq = (
        select(func.coalesce(func.sum(MessageAttachment.size), 0))
        .select_from(MessageAttachment)
        .join(Channel, Channel.id == MessageAttachment.channel_id)
        .where(
            Channel.guild_id == Guild.id,
            MessageAttachment.deleted_at.is_(None),
        )
        .correlate(Guild)
        .scalar_subquery()
    )

    stmt = (
        select(
            Guild,
            member_count_sq.label("member_count"),
            storage_sq.label("storage_bytes"),
        )
        .order_by(Guild.id.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Guild.id < before)
    if q:
        stmt = stmt.where(Guild.name.ilike(f"%{q}%"))

    rows = (await session.execute(stmt)).all()
    communities = [
        _community_row(g, member_count, storage_bytes)
        for g, member_count, storage_bytes in rows
    ]
    # Only advertise a cursor when the page was full — a short page means we've
    # reached the end, so the client stops paging.
    next_before = str(communities[-1].id) if len(communities) == limit else None
    return CommunityListOut(communities=communities, next_before=next_before)


@router.post("/communities/{guild_id}/suspend", response_model=CommunityOut)
async def suspend_community(
    guild_id: int,
    payload: SuspendCommunityIn,
    request: Request,
    session: SessionDep,
    actor: OwnerUser,
) -> CommunityOut:
    """Freeze a community. Members lose all access until it's unsuspended;
    data + memberships are preserved (reversible, unlike a ban). Idempotent —
    re-suspending just updates the reason."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="community not found")

    if guild.suspended_at is None:
        guild.suspended_at = datetime.now(timezone.utc)
    guild.suspension_reason = payload.reason
    _audit(
        session,
        actor_id=actor.id,
        action="owner.suspend_community",
        target_id=guild.id,
        payload={"reason": payload.reason},
    )
    await session.commit()
    await session.refresh(guild)
    await _broadcast_guild_updated(request, guild)
    return await _community_out(session, guild)


@router.post("/communities/{guild_id}/unsuspend", response_model=CommunityOut)
async def unsuspend_community(
    guild_id: int,
    request: Request,
    session: SessionDep,
    actor: OwnerUser,
) -> CommunityOut:
    """Unfreeze a community — members regain their normal access. Idempotent."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="community not found")

    if guild.suspended_at is not None:
        guild.suspended_at = None
        guild.suspension_reason = None
        _audit(
            session,
            actor_id=actor.id,
            action="owner.unsuspend_community",
            target_id=guild.id,
        )
        await session.commit()
        await session.refresh(guild)
        await _broadcast_guild_updated(request, guild)
    return await _community_out(session, guild)


@router.patch("/communities/{guild_id}/limits", response_model=CommunityOut)
async def set_community_limits(
    guild_id: int,
    payload: CommunityLimitsIn,
    request: Request,
    session: SessionDep,
    actor: OwnerUser,
) -> CommunityOut:
    """Set this community's per-community quality caps (Boost foundation).
    Owner-only — deliberately NOT the MANAGE_GUILD ``patch_guild`` path, so a
    community's own owner can't raise their own limits. The form always sends
    the full set; NULL clears an override back to the instance default. A
    ``guild_updated`` broadcast pushes the new caps to connected members so
    their stream/voice publish re-clamps live."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="community not found")

    guild.voice_bitrate_max_kbps = payload.voice_bitrate_max_kbps
    guild.stream_bitrate_max_kbps = payload.stream_bitrate_max_kbps
    guild.stream_fps_max = payload.stream_fps_max
    guild.stream_resolution_max = payload.stream_resolution_max
    # Storage. Quota is nullable (null = unlimited) → always set. size/count are
    # non-nullable columns → only overwrite when the form provided a value.
    guild.attachment_storage_quota_bytes = payload.attachment_storage_quota_bytes
    # Bei diesen zwei Limits ist die Altspalte der Wert der Community — der
    # Betreiber setzt hier die OBERGRENZE (0057). Vorher schrieben beide Ebenen
    # dieselbe Zelle, womit MANAGE_GUILD die Vorgabe überschreiben konnte.
    guild.attachment_max_size_ceiling_bytes = payload.attachment_max_size_bytes
    guild.attachment_max_count_ceiling = payload.attachment_max_count_per_message
    # Scale caps: nullable (null = unlimited) → always set.
    guild.max_members = payload.max_members
    guild.max_channels = payload.max_channels
    guild.max_roles = payload.max_roles
    guild.max_concurrent_streams = payload.max_concurrent_streams
    # Feature permission, non-nullable column → only overwrite when sent.
    if payload.dropbox_allowed is not None:
        guild.dropbox_allowed = payload.dropbox_allowed
    # Ablage ceiling: nullable (NULL = instance standard) → always applied.
    # Lowering it must bite immediately, so an existing community config that
    # now sits above the new ceiling is pulled down with it — otherwise the
    # cap would only apply to communities that hadn't opened their Ablage yet.
    guild.dropbox_quota_bytes = payload.dropbox_quota_bytes
    await clamp_dropbox_quota_to_ceiling(session, guild)
    # Eine gesenkte Obergrenze muss sofort beißen: ohne das Nachziehen behielte
    # jede Community ihren zu hohen Wert, bis sie zufällig selbst noch einmal
    # speichert. Gibt die angepassten Limits zurück (fürs Audit-Log).
    clamped = clamp_to_ceilings(guild)
    _audit(
        session,
        actor_id=actor.id,
        action="owner.set_community_limits",
        target_id=guild.id,
        payload={
            "voice_bitrate_max_kbps": payload.voice_bitrate_max_kbps,
            "stream_bitrate_max_kbps": payload.stream_bitrate_max_kbps,
            "stream_fps_max": payload.stream_fps_max,
            "stream_resolution_max": payload.stream_resolution_max,
            "attachment_max_size_bytes": payload.attachment_max_size_bytes,
            "attachment_max_count_per_message": payload.attachment_max_count_per_message,
            "attachment_storage_quota_bytes": payload.attachment_storage_quota_bytes,
            "max_members": payload.max_members,
            "max_channels": payload.max_channels,
            "max_roles": payload.max_roles,
            "max_concurrent_streams": payload.max_concurrent_streams,
            "dropbox_allowed": payload.dropbox_allowed,
            "dropbox_quota_bytes": payload.dropbox_quota_bytes,
            "clamped_community_values": clamped,
        },
    )
    await session.commit()
    await session.refresh(guild)
    await _broadcast_guild_updated(request, guild)
    return await _community_out(session, guild)


@router.get("/reports/{report_id}/content", response_model=OwnerReportedContentOut)
async def get_reported_content(
    report_id: int,
    session: SessionDep,
    actor: OwnerUser,
) -> OwnerReportedContentOut:
    """Emergency access to a report's target message. Owner-only, bypasses
    member-only visibility. Media bytes are withheld; the fetch is audit-logged
    so there is always a trail of the operator looking at otherwise private
    content."""
    report = await session.get(Report, report_id)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="report not found")

    out = OwnerReportedContentOut(
        report_id=report.id,
        reason_code=report.reason_code,
        report_body=report.body,
        status=report.status,
        guild_id=report.target_guild_id,
        channel_id=report.target_channel_id,
        message_id=report.target_message_id,
    )

    if report.target_message_id is not None:
        # Load even soft-deleted messages: a moderator may already have removed
        # it, but the operator still needs to see what was reported.
        message = await session.get(Message, report.target_message_id)
        if message is not None:
            out.author_id = message.author_id
            out.content = message.content
            out.message_created_at = message.created_at
            out.edited_at = message.edited_at
            out.deleted = message.deleted_at is not None
            att_rows = (
                await session.execute(
                    select(MessageAttachment).where(
                        MessageAttachment.message_id == message.id
                    )
                )
            ).scalars().all()
            out.attachments = [
                OwnerReportedAttachment(
                    id=a.id, filename=a.filename, mime=a.mime, size=a.size
                )
                for a in att_rows
            ]

    _audit(
        session,
        actor_id=actor.id,
        action="owner.view_reported_content",
        target_id=report.target_message_id or report.id,
        payload={
            "report_id": str(report.id),
            "guild_id": str(report.target_guild_id) if report.target_guild_id else None,
            "channel_id": (
                str(report.target_channel_id) if report.target_channel_id else None
            ),
            "message_id": (
                str(report.target_message_id) if report.target_message_id else None
            ),
        },
    )
    await session.commit()
    return out
