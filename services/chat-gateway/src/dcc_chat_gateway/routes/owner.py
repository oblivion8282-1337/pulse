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
* ``GET /owner/reports/{report_id}/content`` — emergency access to the message
  a report targets, bypassing normal member-only visibility so the operator can
  act on a complaint. Media bytes are withheld (CSAM safety); every fetch is
  audit-logged.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
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
from dcc_chat_gateway.routes.admin import _audit
from dcc_chat_gateway.schemas import (
    CommunityListOut,
    CommunityOut,
    OwnerReportedAttachment,
    OwnerReportedContentOut,
)
from dcc_chat_gateway.security import OwnerUser

router = APIRouter(prefix="/owner")


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
        CommunityOut(
            id=g.id,
            name=g.name,
            owner_id=g.owner_id,
            icon_url=g.icon_url,
            is_public=g.is_public,
            handle=g.handle,
            created_at=g.created_at,
            member_count=member_count,
            storage_bytes=storage_bytes,
        )
        for g, member_count, storage_bytes in rows
    ]
    # Only advertise a cursor when the page was full — a short page means we've
    # reached the end, so the client stops paging.
    next_before = str(communities[-1].id) if len(communities) == limit else None
    return CommunityListOut(communities=communities, next_before=next_before)


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
