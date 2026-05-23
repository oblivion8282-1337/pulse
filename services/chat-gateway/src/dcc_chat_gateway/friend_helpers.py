"""Shared helpers for the friends / blocks / privacy routes.

Lifted out of ``routes/friends.py`` so each route module stays under
the 350-line soft cap (PLAN.md §12.1).
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import and_, or_, select

from dcc_chat_gateway.friend_privacy import (
    FRIEND_REQ_POLICY_EVERYONE,
    FRIEND_REQ_POLICY_NOBODY,
    FRIEND_REQ_POLICY_SERVER_MEMBERS,
)
from dcc_chat_gateway.models import (
    FriendRequest,
    Friendship,
    GuildMember,
    UserBlock,
    UserPrivacy,
)


def sort_pair(a: int, b: int) -> tuple[int, int]:
    """Return ``(a, b)`` sorted ascending — matches the
    ``user_a < user_b`` invariant on ``friendships``."""
    return (a, b) if a < b else (b, a)


async def friendship_exists(session, a: int, b: int) -> bool:
    lo, hi = sort_pair(a, b)
    stmt = select(Friendship.user_a_id).where(
        Friendship.user_a_id == lo, Friendship.user_b_id == hi
    )
    return (await session.execute(stmt)).first() is not None


async def block_exists_either_way(session, a: int, b: int) -> bool:
    """True if either user has blocked the other."""
    stmt = select(UserBlock.blocker_id).where(
        or_(
            and_(UserBlock.blocker_id == a, UserBlock.blocked_id == b),
            and_(UserBlock.blocker_id == b, UserBlock.blocked_id == a),
        )
    )
    return (await session.execute(stmt)).first() is not None


async def shared_guild_exists(session, a: int, b: int) -> bool:
    """True if ``a`` and ``b`` are both members of at least one
    common guild."""
    a_guilds = select(GuildMember.guild_id).where(GuildMember.user_id == a)
    stmt = (
        select(GuildMember.guild_id)
        .where(GuildMember.user_id == b, GuildMember.guild_id.in_(a_guilds))
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def receiver_friend_req_policy(session, user_id: int) -> int:
    row = await session.get(UserPrivacy, user_id)
    if row is None:
        return FRIEND_REQ_POLICY_EVERYONE
    return row.friend_request_policy


async def check_receiver_accepts_friend_request(
    session, sender_id: int, receiver_id: int
) -> None:
    """Enforce the receiver's friend-request policy. Raises 403 on
    deny. Unknown policy values fall through to deny — safer than
    accidentally opening up via a future migration."""
    policy = await receiver_friend_req_policy(session, receiver_id)
    if policy == FRIEND_REQ_POLICY_EVERYONE:
        return
    if policy == FRIEND_REQ_POLICY_NOBODY:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="receiver_not_accepting_requests",
        )
    if policy == FRIEND_REQ_POLICY_SERVER_MEMBERS:
        if not await shared_guild_exists(session, sender_id, receiver_id):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="receiver_requires_shared_guild",
            )
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN, detail="receiver_not_accepting_requests"
    )


def wire_friendship(row: Friendship, caller_id: int) -> dict[str, object]:
    """Render a friendship row from the caller's perspective —
    ``user_id`` is the *other* member, ``since`` is the row's
    creation timestamp."""
    other = row.user_b_id if caller_id == row.user_a_id else row.user_a_id
    return {"user_id": other, "since": row.created_at}


async def load_request_for_caller(
    session, request_id: int, caller_id: int, *, role: str
) -> FriendRequest:
    """Load a friend-request row + 404 if the caller isn't on the
    requested side. ``role`` is ``"receiver"`` (accept/decline) or
    ``"sender"`` (cancel). 404 rather than 403 keeps existence of the
    row private to the two parties."""
    row = await session.get(FriendRequest, request_id, with_for_update=True)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="friend_request_not_found"
        )
    expected_id = row.receiver_id if role == "receiver" else row.sender_id
    if caller_id != expected_id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="friend_request_not_found"
        )
    return row
