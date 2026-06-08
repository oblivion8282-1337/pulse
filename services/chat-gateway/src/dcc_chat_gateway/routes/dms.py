"""Direct-message channel routes (1:1 DMs).

A DM channel is created on first contact (idempotent POST) and stored
with a sorted (user_a < user_b) pair, enforced by CHECK + UNIQUE — so
A↔B and B↔A always resolve to the same row.

Etappe 2 (Friend-System): DMs are friend-gated — POST /dm-channels
requires an existing friendship and no block in either direction. A
pre-existing DM row (from Phase 1, when DMs were open to all) stays
in the table but its ``can_send`` flag turns false the moment the
friendship is removed or a block is installed — clients show it as a
historical thread without a composer.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import (
    block_exists_either_way,
    friendship_exists,
)
from dcc_chat_gateway.models import DirectMessageChannel, Friendship, UserBlock
from dcc_chat_gateway.routes._deps import CloudOnly, dm_member_check
from dcc_chat_gateway.schemas import DMChannelCreateIn, DMChannelOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(dependencies=[CloudOnly])


def _wire(
    dm: DirectMessageChannel,
    caller_id: int,
    *,
    can_send: bool = True,
) -> dict[str, object]:
    """Wire shape with ``other_user_id`` computed from the caller's
    perspective. ``can_send`` is precomputed by the route since it
    depends on friendship/block state, not the DM row alone."""
    other = dm.user_b_id if caller_id == dm.user_a_id else dm.user_a_id
    return {
        "id": dm.id,
        "other_user_id": other,
        "last_message_id": dm.last_message_id,
        "created_at": dm.created_at,
        "can_send": can_send,
    }


async def _find_pair(session, a: int, b: int) -> DirectMessageChannel | None:
    stmt = select(DirectMessageChannel).where(
        DirectMessageChannel.user_a_id == a,
        DirectMessageChannel.user_b_id == b,
    )
    return (await session.execute(stmt)).scalars().first()


async def ensure_dm_channel(
    session, user_id: int, other_id: int
) -> DirectMessageChannel:
    """Idempotently find-or-create the 1:1 DM channel between two users.

    Pure persistence helper (no friend/block gate, no commit-of-the-caller's
    transaction beyond what creating the row needs): callers that already know
    the pair is allowed to message — e.g. the community-invite broker, where
    inviter and invitee are confirmed friends by the time we get here — can
    reuse the same idempotent sorted-pair logic the route handler uses without
    re-running the friend-gate. Handles the concurrent-create race the same way
    ``create_or_get_dm_channel`` does (re-fetch after the UNIQUE violation).
    """
    a, b = sorted((user_id, other_id))
    existing = await _find_pair(session, a, b)
    if existing is not None:
        return existing
    dm = DirectMessageChannel(id=next_id(), user_a_id=a, user_b_id=b)
    session.add(dm)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing = await _find_pair(session, a, b)
        if existing is None:
            raise
        return existing
    await session.refresh(dm)
    return dm


async def _can_send_batch(
    session, caller_id: int, other_ids: set[int]
) -> dict[int, bool]:
    """Resolve ``can_send`` for every (caller, other) pair in one query.

    A pair is sendable iff a friendship row exists AND no block in either
    direction. With many DMs in the inbox this avoids N round-trips
    (one friendship + one block lookup each)."""
    if not other_ids:
        return {}
    # Friendship is sorted-pair; we normalise per (caller, other) here.
    # Filter to only the other_ids that are actually needed — no point
    # loading rows for friends / blocks that aren't in the current DM set.
    pair_friends: set[frozenset[int]] = set()
    fr_rows = await session.execute(
        select(Friendship.user_a_id, Friendship.user_b_id).where(
            or_(
                Friendship.user_a_id == caller_id,
                Friendship.user_b_id == caller_id,
            ),
            or_(
                Friendship.user_a_id.in_(other_ids),
                Friendship.user_b_id.in_(other_ids),
            ),
        )
    )
    for a, b in fr_rows.all():
        pair_friends.add(frozenset((a, b)))
    # Blocks in either direction between caller and any of the other_ids.
    blocked: set[int] = set()
    bk_rows = await session.execute(
        select(UserBlock.blocker_id, UserBlock.blocked_id).where(
            or_(
                (UserBlock.blocker_id == caller_id)
                & UserBlock.blocked_id.in_(other_ids),
                (UserBlock.blocked_id == caller_id)
                & UserBlock.blocker_id.in_(other_ids),
            )
        )
    )
    for blocker, target in bk_rows.all():
        # The "other party" for this block is whichever one isn't caller.
        other = target if blocker == caller_id else blocker
        blocked.add(other)
    out: dict[int, bool] = {}
    for other in other_ids:
        pair = frozenset((caller_id, other))
        out[other] = pair in pair_friends and other not in blocked
    return out


@router.post(
    "/dm-channels", response_model=DMChannelOut, status_code=status.HTTP_201_CREATED
)
async def create_or_get_dm_channel(
    payload: DMChannelCreateIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Idempotent create-or-fetch of a 1:1 DM with ``target_user_id``.

    Returns the existing channel if one already exists between this
    pair (in either order). Self-DMs are rejected.

    Friend-gated (Etappe 2): blocked → 403 ``blocked``; not friends →
    403 ``not_friends``. Pre-existing rows from Phase 1 stay in the
    table; the friend-gate only governs *new* creates. The same gate
    on the message send-path enforces "no new posts" on tombstone DMs.
    """
    target = payload.target_user_id
    if target == current.id:
        raise HTTPException(400, detail="cannot DM yourself")

    # Block-check is first so a block leaks through as ``blocked`` (the
    # caller can see *they* blocked the other or were blocked — the FE
    # surfaces the right messaging). Friend-check is the harder gate
    # and stays generic so a non-friend target isn't probable for
    # discovery (you'd find them in /users/search anyway).
    if await block_exists_either_way(session, current.id, target):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="blocked")
    if not await friendship_exists(session, current.id, target):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_friends")

    try:
        dm = await ensure_dm_channel(session, current.id, target)
    except IntegrityError as err:
        # Concurrent create raced us to the UNIQUE constraint and the re-fetch
        # still came up empty — surface the same 500 as before.
        raise HTTPException(500, detail="dm creation race lost") from err
    return _wire(dm, current.id, can_send=True)


