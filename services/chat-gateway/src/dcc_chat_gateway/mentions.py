"""Parser + persistence helpers for @-mentions.

A message's ``content`` carries Discord-style markers:

  - ``<@123>``  — user mention, ``123`` is the user snowflake.
  - ``<@&456>`` — role mention, ``456`` is the role snowflake.
  - ``@everyone`` / ``@here`` — everyone mention (treated identically;
    we only persist one ``everyone`` row per message no matter how many
    times the marker appears).

This module owns:

  * the regex used to recognise markers in arbitrary text,
  * ``parse_markers`` — a pure-function step the route layer calls *after*
    REST validation but *before* DB writes — returns a normalised set
    of ``(mention_type, target_id)`` tuples,
  * ``filter_to_valid`` — async helper that drops markers that don't
    point at real Guild members / mentionable roles, honouring
    ``MENTION_EVERYONE`` for the override-to-mention-locked-roles case,
  * ``persist_for_message`` — replaces the row set for a given message
    (used by both POST and PATCH /messages, since edits re-compute).

Lives outside ``routes/messages.py`` to keep that file inside the
350-line soft cap from PLAN.md §12.1.
"""

from __future__ import annotations

import asyncio
import logging
import re

from dcc_shared.events import MentionAddedData, MentionAddedEvent
from dcc_shared.permission_resolver import has_permission
from dcc_shared.permissions import Permissions
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from dcc_chat_gateway.models import (
    MENTION_EVERYONE_TARGET_ID,
    MENTION_TYPE_EVERYONE,
    MENTION_TYPE_ROLE,
    MENTION_TYPE_USER,
    GuildMember,
    MemberRole,
    MessageMention,
    Role,
    UserBlock,
)
from dcc_chat_gateway.permissions import members_who_can_view

log = logging.getLogger(__name__)

# Discord-style markers. ``<@123>`` for users, ``<@&456>`` for roles.
# Both flavours accept any decimal id; route-side validation filters
# out non-members / non-mentionable roles afterwards.
_MENTION_USER_RE = re.compile(r"<@(\d{1,20})>")
_MENTION_ROLE_RE = re.compile(r"<@&(\d{1,20})>")

# ``@everyone`` / ``@here`` as standalone tokens (word boundary).
# Same shape as the one previously inlined in routes/messages.py — the
# route still owns the permission-reject (we just expose the regex).
MENTION_EVERYONE_RE = re.compile(r"@(everyone|here)\b")


def parse_markers(content: str) -> set[tuple[int, int]]:
    """Extract every well-formed mention marker from ``content``.

    Returns a set of ``(mention_type, target_id)`` tuples. Deduplication
    is intentional — the on-disk PK is ``(message, type, target)`` so a
    user spamming ``<@123> <@123> <@123>`` still produces one row, and
    re-firing the per-user ``mention_added`` envelope per repetition
    would be a notification-spam vector.

    Pure function; no DB, no permission knowledge. Caller layers the
    validation (member-of-guild, role mentionable, ``MENTION_EVERYONE``)
    on top via ``filter_to_valid``.
    """
    out: set[tuple[int, int]] = set()
    for m in _MENTION_USER_RE.finditer(content):
        try:
            out.add((MENTION_TYPE_USER, int(m.group(1))))
        except ValueError:
            continue
    for m in _MENTION_ROLE_RE.finditer(content):
        try:
            out.add((MENTION_TYPE_ROLE, int(m.group(1))))
        except ValueError:
            continue
    if MENTION_EVERYONE_RE.search(content):
        out.add((MENTION_TYPE_EVERYONE, MENTION_EVERYONE_TARGET_ID))
    return out


