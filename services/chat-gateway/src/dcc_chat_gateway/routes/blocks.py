"""User-block routes — Etappe 1 of the
Voll-Discord-Freundschaftssystem.

POST /blocks      — block ``target_user_id``. Atomically tears down
                    any existing friendship and pending friend
                    requests in both directions. Idempotent: blocking
                    an already-blocked user returns 200 (not 409).
DELETE /blocks/{user_id} — unblock.
GET /blocks       — list the caller's blocks.

A block is *directional* (one row per (blocker, blocked)) but
``friend_helpers.block_exists_either_way`` consults both directions —
a single block in either direction is enough to gate
friend-requests / DMs in both directions.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import and_, or_, select
from sqlalchemy import delete as sa_delete
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_events import publish_friend_event
from dcc_chat_gateway.friend_helpers import sort_pair
from dcc_chat_gateway.friend_schemas import BlockOut, CreateBlockIn
from dcc_chat_gateway.models import FriendRequest, Friendship, UserBlock
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(dependencies=[CloudOnly])


@router.post("/blocks", response_model=BlockOut)
async def create_block(
    payload: CreateBlockIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Block ``target_user_id``.

    Atomic sweep:
      1. existing friendship (sorted-pair row) → DELETE
      2. friend-requests in both directions → DELETE
      3. block row → INSERT (or no-op if already present)

    Idempotent on re-block: existing row returned as 200, no 409.
    """
    target = payload.target_user_id
    me = current.id
    if target == me:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="cannot_block_yourself"
        )

    # Existing block? Return it as-is (idempotent).
    existing = await session.get(UserBlock, (me, target))
    if existing is not None:
        return BlockOut(user_id=existing.blocked_id, since=existing.created_at)

    # Tear down pending requests + friendship in the same TX as the block
    # insert so we never end up with "friend AND blocked" or "block AND a
    # stale pending request".
    #
    # Order matters here: the FriendRequest delete goes FIRST, and the
    # Friendship check+delete comes AFTER it. ``friends.py``'s accept path
    # (``accept_friend_request`` and the auto-accept branch of
    # ``create_friend_request``) holds a ``SELECT … FOR UPDATE`` lock on the
    # relevant FriendRequest row for the duration of its friendship-install.
    # On Postgres, our DELETE below has to wait for that row lock to
    # release before it can proceed — so by the time we get past it, any
    # friendship a concurrent accept just installed is already visible.
    # Checking friendship-existence BEFORE this wait (the old order) let a
    # concurrent accept slip a friendship in during the gap, producing
    # "blocked AND friends" — exactly the state this transaction exists to
    # prevent. We capture whether a friendship existed so we can emit
    # friend_removed events (the block is private to the blocker, but the
    # friendship tear-down is a state change the other party legitimately
    # needs to know about — they'd otherwise keep a stale entry in their
    # friend list).
    lo, hi = sort_pair(me, target)
    await session.execute(
        sa_delete(FriendRequest).where(
            or_(
                and_(
                    FriendRequest.sender_id == me,
                    FriendRequest.receiver_id == target,
                ),
                and_(
                    FriendRequest.sender_id == target,
                    FriendRequest.receiver_id == me,
                ),
            )
        )
    )
    friendship_existed = (
        await session.execute(
            select(Friendship.user_a_id).where(
                Friendship.user_a_id == lo, Friendship.user_b_id == hi
            )
        )
    ).first() is not None
    await session.execute(
        sa_delete(Friendship).where(
            Friendship.user_a_id == lo, Friendship.user_b_id == hi
        )
    )
    block = UserBlock(blocker_id=me, blocked_id=target)
    session.add(block)
    try:
        await session.commit()
    except IntegrityError:
        # Concurrent block install — refetch and return success.
        await session.rollback()
        existing = await session.get(UserBlock, (me, target))
        if existing is None:
            raise HTTPException(500, detail="block_race_lost")
        block = existing
    await session.refresh(block)

    # WS fan-out: user_blocked goes ONLY to the blocker (no leak to the
    # blocked party that they were just blocked — Discord parity). If a
    # friendship was torn down by this block, the *other* party gets a
    # friend_removed so their UI drops the stale entry; the blocker
    # already knows from the response shape.
    await publish_friend_event(
        request, target_user_id=me, op="user_blocked", data={"user_id": str(target)}
    )
    if friendship_existed:
        await publish_friend_event(
            request,
            target_user_id=target,
            op="friend_removed",
            data={"user_id": str(me)},
        )
    return BlockOut(user_id=block.blocked_id, since=block.created_at)


@router.delete(
    "/blocks/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_block(
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    me = current.id
    result = await session.execute(
        sa_delete(UserBlock).where(
            UserBlock.blocker_id == me, UserBlock.blocked_id == user_id
        )
    )
    if result.rowcount == 0:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="block_not_found"
        )
    await session.commit()
    # user_unblocked goes ONLY to the unblocker — same no-leak policy as
    # user_blocked (the formerly-blocked party gets nothing).
    await publish_friend_event(
        request,
        target_user_id=me,
        op="user_unblocked",
        data={"user_id": str(user_id)},
    )
    return None


@router.get("/blocks", response_model=list[BlockOut])
async def list_blocks(session: SessionDep, current: CurrentUser):
    me = current.id
    stmt = (
        select(UserBlock)
        .where(UserBlock.blocker_id == me)
        .order_by(UserBlock.created_at.desc())
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [BlockOut(user_id=r.blocked_id, since=r.created_at) for r in rows]
