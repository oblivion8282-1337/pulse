"""User-account purge orchestration — called by auth-svc when a user
self-deletes their account.

Hard-delete (not anonymize). Owner-of-guild → guild gets nuked with it
(Discord-style "owner leaves" semantics; UI can offer an
owner-transfer dance *before* the user reaches this endpoint).

All DB work happens inside a single SQLAlchemy transaction so a half-
purge can't leave dangling rows. Redis cleanup (voice presence + HQ
stream-active keys) is best-effort and runs *after* the DB commit —
the LiveKit webhook + media-svc poller would self-heal them anyway,
this is just to make the user's UI snap to the right state without
waiting for the next poll tick.

Importable for tests; the route in ``routes/internal.py`` is a thin
auth-+-glue wrapper around ``purge_user``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import (
    MENTION_TYPE_USER,
    Channel,
    DirectMessageChannel,
    FriendRequest,
    Friendship,
    Guild,
    GuildBan,
    GuildMember,
    MemberRole,
    Message,
    MessageAttachment,
    MessageMention,
    MessageReaction,
    PermissionOverwrite,
    UserBlock,
    UserPrivacy,
    WebPushSubscription,
)
from dcc_chat_gateway.routes.attachments import hard_delete_attachments

if TYPE_CHECKING:
    from dcc_chat_gateway.pubsub import ConnectionManager

log = logging.getLogger(__name__)

# permission_overwrites.target_type sentinel for user-scoped rows
# (role-scoped = 0). Mirrors the constants used by routes/permission_overwrites.
_OVERWRITE_TARGET_USER = 1


async def _collect_owned_guild_ids(session: AsyncSession, user_id: int) -> list[int]:
    stmt = select(Guild.id).where(Guild.owner_id == user_id)
    return list((await session.execute(stmt)).scalars())


async def _collect_dm_channel_ids(session: AsyncSession, user_id: int) -> list[int]:
    stmt = select(DirectMessageChannel.id).where(
        or_(
            DirectMessageChannel.user_a_id == user_id,
            DirectMessageChannel.user_b_id == user_id,
        )
    )
    return list((await session.execute(stmt)).scalars())


async def _hard_delete_guild_with_attachments(
    session: AsyncSession, guild_id: int
) -> None:
    """``session.delete(guild)`` cascades channels/messages/members/etc.
    via the FK schema, but MinIO objects need an explicit sweep first
    (see ``routes/guilds.py::delete_guild`` for the same pattern)."""
    channel_ids_stmt = select(Channel.id).where(Channel.guild_id == guild_id)
    channel_ids = list((await session.execute(channel_ids_stmt)).scalars())
    if channel_ids:
        att_ids_stmt = select(MessageAttachment.id).where(
            MessageAttachment.channel_id.in_(channel_ids),
            MessageAttachment.deleted_at.is_(None),
        )
        att_ids = list((await session.execute(att_ids_stmt)).scalars())
        if att_ids:
            await hard_delete_attachments(session, attachment_ids=att_ids)
    guild = await session.get(Guild, guild_id)
    if guild is not None:
        await session.delete(guild)


async def _delete_user_authored_messages(
    session: AsyncSession, user_id: int
) -> None:
    """Hard-delete every message the user wrote (across all channels +
    DMs). FK CASCADE on ``message_id`` clears reactions / mentions /
    attachments rows; MinIO objects need the helper sweep."""
    msg_ids_stmt = select(Message.id).where(Message.author_id == user_id)
    msg_ids = list((await session.execute(msg_ids_stmt)).scalars())
    if not msg_ids:
        return
    await hard_delete_attachments(session, message_ids=msg_ids)
    await session.execute(sa_delete(Message).where(Message.id.in_(msg_ids)))


async def _delete_dm_channels(
    session: AsyncSession, dm_channel_ids: Iterable[int]
) -> None:
    """Delete every DM channel the user participated in + every message
    posted in them. DM channels are 1:1, so the other side has nobody
    left to chat with via this record anyway."""
    cids = list(dm_channel_ids)
    if not cids:
        return
    # MinIO objects on remaining messages (posted by the other party).
    att_ids_stmt = select(MessageAttachment.id).where(
        MessageAttachment.channel_id.in_(cids),
        MessageAttachment.deleted_at.is_(None),
    )
    att_ids = list((await session.execute(att_ids_stmt)).scalars())
    if att_ids:
        await hard_delete_attachments(session, attachment_ids=att_ids)
    await session.execute(sa_delete(Message).where(Message.channel_id.in_(cids)))
    await session.execute(
        sa_delete(DirectMessageChannel).where(DirectMessageChannel.id.in_(cids))
    )


async def _purge_db(session: AsyncSession, user_id: int) -> list[int]:
    """Single-transaction DB sweep. Returns the list of owned-guild IDs
    that got hard-deleted (caller fan-outs ``guild_deleted`` events)."""
    # 1. Owned guilds → cascade-delete (must happen before membership
    # cleanup so the cascade can find this user's GuildMember row too).
    owned_guild_ids = await _collect_owned_guild_ids(session, user_id)
    for gid in owned_guild_ids:
        await _hard_delete_guild_with_attachments(session, gid)

    # 2. Memberships in non-owned guilds — composite-FK on member_roles
    # cascades the role assignments.
    await session.execute(
        sa_delete(GuildMember).where(GuildMember.user_id == user_id)
    )
    # 2b. Belt-and-suspenders: explicit member_roles delete in case the
    # FK cascade has been stripped by a future schema change.
    await session.execute(
        sa_delete(MemberRole).where(MemberRole.user_id == user_id)
    )

    # 3. User-scoped channel overwrites.
    await session.execute(
        sa_delete(PermissionOverwrite).where(
            PermissionOverwrite.target_type == _OVERWRITE_TARGET_USER,
            PermissionOverwrite.target_id == user_id,
        )
    )

    # 4. User-authored messages (cascades reactions/mentions/attachments).
    await _delete_user_authored_messages(session, user_id)

    # 5. User's reactions on other users' messages.
    await session.execute(
        sa_delete(MessageReaction).where(MessageReaction.user_id == user_id)
    )

    # 6. Mentions that *targeted* the user. The ``<@uid>`` marker in the
    # raw message content stays — the frontend renders deleted users as
    # "@unknown" anyway (userCache miss).
    await session.execute(
        sa_delete(MessageMention).where(
            MessageMention.target_id == user_id,
            MessageMention.mention_type == MENTION_TYPE_USER,
        )
    )

    # 7. Ban records both ways — by self-delete the user no longer
    # exists so historical bans against them are moot; bans they issued
    # also drop (we don't keep a "banned by deleted user" tombstone).
    await session.execute(
        sa_delete(GuildBan).where(
            or_(GuildBan.user_id == user_id, GuildBan.banned_by_id == user_id)
        )
    )

    # 8. Web-Push subs.
    await session.execute(
        sa_delete(WebPushSubscription).where(WebPushSubscription.user_id == user_id)
    )

    # 9. DM channels the user was a participant in (1:1 → drop the
    # whole channel + every message in it).
    dm_ids = await _collect_dm_channel_ids(session, user_id)
    await _delete_dm_channels(session, dm_ids)

    # 10. Friendship system (Etappe 1): friendships, pending friend-
    # requests, blocks both directions, privacy row. Same pattern as
    # the DM cleanup — drop every row that mentions the user.
    await session.execute(
        sa_delete(Friendship).where(
            or_(
                Friendship.user_a_id == user_id,
                Friendship.user_b_id == user_id,
            )
        )
    )
    await session.execute(
        sa_delete(FriendRequest).where(
            or_(
                FriendRequest.sender_id == user_id,
                FriendRequest.receiver_id == user_id,
            )
        )
    )
    await session.execute(
        sa_delete(UserBlock).where(
            or_(
                UserBlock.blocker_id == user_id,
                UserBlock.blocked_id == user_id,
            )
        )
    )
    await session.execute(
        sa_delete(UserPrivacy).where(UserPrivacy.user_id == user_id)
    )

    return owned_guild_ids


async def _cleanup_redis(redis: Any, user_id: int) -> None:
    """Best-effort: clear voice-presence + HQ-stream-active keys for
    the purged user. Failures are logged + swallowed — the LiveKit
    webhook + media-svc poller self-heal these on their next tick."""
    if redis is None:
        return
    uid_str = str(user_id)
    # voice:room:channel-*  (member set) + :streaming (per-channel
    # browser-screenshare flag). We SCAN-iterate to avoid loading
    # every voice room key at once on a big deployment.
    try:
        async for key in redis.scan_iter(match="voice:room:channel-*", count=200):
            try:
                # SCAN can yield bytes; SREM tolerates both.
                await redis.srem(key, uid_str)
            except Exception:  # noqa: BLE001
                log.warning("purge: srem failed for %s", key, exc_info=True)
    except Exception:  # noqa: BLE001
        log.warning("purge: voice-room scan failed", exc_info=True)

    # stream:active:channel-<cid>-<uid> — per-user HQ-stream marker.
    try:
        pattern = f"stream:active:channel-*-{uid_str}"
        async for key in redis.scan_iter(match=pattern, count=200):
            try:
                await redis.delete(key)
            except Exception:  # noqa: BLE001
                log.warning("purge: del failed for %s", key, exc_info=True)
    except Exception:  # noqa: BLE001
        log.warning("purge: stream-active scan failed", exc_info=True)


async def purge_user(
    session: AsyncSession,
    user_id: int,
    *,
    manager: ConnectionManager | None = None,
    redis: Any = None,
) -> dict[str, Any]:
    """Run the full purge for ``user_id`` and broadcast lifecycle
    events. Idempotent — second call is a no-op (all DELETEs are
    where-clauses).

    Returns ``{"deleted_guild_ids": [...]}`` so the caller can log /
    assert in tests.
    """
    try:
        deleted_guild_ids = await _purge_db(session, user_id)
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    # Broadcast guild_deleted *after* commit so subscribers can't see
    # an inconsistent half-state if they round-trip back to the API.
    if manager is not None:
        for gid in deleted_guild_ids:
            try:
                await manager.publish_guild_event(
                    {"op": "guild_deleted", "guild_id": str(gid)}
                )
            except Exception:  # noqa: BLE001
                log.warning("purge: guild_deleted publish failed", exc_info=True)
    await _cleanup_redis(redis, user_id)
    return {"deleted_guild_ids": [str(g) for g in deleted_guild_ids]}