async def filter_to_valid(
    session: AsyncSession,
    *,
    guild_id: int | None,
    author_permissions: int,
    candidates: set[tuple[int, int]],
) -> set[tuple[int, int]]:
    """Drop mentions that wouldn't ping anybody.

    Rules:
      * User-mentions only count if the target is a current member of
        ``guild_id``. (For DMs, ``guild_id`` is ``None`` — we trust the
        marker as-is; the DM has only two members and either can ping
        the other.)
      * Role-mentions count if the role is in this guild AND either
        ``mentionable=true`` or the author holds ``MENTION_EVERYONE``
        (Discord's escape-hatch for moderators to ping a locked role).
        DMs have no roles, so all role-markers are silently dropped.
      * ``everyone`` markers pass through unchanged — the route layer
        already enforces ``MENTION_EVERYONE`` upstream (Permission
        check + 403). We only land here when that check passed.

    Returns a possibly-smaller set in the same shape as the input.
    """
    if not candidates:
        return candidates

    user_targets = {tid for (t, tid) in candidates if t == MENTION_TYPE_USER}
    role_targets = {tid for (t, tid) in candidates if t == MENTION_TYPE_ROLE}

    valid_users: set[int] = set()
    valid_roles: set[int] = set()

    if guild_id is not None and user_targets:
        rows = (
            await session.execute(
                select(GuildMember.user_id).where(
                    GuildMember.guild_id == guild_id,
                    GuildMember.user_id.in_(user_targets),
                )
            )
        ).all()
        valid_users = {r[0] for r in rows}
    elif guild_id is None and user_targets:
        # DM channel: no guild membership to check against. Accept the
        # marker — the channel is by definition a two-person room, and
        # the recipient resolves who actually got pinged on their end.
        valid_users = set(user_targets)

    if guild_id is not None and role_targets:
        rows = (
            await session.execute(
                select(Role.id, Role.mentionable).where(
                    Role.guild_id == guild_id, Role.id.in_(role_targets)
                )
            )
        ).all()
        author_can_override = has_permission(
            author_permissions, Permissions.MENTION_EVERYONE
        )
        for rid, mentionable in rows:
            if mentionable or author_can_override:
                valid_roles.add(rid)

    out: set[tuple[int, int]] = set()
    if (MENTION_TYPE_EVERYONE, MENTION_EVERYONE_TARGET_ID) in candidates:
        out.add((MENTION_TYPE_EVERYONE, MENTION_EVERYONE_TARGET_ID))
    out.update((MENTION_TYPE_USER, uid) for uid in valid_users)
    out.update((MENTION_TYPE_ROLE, rid) for rid in valid_roles)
    return out


async def persist_for_message(
    session: AsyncSession,
    *,
    message_id: int,
    mentions: set[tuple[int, int]],
    replace: bool,
) -> None:
    """Write the mention rows for ``message_id``.

    ``replace=True`` is the edit path: any existing rows for this
    message are removed first so the edit's set is authoritative. The
    PK is ``(message, type, target)``; deleting + reinserting is
    simpler than diffing, and edits are rare enough that we don't need
    the cleverness. Bulk insert when there's anything to write.
    """
    if replace:
        await session.execute(
            delete(MessageMention).where(MessageMention.message_id == message_id)
        )
    if not mentions:
        return
    session.add_all(
        [
            MessageMention(
                message_id=message_id,
                mention_type=t,
                target_id=tid,
            )
            for (t, tid) in mentions
        ]
    )


async def mentions_for(
    session: AsyncSession, message_ids: list[int]
) -> dict[int, list[dict]]:
    """Return ``{message_id: [{"type": int, "id": str}, ...]}``.

    Empty input → empty output. One round-trip, ordered for stable
    output (FE may render mention chips in insertion order)."""
    if not message_ids:
        return {}
    rows = (
        await session.execute(
            select(MessageMention)
            .where(MessageMention.message_id.in_(message_ids))
            .order_by(MessageMention.message_id, MessageMention.mention_type, MessageMention.target_id)
        )
    ).scalars().all()
    out: dict[int, list[dict]] = {}
    for m in rows:
        out.setdefault(m.message_id, []).append(
            {"type": m.mention_type, "id": str(m.target_id)}
        )
    return out


def serialize_mentions(rows: list[MessageMention] | None) -> list[dict]:
    """Wire shape: ``[{"type": int, "id": str}]``.

    Snowflake-ish ids cross the API boundary as strings (CLAUDE.md).
    ``everyone`` carries the sentinel ``"0"`` — the frontend can
    branch on ``type == 2`` and ignore the id.
    """
    if not rows:
        return []
    return [
        {"type": m.mention_type, "id": str(m.target_id)}
        for m in rows
    ]


