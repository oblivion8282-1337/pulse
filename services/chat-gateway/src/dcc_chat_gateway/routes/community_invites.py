"""Cloud-only Community-Invite-Broker (Stufe 2 / B-lite).

Relays a private friend-to-friend community invitation through the Cloud so the
invitee gets a real-time "Beitreten"-Karte even when the target community lives
on a Self-Host.

Delivery (2026-06-08): the broker drops the invite link as a **DM** into the
inviter↔invitee conversation — it renders as a join-card via ``MessageItem``'s
``INVITE_RE``. There is no separate friends-tab list anymore, so the broker no
longer exposes a GET (pending list) or DELETE (accept/decline) route — only
POST remains. The ``community_invites`` row is still written (powers re-invite
dedupe so a repeat invite rewrites the existing card instead of stacking one).

Route (cloud-only via the router-level ``CloudOnly`` guard):
  POST /community-invites    create row + drop / rewrite the invite DM

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

import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from dcc_shared.events import DmBumpEvent, MessageUpdateEvent
from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.message_helpers import broadcast as _broadcast
from dcc_chat_gateway.message_helpers import serialize_message
from dcc_chat_gateway.models import CommunityInvite, Message
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes.dms import ensure_dm_channel
from dcc_chat_gateway.schemas import CommunityInviteOut, CreateCommunityInviteIn
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[CloudOnly])


def _bare_host(host: str) -> str:
    """Strip scheme + trailing slash, lower-case → bare FQDN.

    ``target_host`` arrives either as a full ``https://…`` origin (the
    frontend sends ``server.hostname``) or as a bare FQDN (older callers /
    tests). Normalise both to the bare host the invite-link ``?host=`` param
    and the Cloud-origin comparison expect.
    """
    h = host.strip().lower().rstrip("/")
    for scheme in ("https://", "http://"):
        if h.startswith(scheme):
            h = h[len(scheme) :]
            break
    return h.rstrip("/")


def _invite_link(inv: CommunityInvite) -> str:
    """Build the user-facing invite link the DM carries.

    Cloud-community → ``<cloud-origin>/invite/<code>``.
    Self-Host       → ``<cloud-origin>/invite/<code>?host=<fqdn>`` (the bare
    host, url-encoded so ``MessageItem``'s ``INVITE_RE`` + the
    ``decodeURIComponent`` on the receiving side round-trip it).

    The link always points at the Cloud origin: the invite card + join flow
    live in the web app served from the Cloud, regardless of where the target
    community is hosted (``joinGuildByInvite`` routes to the Self-Host from the
    ``?host=`` param).
    """
    settings = get_settings()
    cloud_origin = settings.pulse_cloud_origin.strip().rstrip("/")
    base = f"{cloud_origin}/invite/{inv.code}"
    target = _bare_host(inv.target_host) if inv.target_host else ""
    cloud_host = _bare_host(cloud_origin)
    if not target or target == cloud_host:
        return base
    return f"{base}?host={quote(target, safe='')}"


async def _find_prior_invite_dm(
    session, channel_id: int, inviter_id: int, old_code: str
) -> Message | None:
    """Find the inviter's most recent live invite-DM for ``old_code``.

    On a re-invite (dedupe) the host may mint a fresh code; the prior DM card
    then points at the now-stale code. We look it up by ``…/invite/<old_code>``
    so we can rewrite it in place instead of stacking a second card. Returns
    ``None`` if the user deleted it / it can't be found (→ post a fresh DM).
    """
    needle = f"/invite/{old_code}"
    stmt = (
        select(Message)
        .where(
            Message.channel_id == channel_id,
            Message.author_id == inviter_id,
            Message.deleted_at.is_(None),
            Message.content.contains(needle),
        )
        .order_by(Message.id.desc())
        .limit(1)
    )
    return (await session.execute(stmt)).scalars().first()


async def _send_invite_dm(
    request: Request,
    session,
    inv: CommunityInvite,
    *,
    old_code: str | None = None,
) -> None:
    """Best-effort: surface the invite link in the inviter↔invitee DM thread.

    The link renders as a "Beitreten"-card in the conversation (``InviteEmbed``
    via ``MessageItem``'s ``INVITE_RE``). Persisted + broadcast exactly like a
    normal DM ``post_message`` so it shows live for both parties AND survives a
    reload (message history). Never raises — a failure here must not undo the
    already-committed broker row + push.

    Re-invite (``old_code`` set + a prior card still in the thread): the
    existing card is **rewritten in place** to the new link (``message_update``)
    instead of posting a second one — keeps the thread to a single, current
    card. Falls back to a fresh post if the prior card is gone.
    """
    link = _invite_link(inv)
    try:
        dm = await ensure_dm_channel(session, inv.inviter_id, inv.invitee_id)
        prior = (
            await _find_prior_invite_dm(session, dm.id, inv.inviter_id, old_code)
            if old_code and old_code != inv.code
            else None
        )
        if prior is not None:
            # Rewrite the stale card in place.
            prior.content = link
            prior.edited_at = datetime.now(tz=UTC)
            session.add(prior)
            await session.commit()
            await session.refresh(prior)
            await _broadcast(
                request, dm.id, MessageUpdateEvent(data=serialize_message(prior))
            )
            return
        msg = Message(
            id=next_id(),
            channel_id=dm.id,
            author_id=inv.inviter_id,
            content=link,
        )
        session.add(msg)
        dm.last_message_id = msg.id
        session.add(dm)
        await session.commit()
        await session.refresh(msg)
    except Exception:
        log.exception(
            "failed to create invite DM for community_invite %s", inv.id
        )
        return
    # Broadcast on the DM channel topic (live for whoever is viewing it) + the
    # DmBumpEvent (so a non-viewing client flags the thread as having activity)
    # — the same two-step fan-out ``post_message`` does for a DM.
    await _broadcast(request, dm.id, serialize_message(msg))
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        try:
            await mgr.publish_guild_event(
                DmBumpEvent(
                    channel_id=str(dm.id),
                    user_a_id=str(dm.user_a_id),
                    user_b_id=str(dm.user_b_id),
                    message_id=str(msg.id),
                    author_id=str(inv.inviter_id),
                )
            )
        except Exception:
            log.exception("invite DM bump publish failed for dm %s", dm.id)


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
    # read the prior row's code first (to rewrite its DM card in place rather
    # than stack a second one), then delete it and insert the fresh one — the
    # newest code/expiry wins (the host may have minted a new invite).
    prior_code = (
        await session.execute(
            select(CommunityInvite.code).where(
                CommunityInvite.inviter_id == current.id,
                CommunityInvite.invitee_id == payload.invitee_id,
                CommunityInvite.target_guild_id == payload.target_guild_id,
            )
        )
    ).scalars().first()
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
    # Deliver the invite as a DM: the link renders as a "Beitreten"-card in the
    # inviter↔invitee conversation (replaces the old separate friends-tab list —
    # there is no more ``community_invite_received`` push). Best-effort; a
    # DM-write hiccup must not undo the already-committed broker row. The broker
    # row above is committed, so this opens a fresh transaction on the same
    # ``session``. On re-invite, ``prior_code`` lets it rewrite the existing
    # card in place instead of stacking a second one.
    await _send_invite_dm(request, session, invite, old_code=prior_code)
    return out
