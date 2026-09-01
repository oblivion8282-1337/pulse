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
from sqlalchemy import delete, select, update as sa_update

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import (
    block_exists_either_way,
    friendship_exists,
)
from dcc_chat_gateway.mentions import (
    MENTION_EVERYONE_RE as _MENTION_EVERYONE_RE,
    fan_out_mention_events,
    filter_to_valid,
    mentions_for,
    parse_markers,
    persist_for_message,
    serialize_mention_targets,
)
from dcc_chat_gateway.message_helpers import (
    broadcast as _broadcast,
    reactions_for as _reactions_for,
    serialize_message,
)
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    LEGACY_READONLY_DETAIL,
    Message,
    MessageAttachment,
    MessageMention,
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
    _limits_for_channel,
    bind_attachments,
    hard_delete_attachments,
    purge_s3_keys as _purge_s3_keys,
    serialize_attachments,
)
from dcc_chat_gateway.schemas import MessageEditIn, MessageIn, MessageOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    ChannelBumpEvent,
    DmBumpEvent,
    MessageDeleteData,
    MessageDeleteEvent,
    MessageUpdateEvent,
)

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
    if kind == "guild" and getattr(ch, "ablage", False):
        # Mischzustand-Regel (Konzept §2a): Ablage-Kanaele sind serverblind.
        # Klartext wird nicht stillschweigend akzeptiert — der Klient
        # verschluesselt und konsolidiert selbst; der Server fuhrt nur
        # Zustellung und Metadaten.
        raise HTTPException(
            403,
            detail="ablage channel: content is end-to-end encrypted, not accepted here",
        )
    if kind == "guild" and getattr(ch, "legacy_readonly", False):
        # Umstellung (Entwurf §9, Etappe E9): dieser Alt-Kanal ist eingefroren
        # — Verlauf bleibt lesbar, neue Nachrichten nimmt nur noch ein
        # Ablage-Kanal an. Begruendende Meldung statt nacktem 403, s. Aufgabe.
        raise HTTPException(403, detail=LEGACY_READONLY_DETAIL)
    if kind == "dm":
        # Etappe 2 friend-gate: a DM send requires both sides to still be
        # friends with no block in either direction. Pre-existing rows from
        # Phase 1 stay in the table but become send-locked (tombstone) when
        # one party unfriends or blocks. The 403 detail mirrors the create
        # endpoint so clients can branch on the same string set.
        other = ch.user_b_id if ch.user_a_id == current.id else ch.user_a_id
        if await block_exists_either_way(session, current.id, other):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="blocked")
        if not await friendship_exists(session, current.id, other):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, detail="not_friends"
            )
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
        content=payload.content.strip(),
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
    dm_participant_ids = (
        {ch.user_a_id, ch.user_b_id} if kind == "dm" else None
    )
    raw_mentions = parse_markers(payload.content)
    valid_mentions = await filter_to_valid(
        session,
        guild_id=guild_id_for_mentions,
        author_permissions=perms,
        candidates=raw_mentions,
        dm_participant_ids=dm_participant_ids,
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

    mentions_serial = serialize_mention_targets(valid_mentions)

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
    notified = await fan_out_mention_events(
        request,
        session=session,
        mentions=valid_mentions,
        message_id=msg.id,
        channel_id=channel_id,
        guild_id=guild_id_for_mentions,
        author_id=current.id,
    )
    # Web-Push fan-out (cross-channel, out-of-band): exactly the audience
    # the in-window ``mention_added`` envelope went to — role + everyone
    # pings already expanded + VIEW-filtered + author-excluded. Runs AFTER
    # the WS broadcast so a slow push service can't delay the counter bump.
    # Awaited (not fire-and-forget): fan_out_mention_push already offloads the
    # sync pywebpush calls to threads and batches its DB writes, so it does not
    # block the event loop meaningfully. An unreferenced asyncio.create_task can
    # be GC'd before it runs and makes dead-subscription cleanup non-deterministic.
    if notified:
        await fan_out_mention_push(
            user_ids=notified,
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
                ChannelBumpEvent(
                    guild_id=str(ch.guild_id),
                    channel_id=str(channel_id),
                    message_id=str(msg.id),
                    author_id=str(current.id),
                )
            )
        else:
            # DM equivalent. ``user_a_id``/``user_b_id`` are carried in the
            # envelope so each receiving client can decide locally whether
            # it's a member (no server-side per-user routing in Phase 1 —
            # this fans to every connected socket). MVP-acceptable for
            # low user counts; tighten later if it matters.
            await mgr.publish_guild_event(
                DmBumpEvent(
                    channel_id=str(channel_id),
                    user_a_id=str(ch.user_a_id),
                    user_b_id=str(ch.user_b_id),
                    message_id=str(msg.id),
                    author_id=str(current.id),
                )
            )
    # Closed-browser web-push for the DM recipient (the other member). The
    # WS dm_bump above only reaches tabs that are open. Out-of-band + best-
    # effort — never blocks or fails the send.
    if kind == "dm":
        recipient_id = ch.user_b_id if ch.user_a_id == current.id else ch.user_a_id
        if recipient_id != current.id:
            from dcc_chat_gateway.push import fan_out_dm_push

            await fan_out_dm_push(
                recipient_id=recipient_id,
                author_name=current.username,
                content=payload.content,
                channel_id=channel_id,
                message_id=msg.id,
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
    # Caller must still have access to the channel (guild kick → can't edit
    # old messages; DM author trivially passes since DM membership is fixed).
    # Membership check comes before the author check to avoid leaking message
    # existence to non-members (existence oracle).
    kind, ch = await resolve_channel_or_raise(session, msg.channel_id, current.id)
    if kind == "dm":
        other = ch.user_b_id if ch.user_a_id == current.id else ch.user_a_id
        if await block_exists_either_way(session, current.id, other):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="blocked")
        if not await friendship_exists(session, current.id, other):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_friends")
    if msg.author_id != current.id:
        raise HTTPException(403, detail="only the author can edit")

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

    if not ratelimit.check("message", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
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

    # Enforce the per-guild / DM attachment count limit on edits just as
    # post_message does — otherwise a user can bypass the cap by editing.
    if desired_ids:
        _max_size, max_count = await _limits_for_channel(session, kind=kind, ch=ch)
        if len(desired_ids) > max_count:
            raise HTTPException(
                400,
                detail=f"too many attachments ({len(desired_ids)} > {max_count})",
            )

    # Bind new attachments BEFORE deleting removed ones: bind_attachments may
    # raise HTTP 400 for invalid/mismatched IDs, and the session would roll
    # back — which would resurrect DB tombstones from hard_delete_attachments
    # while MinIO objects are already gone (broken media rows).
    if to_add:
        await bind_attachments(
            session,
            attachment_ids=list(to_add),
            message_id=msg.id,
            channel_id=msg.channel_id,
            uploader_id=current.id,
        )
    # Collect storage keys BEFORE mutating the DB so that if commit fails the
    # rows survive (deleted_at stays NULL) and the reaper or the user can retry.
    # S3 objects are purged AFTER a successful commit below (s3_keys_to_purge).
    s3_keys_to_purge: list[str] = []
    if to_remove:
        remove_rows = (
            (
                await session.execute(
                    select(MessageAttachment).where(
                        MessageAttachment.id.in_(list(to_remove)),
                        MessageAttachment.deleted_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in remove_rows:
            s3_keys_to_purge.append(row.storage_key)
            if row.thumb_storage_key:
                s3_keys_to_purge.append(row.thumb_storage_key)
        # DB-only soft-delete — S3 purge happens after commit.
        await session.execute(
            sa_update(MessageAttachment)
            .where(MessageAttachment.id.in_([row.id for row in remove_rows]))
            .values(deleted_at=datetime.now(UTC))
        )

    msg.content = payload.content.strip()
    msg.edited_at = datetime.now(UTC)

    # Re-compute mentions from the edited content. Read the pre-edit set
    # first so we can fire ``mention_added`` only for *newly* added user
    # pings (an edit that just fixes a typo must not re-notify everyone).
    guild_id_for_mentions = ch.guild_id if kind == "guild" else None
    dm_participant_ids = (
        {ch.user_a_id, ch.user_b_id} if kind == "dm" else None
    )
    pre_existing = await mentions_for(session, [msg.id])
    # Full pre-edit marker set ``(type, id)`` — drives the "only notify for
    # *newly* added pings" diff below (a typo-fix edit must not re-ping).
    pre_set: set[tuple[int, int]] = {
        (m["type"], int(m["id"])) for m in pre_existing.get(msg.id, [])
    }
    raw_mentions = parse_markers(payload.content)
    valid_mentions = await filter_to_valid(
        session,
        guild_id=guild_id_for_mentions,
        author_permissions=perms,
        candidates=raw_mentions,
        dm_participant_ids=dm_participant_ids,
    )
    await persist_for_message(
        session, message_id=msg.id, mentions=valid_mentions, replace=True
    )
    await session.commit()
    # Purge S3 objects only after a successful commit — if commit had failed
    # the DB rows would have been rolled back (deleted_at stays NULL) so the
    # files would still be referenced.  See s3_keys_to_purge populated above.
    if s3_keys_to_purge:
        await _purge_s3_keys(s3_keys_to_purge)
    await session.refresh(msg)

    reactions = (await _reactions_for(session, [msg.id], current.id)).get(msg.id, [])
    attachments = (await serialize_attachments(session, [msg.id])).get(msg.id, [])
    atts_serial = [a.model_dump(mode="json") for a in attachments]
    mentions_serial = serialize_mention_targets(valid_mentions)
    payload_out = serialize_message(
        msg, reactions, attachments=atts_serial, mentions=mentions_serial
    )
    await _broadcast(
        request, msg.channel_id, MessageUpdateEvent(data=payload_out)
    )
    # Only fan out mention_added for *newly* added markers — user, role or
    # everyone alike. ``fan_out_mention_events`` then expands + VIEW-filters
    # the new set and returns the concrete recipients for the push fan-out.
    new_mentions = valid_mentions - pre_set
    if new_mentions:
        notified = await fan_out_mention_events(
            request,
            session=session,
            mentions=new_mentions,
            message_id=msg.id,
            channel_id=msg.channel_id,
            guild_id=guild_id_for_mentions,
            author_id=current.id,
        )
        if notified:
            await fan_out_mention_push(
                user_ids=notified,
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
    # Moderator-deleted someone else's message (guild only — DMs 403 above for
    # non-authors). Self-deletes are not audited.
    if msg.author_id != current.id and kind != "dm":
        await write_audit_log(
            session,
            guild_id=ch.guild_id,
            actor_user_id=current.id,
            action_type="message_delete",
            target_kind="message",
            target_id=msg.id,
            payload={
                "channel_id": str(msg.channel_id),
                "author_id": str(msg.author_id),
            },
        )
    # Reactions are no longer meaningful once the message is gone.
    await session.execute(
        delete(MessageReaction).where(MessageReaction.message_id == msg.id)
    )
    # Mentions: no FK cascade on soft-delete → clean up explicitly.
    await session.execute(
        delete(MessageMention).where(MessageMention.message_id == msg.id)
    )
    # Attachments → hard-delete from MinIO + tombstone row. The message
    # itself stays soft-deleted (audit trail) but the bytes go away to
    # free storage.
    # Collect S3 keys + tombstone the rows here, but purge MinIO only AFTER a
    # successful commit — if the commit rolls back, deleted_at stays NULL and
    # the bytes are still referenced (see edit_message for the same pattern).
    s3_keys_to_purge: list[str] = []
    await hard_delete_attachments(
        session, message_ids=[msg.id], defer_s3=s3_keys_to_purge
    )
    await session.commit()
    await _purge_s3_keys(s3_keys_to_purge)

    await _broadcast(
        request,
        msg.channel_id,
        MessageDeleteEvent(
            data=MessageDeleteData(
                id=str(msg.id), channel_id=str(msg.channel_id)
            )
        ),
    )
    return None


__all__ = ["router", "serialize_message", "_reactions_for", "_broadcast"]