@router.get("/dm-channels", response_model=list[DMChannelOut])
async def list_dm_channels(
    session: SessionDep,
    current: CurrentUser,
):
    """All DM channels the caller is a member of, newest-active first.

    ``can_send`` is computed per row: True iff the friendship still
    exists and no block was installed. Pre-Phase-2 rows that survive
    the cut surface as historical threads with ``can_send=false``.
    """
    stmt = (
        select(DirectMessageChannel)
        .where(
            or_(
                DirectMessageChannel.user_a_id == current.id,
                DirectMessageChannel.user_b_id == current.id,
            )
        )
        .order_by(
            DirectMessageChannel.last_message_id.desc().nullslast(),
            DirectMessageChannel.id.desc(),
        )
    )
    rows = (await session.execute(stmt)).scalars().all()
    others = {
        d.user_b_id if d.user_a_id == current.id else d.user_a_id
        for d in rows
    }
    can_send = await _can_send_batch(session, current.id, others)
    return [
        _wire(d, current.id, can_send=can_send.get(
            d.user_b_id if d.user_a_id == current.id else d.user_a_id,
            False,
        ))
        for d in rows
    ]


@router.get("/dm-channels/{dm_channel_id}", response_model=DMChannelOut)
async def get_dm_channel(
    dm_channel_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    dm = await dm_member_check(session, dm_channel_id, current.id)
    if dm is None:
        # 404 (not 403) so non-members can't probe channel existence.
        raise HTTPException(404, detail="dm channel not found")
    other = dm.user_b_id if dm.user_a_id == current.id else dm.user_a_id
    can_send_map = await _can_send_batch(session, current.id, {other})
    return _wire(dm, current.id, can_send=can_send_map.get(other, False))
