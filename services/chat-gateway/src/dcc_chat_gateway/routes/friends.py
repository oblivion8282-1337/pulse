"""Friend-request + friendship routes (Etappe 1 of the
Voll-Discord-Freundschaftssystem).

Routes:
  POST   /friend-requests                  create (auto-accept on reverse)
  GET    /friend-requests?direction=...    list incoming + outgoing
  POST   /friend-requests/{id}/accept      receiver-only
  POST   /friend-requests/{id}/decline     receiver-only
  DELETE /friend-requests/{id}             sender-only (cancel)
  GET    /friends                          list friends
  DELETE /friends/{user_id}                unfriend

Cross-cuts: blocks both ways → 403; receiver's friend_request_policy
enforced (everyone / server_members / nobody). Friendship rows store
the sorted user pair (``user_a < user_b``).

Helpers live in ``dcc_chat_gateway.friend_helpers`` to keep this file
under the 350-line soft cap.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete as sa_delete, or_, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_events import publish_friend_event
from dcc_chat_gateway.friend_helpers import (
    block_exists_either_way,
    check_receiver_accepts_friend_request,
    friendship_exists,
    load_request_for_caller,
    sort_pair,
    wire_friendship,
)
from dcc_chat_gateway.friend_schemas import (
    CreateFriendRequestIn,
    FriendOut,
    FriendRequestAutoAcceptOut,
    FriendRequestListOut,
    FriendRequestOut,
)
from dcc_chat_gateway.models import FriendRequest, Friendship
from dcc_chat_gateway.presence_status import _mask, get_presence_status
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


async def _refetch_friendship(session, me: int, other: int) -> Friendship:
    """Look up the friendship row after a concurrent race installed it.
    Raises 500 if it's still absent — that would be a logic bug, not
    a race."""
    lo, hi = sort_pair(me, other)
    existing = (
        await session.execute(
            select(Friendship).where(
                Friendship.user_a_id == lo, Friendship.user_b_id == hi
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        raise HTTPException(500, detail="friendship_race_lost")
    return existing


async def _atomic_install_friendship(
    session, me: int, other: int
) -> Friendship:
    """INSERT a friendship row, surviving a concurrent install."""
    lo, hi = sort_pair(me, other)
    friendship = Friendship(user_a_id=lo, user_b_id=hi)
    session.add(friendship)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        friendship = await _refetch_friendship(session, me, other)
    await session.refresh(friendship)
    return friendship


# ---- POST /friend-requests ------------------------------------------------


@router.post(
    "/friend-requests",
    response_model=FriendRequestOut | FriendRequestAutoAcceptOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_friend_request(
    payload: CreateFriendRequestIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Send a friend request to ``target_user_id``.

    Auto-accepts when the reverse request is already pending — atomic
    in a single TX (SELECT…FOR UPDATE on reverse + DELETE reverse +
    INSERT Friendship) so two concurrent "second-side" POSTs can't
    diverge.
    """
    if not ratelimit_check("friend_request", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )

    target = payload.target_user_id
    me = current.id
    if target == me:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="cannot_friend_yourself"
        )

    if await block_exists_either_way(session, me, target):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="block_in_place"
        )

    if await friendship_exists(session, me, target):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="already_friends"
        )

    # Reverse pending? Auto-accept atomically.
    reverse = (
        await session.execute(
            select(FriendRequest)
            .where(
                FriendRequest.sender_id == target,
                FriendRequest.receiver_id == me,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if reverse is not None:
        await session.execute(
            sa_delete(FriendRequest).where(FriendRequest.id == reverse.id)
        )
        # Drop any forward duplicate that snuck in between checks.
        await session.execute(
            sa_delete(FriendRequest).where(
                FriendRequest.sender_id == me,
                FriendRequest.receiver_id == target,
            )
        )
        friendship = await _atomic_install_friendship(session, me, target)
        # Auto-accept fan-out: both sides get friend_request_accepted so
        # tab-syncing works even though the POSTing tab already knows the
        # outcome from the response. Stale outgoing-request rows for both
        # sides are wiped above; the FE drops them on the event id match.
        # Enrich with each peer's masked presence status — see the standard
        # accept path below for why (Online tab hides status-less peers).
        redis = request.app.state.redis
        try:
            status_target = _mask(await get_presence_status(redis, target))
            status_me = _mask(await get_presence_status(redis, me))
        except Exception:  # noqa: BLE001 — presence enrichment is non-critical
            status_target = status_me = None
        accepted_payload_for_me = {
            "request_id": str(reverse.id),
            "friendship": {
                "user_id": str(target),
                "since": friendship.created_at.isoformat(),
                **({"status": status_target} if status_target else {}),
            },
        }
        accepted_payload_for_target = {
            "request_id": str(reverse.id),
            "friendship": {
                "user_id": str(me),
                "since": friendship.created_at.isoformat(),
                **({"status": status_me} if status_me else {}),
            },
        }
        await publish_friend_event(
            request,
            target_user_id=me,
            op="friend_request_accepted",
            data=accepted_payload_for_me,
        )
        await publish_friend_event(
            request,
            target_user_id=target,
            op="friend_request_accepted",
            data=accepted_payload_for_target,
        )
        return FriendRequestAutoAcceptOut(
            friendship=FriendOut(**wire_friendship(friendship, me))
        )

    # Standard pending path: enforce receiver's policy first.
    await check_receiver_accepts_friend_request(session, me, target)

    existing_forward = (
        await session.execute(
            select(FriendRequest).where(
                FriendRequest.sender_id == me,
                FriendRequest.receiver_id == target,
            )
        )
    ).scalar_one_or_none()
    if existing_forward is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="request_already_pending"
        )

    req = FriendRequest(id=next_id(), sender_id=me, receiver_id=target)
    session.add(req)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing_forward = (
            await session.execute(
                select(FriendRequest).where(
                    FriendRequest.sender_id == me,
                    FriendRequest.receiver_id == target,
                )
            )
        ).scalar_one_or_none()
        if existing_forward is None:
            raise HTTPException(500, detail="friend_request_race_lost")
        req = existing_forward
    await session.refresh(req)
    # friend_request_received → receiver only (sender already has the
    # full envelope in the REST response).
    out = FriendRequestOut.model_validate(req)
    await publish_friend_event(
        request,
        target_user_id=target,
        op="friend_request_received",
        data=out.model_dump(mode="json"),
    )
    return out


# ---- GET /friend-requests -------------------------------------------------


@router.get("/friend-requests", response_model=FriendRequestListOut)
async def list_friend_requests(
    session: SessionDep,
    current: CurrentUser,
    direction: Literal["in", "out", "both"] = Query("both"),
):
    me = current.id
    incoming: list[FriendRequest] = []
    outgoing: list[FriendRequest] = []
    if direction in ("in", "both"):
        stmt = (
            select(FriendRequest)
            .where(FriendRequest.receiver_id == me)
            .order_by(FriendRequest.created_at.desc())
        )
        incoming = list((await session.execute(stmt)).scalars().all())
    if direction in ("out", "both"):
        stmt = (
            select(FriendRequest)
            .where(FriendRequest.sender_id == me)
            .order_by(FriendRequest.created_at.desc())
        )
        outgoing = list((await session.execute(stmt)).scalars().all())
    return {
        "incoming": [FriendRequestOut.model_validate(r) for r in incoming],
        "outgoing": [FriendRequestOut.model_validate(r) for r in outgoing],
    }


# ---- accept / decline / cancel --------------------------------------------


@router.post(
    "/friend-requests/{request_id}/accept", response_model=FriendOut
)
async def accept_friend_request(
    request_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    me = current.id
    row = await load_request_for_caller(session, request_id, me, role="receiver")
    other = row.sender_id

    # Block installed between request-send and accept must invalidate.
    if await block_exists_either_way(session, me, other):
        await session.execute(
            sa_delete(FriendRequest).where(FriendRequest.id == row.id)
        )
        await session.commit()
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="block_in_place"
        )

    await session.execute(
        sa_delete(FriendRequest).where(FriendRequest.id == row.id)
    )
    friendship = await _atomic_install_friendship(session, me, other)
    # If _atomic_install_friendship hit an IntegrityError it rolled back
    # the entire transaction — including the sa_delete above — so the
    # FriendRequest row may still exist. Re-delete it in a separate TX to
    # ensure cleanup regardless of the race outcome.
    await session.execute(
        sa_delete(FriendRequest).where(FriendRequest.id == row.id)
    )
    await session.commit()
    # Carry each side's *current* presence status (invisible→offline masked)
    # so the freshly-added friend renders with the correct online dot right
    # away. Without it the client has no status for the new peer, so the
    # Online tab treats them as offline and hides them until the next
    # ready-frame reseed (i.e. a page reload). Best-effort — a Redis hiccup
    # must never fail the accept, which has already committed.
    redis = request.app.state.redis
    try:
        status_other = _mask(await get_presence_status(redis, other))
        status_me = _mask(await get_presence_status(redis, me))
    except Exception:  # noqa: BLE001 — presence enrichment is non-critical
        status_other = status_me = None
    # Fan-out to BOTH sides so a multi-tab session everywhere converges.
    me_payload = {
        "request_id": str(row.id),
        "friendship": {
            "user_id": str(other),
            "since": friendship.created_at.isoformat(),
            **({"status": status_other} if status_other else {}),
        },
    }
    other_payload = {
        "request_id": str(row.id),
        "friendship": {
            "user_id": str(me),
            "since": friendship.created_at.isoformat(),
            **({"status": status_me} if status_me else {}),
        },
    }
    await publish_friend_event(
        request, target_user_id=me, op="friend_request_accepted", data=me_payload
    )
    await publish_friend_event(
        request, target_user_id=other, op="friend_request_accepted", data=other_payload
    )
    return FriendOut(**wire_friendship(friendship, me))


@router.post(
    "/friend-requests/{request_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def decline_friend_request(
    request_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    me = current.id
    row = await load_request_for_caller(session, request_id, me, role="receiver")
    sender_id = row.sender_id
    await session.execute(
        sa_delete(FriendRequest).where(FriendRequest.id == row.id)
    )
    await session.commit()
    # The receiver (caller) trivially knows from the 204; only the sender
    # needs the event so their outgoing-request list drops the row.
    await publish_friend_event(
        request,
        target_user_id=sender_id,
        op="friend_request_declined",
        data={"request_id": str(row.id)},
    )
    return None


@router.delete(
    "/friend-requests/{request_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_friend_request(
    request_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    me = current.id
    row = await load_request_for_caller(session, request_id, me, role="sender")
    receiver_id = row.receiver_id
    await session.execute(
        sa_delete(FriendRequest).where(FriendRequest.id == row.id)
    )
    await session.commit()
    # The sender knows from the 204; only the receiver needs the event
    # so the pending-inbox entry disappears in real time.
    await publish_friend_event(
        request,
        target_user_id=receiver_id,
        op="friend_request_cancelled",
        data={"request_id": str(row.id)},
    )
    return None


# ---- friends list / unfriend ---------------------------------------------


@router.get("/friends", response_model=list[FriendOut])
async def list_friends(session: SessionDep, current: CurrentUser):
    me = current.id
    stmt = (
        select(Friendship)
        .where(
            or_(Friendship.user_a_id == me, Friendship.user_b_id == me)
        )
        .order_by(Friendship.created_at.desc())
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [FriendOut(**wire_friendship(r, me)) for r in rows]


@router.delete(
    "/friends/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_friendship(
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    me = current.id
    lo, hi = sort_pair(me, user_id)
    result = await session.execute(
        sa_delete(Friendship).where(
            Friendship.user_a_id == lo, Friendship.user_b_id == hi
        )
    )
    await session.commit()
    if result.rowcount == 0:
        # 404 only when no row was touched — keeps the route honest
        # about whether the model was already correct on the client.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="friendship_not_found"
        )
    # The initiator (caller) already knows from the 204; the other party
    # gets friend_removed so their friend list drops the stale entry.
    await publish_friend_event(
        request,
        target_user_id=user_id,
        op="friend_removed",
        data={"user_id": str(me)},
    )
    return None