async def _expand_mention_targets(
    session: AsyncSession,
    mentions: set[tuple[int, int]],
    *,
    channel_id: int,
    guild_id: int | None,
    author_id: int,
) -> set[int]:
    """Resolve mention markers to a concrete recipient user-id set.

    User markers are taken at face value (``filter_to_valid`` already
    confirmed guild membership). Role markers expand to every holder of
    the role; ``everyone``/``here`` expands to every guild member. Both
    of the latter are intersected with the members who can actually
    ``VIEW_CHANNEL`` the channel — nobody should get a mention badge for
    a channel they cannot open. The author is always dropped.
    """
    targets: set[int] = {tid for (t, tid) in mentions if t == MENTION_TYPE_USER}
    role_ids = {tid for (t, tid) in mentions if t == MENTION_TYPE_ROLE}
    has_everyone = (MENTION_TYPE_EVERYONE, MENTION_EVERYONE_TARGET_ID) in mentions
    # Role + everyone expansion is guild-only — DMs have neither.
    if guild_id is not None and (role_ids or has_everyone):
        viewers = await members_who_can_view(session, guild_id, channel_id)
        if has_everyone:
            targets |= viewers
        if role_ids:
            holders = {
                uid
                for (uid,) in (
                    await session.execute(
                        select(MemberRole.user_id).where(
                            MemberRole.guild_id == guild_id,
                            MemberRole.role_id.in_(role_ids),
                        )
                    )
                ).all()
            }
            targets |= holders & viewers
    targets.discard(author_id)
    return targets


async def fan_out_mention_events(
    conn: HTTPConnection,
    *,
    session: AsyncSession,
    mentions: set[tuple[int, int]],
    message_id: int,
    channel_id: int,
    guild_id: int | None,
    author_id: int,
) -> set[int]:
    """Direct-deliver ``mention_added`` to every pinged user's sockets.

    Expands the three marker kinds to a concrete recipient set:
      * user markers   → the target user,
      * role markers   → every member holding that role,
      * everyone/here  → every guild member,
    with role + everyone recipients intersected with the members who can
    ``VIEW_CHANNEL`` the channel (see ``_expand_mention_targets``).

    The channel-scoped ``message`` broadcast still carries the full
    ``mentions`` array for pill rendering; this is the *cross-channel*
    path so a client with the channel closed still bumps its counter —
    crucially also for role / everyone pings, which the ``message``
    envelope alone would never surface to a non-subscribed client.

    Returns the recipient user-id set so the caller can drive web-push
    to the same audience. Empty when nobody is pinged or no manager is
    wired up.
    """
    mgr = getattr(conn.app.state, "connection_manager", None)
    if mgr is None:
        return set()
    targets = await _expand_mention_targets(
        session,
        mentions,
        channel_id=channel_id,
        guild_id=guild_id,
        author_id=author_id,
    )
    if not targets:
        return set()
    # Etappe-2 block filter: a receiver who blocked the author (in either
    # direction) must not get a mention_added envelope — the channel-scoped
    # `message` envelope still fans out (no per-user channel hide today),
    # but the cross-channel counter bump is gated. Per-socket cache fast
    # path first; cold-cache receivers use a single batched SELECT.

    # Fast path: strip targets whose block status is already in the WS cache.
    cache_unknown: set[int] = set()
    filtered: set[int] = set()
    for uid in targets:
        if mgr.is_blocked_by_any_socket(uid, author_id):
            continue
        cache_unknown.add(uid)

    # Batch block-check for all remaining targets in a single SQL query.
    if cache_unknown:
        blocked_rows = (
            await session.execute(
                select(UserBlock.blocker_id, UserBlock.blocked_id).where(
                    (
                        (UserBlock.blocker_id == author_id)
                        & UserBlock.blocked_id.in_(cache_unknown)
                    )
                    | (
                        (UserBlock.blocked_id == author_id)
                        & UserBlock.blocker_id.in_(cache_unknown)
                    )
                )
            )
        ).all()
        blocked_uids: set[int] = set()
        for blocker, blocked in blocked_rows:
            other = blocked if blocker == author_id else blocker
            blocked_uids.add(other)
        for uid in cache_unknown:
            if uid not in blocked_uids:
                filtered.add(uid)
    if not filtered:
        return set()

    envelope = MentionAddedEvent(
        data=MentionAddedData(
            channel_id=str(channel_id),
            message_id=str(message_id),
            guild_id=str(guild_id) if guild_id is not None else None,
        ),
    )

    async def _publish_one(uid: int) -> None:
        try:
            await mgr.publish_user_event(uid, envelope)
        except Exception:
            log.exception("publish_user_event failed for user %s", uid)

    await asyncio.gather(*(_publish_one(uid) for uid in filtered))
    return filtered


__all__ = [
    "MENTION_EVERYONE_RE",
    "fan_out_mention_events",
    "filter_to_valid",
    "mentions_for",
    "parse_markers",
    "persist_for_message",
    "serialize_mentions",
]
