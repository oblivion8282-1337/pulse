"""Message history + send/edit/delete endpoints.

Reaction aggregation + the wire-shape ``serialize_message`` helper +
the WS broadcast helper live in ``dcc_chat_gateway.message_helpers``
and are re-exported here for backwards-compatibility (``routes.ws`` +
``routes.reactions`` import them from this module).

Mention parsing + persistence + per-user fan-out live in
``dcc_chat_gateway.mentions``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.mentions import (
    MENTION_EVERYONE_RE as _MENTION_EVERYONE_RE,
)
from dcc_chat_gateway.mentions import (
    fan_out_mention_events,
    filter_to_valid,
    mentions_for,
    parse_markers,
    persist_for_message,
)
from dcc_chat_gateway.message_helpers import (
    broadcast as _broadcast,
)
from dcc_chat_gateway.message_helpers import (
    reactions_for as _reactions_for,
)
from dcc_chat_gateway.message_helpers import (
    serialize_message,
)
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    MENTION_TYPE_USER,
    Message,
    MessageAttachment,
    MessageReaction,
)
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.push import fan_out_mention_push
from dcc_chat_gateway.routes._deps import resolve_channel_or_raise
from dcc_chat_gateway.routes.attachments import (
    bind_attachments,
    hard_delete_attachments,
    serialize_attachments,
)
from dcc_chat_gateway.schemas import MessageEditIn, MessageIn, MessageOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "/channels/{channel_id}/messages",
    response_model=list[MessageOut],
)
async def list_messages(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    before: Annotated[int | None, Query(ge=0)] = None,
    after: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    # Resolve the channel as guild-or-DM and enforce access in one go.
    # The Message query below is identical regardless of channel kind.
    kind, ch = await resolve_channel_or_raise(session, channel_id, current.id)

    # READ_HISTORY gate (guild channels only — DMs have no permission overlay).
    if kind == "guild":
        perms = await resolve_permissions(
            session, current, ch.guild_id, channel_id=channel_id
        )
        if not has_permission(perms, Permissions.READ_HISTORY):
            raise HTTPException(403, detail="missing permission: READ_HISTORY")

    stmt = select(Message).where(
        Message.channel_id == channel_id,
        Message.deleted_at.is_(None),
    )
    if before is not None:
        stmt = stmt.where(Message.id < before)
    if after is not None:
        stmt = stmt.where(Message.id > after)
    stmt = stmt.order_by(Message.id.desc()).limit(limit)
    rows = list((await session.execute(stmt)).scalars().all())
    msg_ids = [m.id for m in rows]
    # Three independent fan-out queries — kept sequential because
    # AsyncSession is not safe to share across concurrent tasks (SQLAlchemy
    # docs: connection state is per-execute). Each query is index-bound on
    # ``msg_ids IN (...)`` so the win from parallelizing them would be a
    # few ms at most; the real wall-clock cost in this function lived in
    # ``serialize_attachments`` (S3-signing), which now reuses a singleton
    # aiobotocore client — see ``s3.py``.
    reactions = await _reactions_for(session, msg_ids, current.id)
    attachments = await serialize_attachments(session, msg_ids)
    mentions_map = await mentions_for(session, msg_ids)
    # MessageOut reads `from_attributes`; we attach reactions + attachments
    # + mentions onto the ORM instance attribute so Pydantic picks them up
    # alongside the columns.
    for m in rows:
        m.reactions = reactions.get(m.id, [])  # type: ignore[attr-defined]
        m.attachments = attachments.get(m.id, [])  # type: ignore[attr-defined]
        m.mentions = mentions_map.get(m.id, [])  # type: ignore[attr-defined]
    return rows


@router.post(
    "/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=201,
)
async def post_message(
    channel_id: int,
    payload: MessageIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    kind, ch = await resolve_channel_or_raise(session, channel_id, current.id)
    if kind == "guild" and ch.type != CHANNEL_TYPE_TEXT:
        # Voice channels reject text posts. DM channels are always text-only.
        raise HTTPException(404, detail="text channel not found")
    # SEND_MESSAGES + MENTION_EVERYONE gates (guild channels only — DMs have
    # no permission overlay). Resolve once and bit-check locally.
    perms = 0  # DM-path default; mentions.filter_to_valid treats it as
    # "no MENTION_EVERYONE override" (DMs have no roles anyway).
    if kind == "guild":
        perms = await resolve_permissions(
            session, current, ch.guild_id, channel_id=channel_id
        )
        if not has_permission(perms, Permissions.SEND_MESSAGES):
            raise HTTPException(403, detail="missing permission: SEND_MESSAGES")
        if _MENTION_EVERYONE_RE.search(payload.content) and not has_permission(
            perms, Permissions.MENTION_EVERYONE
        ):
            raise HTTPException(
                403, detail="missing permission: MENTION_EVERYONE"
            )
    if not ratelimit.check("message", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )

    if payload.reply_to_id is not None:
        parent = await session.get(Message, payload.reply_to_id)
        if parent is None or parent.channel_id != channel_id or parent.deleted_at is not None:
            raise HTTPException(400, detail="reply target not found in this channel")

    # A message needs either text or at least one attachment — otherwise
    # it's a blank ghost that adds nothing. The check happens *after* the
    # reply-target check so reply-debugging errors stay specific.
    if not payload.content.strip() and not payload.attachment_ids:
        raise HTTPException(400, detail="message must have content or attachments")

    # Count-limit per the per-guild / chat-settings cap.
    if payload.attachment_ids:
        from dcc_chat_gateway.routes.attachments import _limits_for_channel
        _max_size, max_count = await _limits_for_channel(session, kind=kind, ch=ch)
        if len(payload.attachment_ids) > max_count:
            raise HTTPException(
                400,
                detail=f"too many attachments ({len(payload.attachment_ids)} > {max_count})",
            )

    msg = Message(
        id=next_id(),
        channel_id=channel_id,
        author_id=current.id,
        content=payload.content,
        nonce=payload.nonce,
        reply_to_id=payload.reply_to_id,
    )
    session.add(msg)
    await session.flush()  # need msg.id before binding attachments

    if payload.attachment_ids:
        await bind_attachments(
            session,
            attachment_ids=list(payload.attachment_ids),
            message_id=msg.id,
            channel_id=channel_id,
            uploader_id=current.id,
        )

    # Parse + validate @-mentions and persist them. Markers that don't
    # ping anyone (non-member users, non-mentionable roles without
    # MENTION_EVERYONE) are silently skipped. ``everyone`` already
    # 403's upstream if the author lacks the bit.
    guild_id_for_mentions = ch.guild_id if kind == "guild" else None
    raw_mentions = parse_markers(payload.content)
    valid_mentions = await filter_to_valid(
        session,
        guild_id=guild_id_for_mentions,
        author_permissions=perms,
        candidates=raw_mentions,
    )
    await persist_for_message(
        session, message_id=msg.id, mentions=valid_mentions, replace=False
    )

    if kind == "dm":
        # Bump last_message_id so the DM list can sort by recency.
        ch.last_message_id = msg.id
        session.add(ch)
    await session.commit()
    await session.refresh(msg)

    mentions_serial = [
        {"type": t, "id": str(tid)} for (t, tid) in sorted(valid_mentions)
    ]

    # Bare payload — the pubsub listener auto-wraps as {"op": "message", "data": ...}.
    # Sign attachments NOW so the broadcast carries usable URLs for every
    # subscribed client (otherwise each one has to GET /messages to re-hydrate).
    atts_by_msg = await serialize_attachments(session, [msg.id])
    atts = atts_by_msg.get(msg.id, [])
    atts_serial = [a.model_dump(mode="json") for a in atts]
    await _broadcast(
        request,
        channel_id,
        serialize_message(msg, attachments=atts_serial, mentions=mentions_serial),
    )
    await fan_out_mention_events(
        request,
        mentions=valid_mentions,
        message_id=msg.id,
        channel_id=channel_id,
        guild_id=guild_id_for_mentions,
        author_id=current.id,
    )
    # Web-Push fan-out (cross-channel, out-of-band): same targets as the
    # in-window ``mention_added`` envelope. Runs AFTER the WS broadcast
    # so a slow push service can't delay the in-app counter bump.
    push_targets = {
        tid
        for (t, tid) in valid_mentions
        if t == MENTION_TYPE_USER and tid != current.id
    }
    if push_targets:
        await fan_out_mention_push(
            user_ids=push_targets,
            author_name=current.username,
            content=payload.content,
            channel_id=channel_id,
            message_id=msg.id,
            guild_id=guild_id_for_mentions,
        )
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        if kind == "guild":
            # Global "channel had activity" envelope on guild:events so
            # clients NOT subscribed to this channel (i.e. everyone except
            # whoever is currently viewing it) can flag the channel as
            # unread in the sidebar. Payload is intentionally minimal —
            # no content.
            await mgr.publish_guild_event(
                {
                    "op": "channel_bump",
                    "guild_id": str(ch.guild_id),
                    "channel_id": str(channel_id),
                    "message_id": str(msg.id),
                    "author_id": str(current.id),
                }
            )
        else:
            # DM equivalent. ``user_a_id``/``user_b_id`` are carried in the
            # envelope so each receiving client can decide locally whether
            # it's a member (no server-side per-user routing in Phase 1 —
            # this fans to every connected socket). MVP-acceptable for
            # low user counts; tighten later if it matters.
            await mgr.publish_guild_event(
                {
                    "op": "dm_bump",
                    "channel_id": str(channel_id),
                    "user_a_id": str(ch.user_a_id),
                    "user_b_id": str(ch.user_b_id),
                    "message_id": str(msg.id),
                    "author_id": str(current.id),
                }
            )
    msg.reactions = []  # type: ignore[attr-defined]
    msg.attachments = atts  # type: ignore[attr-defined]
    msg.mentions = mentions_serial  # type: ignore[attr-defined]
    return msg


@router.patch(
    "/messages/{message_id}",
    response_model=MessageOut,
)
async def edit_message(
    message_id: int,
    payload: MessageEditIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    if msg.author_id != current.id:
        raise HTTPException(403, detail="only the author can edit")
    # Caller must still have access to the channel (guild kick → can't edit
    # old messages; DM author trivially passes since DM membership is fixed).
    kind, ch = await resolve_channel_or_raise(session, msg.channel_id, current.id)

    # SEND_MESSAGES + MENTION_EVERYONE gates: editing publishes content the
    # same way posting does — a read-only channel must reject edits too, and
    # ``@everyone`` smuggled in via edit needs the same bit. Guild channels
    # only; DMs bypass.
    perms = 0  # DM-path default — see notes in post_message.
    if kind == "guild":
        perms = await resolve_permissions(
            session, current, ch.guild_id, channel_id=msg.channel_id
        )
        if not has_permission(perms, Permissions.SEND_MESSAGES):
            raise HTTPException(403, detail="missing permission: SEND_MESSAGES")
        if _MENTION_EVERYONE_RE.search(payload.content) and not has_permission(
            perms, Permissions.MENTION_EVERYONE
        ):
            raise HTTPException(
                403, detail="missing permission: MENTION_EVERYONE"
            )

    # Author may rewrite content AND swap attachments. Diff against the
    # current set: removed → hard-delete (MinIO + soft-row), added → bind.
    # An empty edit (no text + no attachments) is still rejected for the
    # same reason as a fresh ghost message.
    if not payload.content.strip() and not payload.attachment_ids:
        raise HTTPException(400, detail="message must have content or attachments")

    current_ids = {
        a.id
        for a in (
            await session.execute(
                select(MessageAttachment).where(
                    MessageAttachment.message_id == msg.id,
                    MessageAttachment.deleted_at.is_(None),
                )
            )
        ).scalars()
    }
    desired_ids = set(payload.attachment_ids)
    to_remove = current_ids - desired_ids
    to_add = desired_ids - current_ids

    if to_remove:
        await hard_delete_attachments(session, attachment_ids=list(to_remove))
    if to_add:
        await bind_attachments(
            session,
            attachment_ids=list(to_add),
            message_id=msg.id,
            channel_id=msg.channel_id,
            uploader_id=current.id,
        )

    msg.content = payload.content
    msg.edited_at = datetime.now(UTC)

    # Re-compute mentions from the edited content. Read the pre-edit set
    # first so we can fire ``mention_added`` only for *newly* added user
    # pings (an edit that just fixes a typo must not re-notify everyone).
    guild_id_for_mentions = ch.guild_id if kind == "guild" else None
    pre_existing = await mentions_for(session, [msg.id])
    pre_user_ids: set[int] = {
        int(m["id"]) for m in pre_existing.get(msg.id, []) if m["type"] == MENTION_TYPE_USER
    }
    raw_mentions = parse_markers(payload.content)
    valid_mentions = await filter_to_valid(
        session,
        guild_id=guild_id_for_mentions,
        author_permissions=perms,
        candidates=raw_mentions,
    )
    await persist_for_message(
        session, message_id=msg.id, mentions=valid_mentions, replace=True
    )
    await session.commit()
    await session.refresh(msg)

    reactions = (await _reactions_for(session, [msg.id], current.id)).get(msg.id, [])
    attachments = (await serialize_attachments(session, [msg.id])).get(msg.id, [])
    atts_serial = [a.model_dump(mode="json") for a in attachments]
    mentions_serial = [
        {"type": t, "id": str(tid)} for (t, tid) in sorted(valid_mentions)
    ]
    payload_out = serialize_message(
        msg, reactions, attachments=atts_serial, mentions=mentions_serial
    )
    await _broadcast(request, msg.channel_id, {"op": "message_update", "data": payload_out})
    # Only fan out direct mention_added events for newly pinged users.
    new_user_mentions = {
        (t, tid)
        for (t, tid) in valid_mentions
        if t == MENTION_TYPE_USER and tid not in pre_user_ids
    }
    if new_user_mentions:
        await fan_out_mention_events(
            request,
            mentions=new_user_mentions,
            message_id=msg.id,
            channel_id=msg.channel_id,
            guild_id=guild_id_for_mentions,
            author_id=current.id,
        )
        push_targets = {
            tid for (t, tid) in new_user_mentions if t == MENTION_TYPE_USER
        }
        # ``new_user_mentions`` already excludes pre-existing ids, but
        # edits where the author adds themselves still need the self-ping
        # filter. Cheap belt-and-braces; matches post_message semantics.
        push_targets.discard(current.id)
        if push_targets:
            await fan_out_mention_push(
                user_ids=push_targets,
                author_name=current.username,
                content=payload.content,
                channel_id=msg.channel_id,
                message_id=msg.id,
                guild_id=guild_id_for_mentions,
            )
    msg.reactions = reactions  # type: ignore[attr-defined]
    msg.attachments = attachments  # type: ignore[attr-defined]
    msg.mentions = mentions_serial  # type: ignore[attr-defined]
    return msg


@router.delete(
    "/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_message(
    message_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    # Resolve channel: also enforces caller still has access (a kicked
    # author can't keep deleting their old messages in a guild).
    kind, ch = await resolve_channel_or_raise(session, msg.channel_id, current.id)
    # Author may delete their own. In a guild, anyone with MANAGE_MESSAGES
    # (mods etc.) may also delete others'. DM channels have no override
    # — only the author can delete.
    if msg.author_id != current.id:
        if kind == "dm":
            raise HTTPException(403, detail="not allowed to delete this message")
        perms = await resolve_permissions(
            session, current, ch.guild_id, channel_id=ch.id
        )
        if not has_permission(perms, Permissions.MANAGE_MESSAGES):
            raise HTTPException(403, detail="not allowed to delete this message")

    msg.deleted_at = datetime.now(UTC)
    # Reactions are no longer meaningful once the message is gone.
    await session.execute(
        delete(MessageReaction).where(MessageReaction.message_id == msg.id)
    )
    # Attachments → hard-delete from MinIO + tombstone row. The message
    # itself stays soft-deleted (audit trail) but the bytes go away to
    # free storage.
    await hard_delete_attachments(session, message_ids=[msg.id])
    await session.commit()

    await _broadcast(
        request,
        msg.channel_id,
        {"op": "message_delete", "data": {"id": str(msg.id), "channel_id": str(msg.channel_id)}},
    )
    return None


__all__ = ["router", "serialize_message", "_reactions_for", "_broadcast"]
