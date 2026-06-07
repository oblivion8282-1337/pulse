"""Cloud-only Community-Invite-Broker (Stufe 2 / B-lite).

Relays a private friend-to-friend community invitation through the Cloud so the
invitee gets a real-time "Beitreten"-Karte even when the target community lives
on a Self-Host. B-lite: the broker row is **deleted** on accept/decline (no
durable membership register on the Cloud).

Routes (all cloud-only via the router-level ``CloudOnly`` guard):
  POST   /community-invites          create + push community_invite_received
  GET    /community-invites          pending invites for the current user
  DELETE /community-invites/{id}     delete (accept/decline) + push removed

Trust model: the inviter is authenticated by the Cloud (a normal access token).
The *proof of authorisation to invite into a community* is the host-coined
``code`` (a live ``GuildInvite`` on the hosting server) — the Cloud only relays
``{host, code}``; it never validates the code (it can't reach a Self-Host's
invite table). A relayed invite therefore grants **nothing** on its own: access
is still gated by the host re-checking the live invite at accept time
(``invites.py::accept_invite`` / the cert-login community grant). The broker is
a notification + auto-join convenience, not an authority.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import or_, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_events import publish_friend_event
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.models import CommunityInvite
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.schemas import CommunityInviteOut, CreateCommunityInviteIn
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(dependencies=[CloudOnly])


def _as_aware(dt: datetime | None) -> datetime | None:
    """Normalise a possibly-naive (SQLite) datetime to tz-aware UTC."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _is_expired(inv: CommunityInvite, now: datetime) -> bool:
    expires_at = _as_aware(inv.expires_at)
    return expires_at is not None and expires_at <= now


async def _sweep_expired_for(session, invitee_id: int, now: datetime) -> None:
    """Lazily delete the caller's own expired rows on every GET.

    Cheap, scoped to one user, and keeps the pending list honest without a
    background task. A global sweeper is overkill for v1 (rows are short-lived
    and deleted on accept) — see the plan's "Stufe 2 — Detaildesign".
    """
    await session.execute(
        sa_delete(CommunityInvite).where(
            CommunityInvite.invitee_id == invitee_id,
            CommunityInvite.expires_at.is_not(None),
            CommunityInvite.expires_at <= now,
        )
    )
    await session.commit()


# ---- POST /community-invites ----------------------------------------------


@router.post(
    "/community-invites",
    response_model=CommunityInviteOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_community_invite(
    payload: CreateCommunityInviteIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Relay a community invitation to ``invitee_id`` + push a card to them.

    Preconditions (product model "erst befreundet, DANN einladen"):
      * inviter and invitee must be **confirmed friends** (global Cloud
        ``friendships`` — the same source as ws_ready/friends). Inviting a
        non-friend is rejected (403).
      * no block in **either** direction (403). Checked before friendship so a
        block always wins.

    The host-coined ``code`` is the cross-host authorisation proof — the Cloud
    does not (cannot) verify it, it just delivers it. The friend-gate here is
    the Cloud-side guard that only a social contact can even reach the invitee.
    Per-inviter rate-limited.
    """
    if not ratelimit_check("community_invite", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )

    if payload.invitee_id == current.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="cannot_invite_yourself"
        )

    # Block-gate first: a block in either direction stops the invite cold and
    # must win over the friendship check (a stale friendship + a fresh block
    # should still be denied). 403, no existence leak about the other party.
    if await block_exists_either_way(session, current.id, payload.invitee_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="block_in_place")

    # Friend-gate: only a confirmed friend may be invited into a community.
    if not await friendship_exists(session, current.id, payload.invitee_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="not_friends"
        )

    expires_at: datetime | None = None
    if payload.expires_in_seconds is not None:
        expires_at = datetime.now(tz=UTC) + timedelta(
            seconds=payload.expires_in_seconds
        )

    # Dedupe: collapse a repeat invite (same inviter→invitee→guild) onto a
    # single live row so a spammed "invite" button can't pile up cards. We
    # delete any prior pending row first, then insert the fresh one — the
    # newest code/expiry wins (the host may have minted a new invite).
    await session.execute(
        sa_delete(CommunityInvite).where(
            CommunityInvite.inviter_id == current.id,
            CommunityInvite.invitee_id == payload.invitee_id,
            CommunityInvite.target_guild_id == payload.target_guild_id,
        )
    )

    invite = CommunityInvite(
        id=next_id(),
        inviter_id=current.id,
        invitee_id=payload.invitee_id,
        target_host=payload.target_host,
        target_instance_id=payload.target_instance_id,
        target_guild_id=payload.target_guild_id,
        target_guild_name=payload.target_guild_name,
        code=payload.code,
        expires_at=expires_at,
    )
    session.add(invite)
    await session.commit()
    await session.refresh(invite)

    out = CommunityInviteOut.model_validate(invite)
    # Push the card to the invitee only (the inviter has the REST response).
    await publish_friend_event(
        request,
        target_user_id=payload.invitee_id,
        op="community_invite_received",
        data=out.model_dump(mode="json"),
    )
    return out


# ---- GET /community-invites -----------------------------------------------


@router.get("/community-invites", response_model=list[CommunityInviteOut])
async def list_community_invites(session: SessionDep, current: CurrentUser):
    """Pending community invitations for the current user (the invitee).

    Lazily drops the caller's own expired rows first, then returns the live
    remainder (newest first)."""
    now = datetime.now(tz=UTC)
    await _sweep_expired_for(session, current.id, now)
    stmt = (
        select(CommunityInvite)
        .where(CommunityInvite.invitee_id == current.id)
        .order_by(CommunityInvite.created_at.desc())
        .limit(200)
    )
    return (await session.execute(stmt)).scalars().all()


# ---- DELETE /community-invites/{id} ---------------------------------------


@router.delete(
    "/community-invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_community_invite(
    invite_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Remove a pending invitation — called after a successful join (B-lite)
    or to decline. Only a party to the invite (invitee *or* inviter) may delete
    it; a stranger gets 404 (no existence leak).

    B-lite core: the row is **deleted**, not marked consumed — the Cloud keeps
    no record that the join happened.
    """
    me = current.id
    # Authorise: caller must be the invitee (the normal accept/decline path)
    # or the inviter (rescinding). Anyone else cannot even learn the row exists.
    result = await session.execute(
        sa_delete(CommunityInvite)
        .where(
            CommunityInvite.id == invite_id,
            or_(
                CommunityInvite.invitee_id == me,
                CommunityInvite.inviter_id == me,
            ),
        )
        .returning(CommunityInvite.invitee_id)
    )
    row = result.first()
    await session.commit()
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="community_invite_not_found"
        )
    # Multi-tab sync: tell the invitee's other sessions to drop the card. The
    # deleting caller already knows from the 204; we still fan out to the
    # invitee (covers both "invitee accepted in tab A" and "inviter rescinded").
    invitee_id = row[0]
    await publish_friend_event(
        request,
        target_user_id=invitee_id,
        op="community_invite_removed",
        data={"invite_id": str(invite_id)},
    )
    return None
