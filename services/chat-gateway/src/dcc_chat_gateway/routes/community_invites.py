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

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way, friendship_exists
from dcc_chat_gateway.friend_events import publish_friend_event
from dcc_chat_gateway.models import CommunityInviteNotification, GuildMember
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes.member_invites import _to_out
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

    # Cloud-Guild-Mitgliedschaft: wer bereits in der Ziel-Community ist, braucht
    # keine Einladung — eine weitere Beitreten-Karte wäre nur verwirrend. Greift
    # nur für Cloud-Ziele (``target_instance_id`` None); Self-Host-Guild-Tabellen
    # leben auf dem Self-Host und sind vom Cloud-Broker aus nicht erreichbar,
    # dort prüft der Host beim Beitritt live (``invites.py::accept_invite``).
    if payload.target_instance_id is None:
        already = await session.get(
            GuildMember, (payload.target_guild_id, payload.invitee_id)
        )
        if already is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail="already_member"
            )

    expires_at: datetime | None = None
    if payload.expires_in_seconds is not None:
        expires_at = datetime.now(tz=UTC) + timedelta(
            seconds=payload.expires_in_seconds
        )

    # Dedupe: EIN offener Antrag pro (guild, invitee) — egal von wem. Gleiche
    # Regel wie beim Nutzername-Weg (``member_invites.py``), damit ein
    # gedrueckt gehaltener Einladen-Knopf keinen Stapel erzeugt. Guard-Query
    # statt partiellem Unique-Index (SQLite in den Tests); das Race-Fenster ist
    # akzeptiert, wie bei der Freundschaftsanfrage-Pruefung.
    vorhanden = (
        await session.execute(
            select(CommunityInviteNotification)
            .where(
                CommunityInviteNotification.guild_id == payload.target_guild_id,
                CommunityInviteNotification.invitee_user_id == payload.invitee_id,
            )
            .with_for_update()
        )
    ).scalars().first()

    if vorhanden is not None:
        # Erneut einladen schreibt die vorhandene Zeile fort statt eine zweite
        # anzulegen: der Code kann frisch sein (der Einladende hat einen neuen
        # geholt), die Karte beim Empfaenger soll aber dieselbe bleiben.
        vorhanden.inviter_user_id = current.id
        vorhanden.target_host = payload.target_host
        vorhanden.target_instance_id = payload.target_instance_id
        vorhanden.guild_name = payload.target_guild_name
        vorhanden.code = payload.code
        vorhanden.expires_at = expires_at
        zeile = vorhanden
    else:
        zeile = CommunityInviteNotification(
            id=next_id(),
            guild_id=payload.target_guild_id,
            inviter_user_id=current.id,
            invitee_user_id=payload.invitee_id,
            target_host=payload.target_host,
            target_instance_id=payload.target_instance_id,
            code=payload.code,
            guild_name=payload.target_guild_name,
            expires_at=expires_at,
        )
        session.add(zeile)

    await session.commit()
    await session.refresh(zeile)

    # Zustellung als Ereignis auf derselben Schiene wie die
    # Freundschaftsanfrage — NICHT mehr als Nachricht im DM-Verlauf. Der alte
    # Weg schrieb eine ``Message`` mit der ``author_id`` des Einladenden, also
    # im Namen eines Dritten; mit verschluesselten Direktnachrichten ist das
    # unmoeglich, dem Server fehlt dafuer der Schluessel. Offline-Empfaenger
    # holen die Einladung ueber den ready-Rahmen nach.
    await publish_friend_event(
        request,
        target_user_id=payload.invitee_id,
        op="community_invite_received",
        data=_to_out(zeile, payload.target_guild_name).model_dump(mode="json"),
    )

    return CommunityInviteOut(
        id=zeile.id,
        inviter_id=zeile.inviter_user_id,
        invitee_id=zeile.invitee_user_id,
        target_host=payload.target_host,
        target_instance_id=zeile.target_instance_id,
        target_guild_id=zeile.guild_id,
        target_guild_name=payload.target_guild_name,
        code=payload.code,
        created_at=zeile.created_at,
        expires_at=zeile.expires_at,
    )
