"""Direct-message channel routes (1:1 DMs).

A DM channel is created on first contact (idempotent POST) and stored
with a sorted (user_a < user_b) pair, enforced by CHECK + UNIQUE — so
A↔B and B↔A always resolve to the same row.

No friends-system / no opt-in in Phase 1: anyone can DM anyone whose
user-id they know. Spam is mitigated by the existing global message
rate-limit (``ratelimit.py``).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DirectMessageChannel
from dcc_chat_gateway.routes._deps import dm_member_check
from dcc_chat_gateway.schemas import DMChannelCreateIn, DMChannelOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


def _wire(dm: DirectMessageChannel, caller_id: int) -> dict[str, object]:
    """Wire shape with ``other_user_id`` computed from the caller's
    perspective — the table stores a sorted pair, but the client wants
    'who is the other person in this DM'."""
    other = dm.user_b_id if caller_id == dm.user_a_id else dm.user_a_id
    return {
        "id": dm.id,
        "other_user_id": other,
        "last_message_id": dm.last_message_id,
        "created_at": dm.created_at,
    }


async def _find_pair(session, a: int, b: int) -> DirectMessageChannel | None:
    stmt = select(DirectMessageChannel).where(
        DirectMessageChannel.user_a_id == a,
        DirectMessageChannel.user_b_id == b,
    )
    return (await session.execute(stmt)).scalars().first()


@router.post("/dm-channels", response_model=DMChannelOut, status_code=status.HTTP_201_CREATED)
async def create_or_get_dm_channel(
    payload: DMChannelCreateIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Idempotent create-or-fetch of a 1:1 DM with ``target_user_id``.

    Returns the existing channel if one already exists between this
    pair (in either order). Self-DMs are rejected.
    """
    target = payload.target_user_id
    if target == current.id:
        raise HTTPException(400, detail="cannot DM yourself")

    a, b = sorted((current.id, target))

    existing = await _find_pair(session, a, b)
    if existing is not None:
        return _wire(existing, current.id)

    dm = DirectMessageChannel(id=next_id(), user_a_id=a, user_b_id=b)
    session.add(dm)
    try:
        await session.commit()
    except IntegrityError:
        # Concurrent create raced us to the UNIQUE constraint — re-fetch.
        await session.rollback()
        existing = await _find_pair(session, a, b)
        if existing is None:
            raise HTTPException(500, detail="dm creation race lost")
        return _wire(existing, current.id)
    await session.refresh(dm)
    return _wire(dm, current.id)


@router.get("/dm-channels", response_model=list[DMChannelOut])
async def list_dm_channels(
    session: SessionDep,
    current: CurrentUser,
):
    """All DM channels the caller is a member of, newest-active first."""
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
    return [_wire(d, current.id) for d in rows]


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
    return _wire(dm, current.id)
