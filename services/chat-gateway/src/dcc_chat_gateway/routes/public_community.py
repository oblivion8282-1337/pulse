"""Public community address endpoints (Stufe 4).

A community can publish a stable vanity ``handle`` and flip an ``is_public``
toggle (both via ``PATCH /guilds/{id}`` + ``GET /guilds/{id}/settings``, see
``routes/guilds.py``). Once public, anyone can preview + join it by handle:

  GET  /c/{handle}        → minimal preview (name, member_count, is_public)
  POST /c/{handle}/join   → join the community (+ grant instance membership on
                            a Self-Host)

Access-control model (the security-critical part):
  * **Private communities never leak.** A non-public (or unknown) handle returns
    404 on *both* routes — same opaque response as "no such handle" — so the
    handle namespace can't be probed to learn that a private community exists or
    how many members it has.
  * **Public = its own permission (Entscheidung 5).** Joining a public community
    is a self-contained admission: it adds the ``guild_members`` row AND, on a
    Self-Host, the community-scoped ``instance_members`` row — **independent of
    the instance ``join_mode``**. A public community is the community's own
    decision to be open; the legacy ``open/invite_only/closed`` instance lock
    does not gate it. (The future single "Server gesperrt" not-aus toggle from
    Stufe 5 will override even this — it does not exist yet, so today the only
    gate is the ``is_public`` flag itself.)
  * **Banned users can't join** (403) — the ban check runs before and is
    re-checked inside the transaction to close the concurrent-ban race.
  * **Idempotent** — an existing member is a no-op success.

This route is **not** ``CloudOnly``: it serves both the Cloud's own communities
and a Self-Host's. The instance-membership grant only happens in self-host mode.
"""

from __future__ import annotations

from dcc_shared.events import GuildMemberAddedEvent
from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.membership import add_member as add_instance_member
from dcc_chat_gateway.models import Guild, GuildMember
from dcc_chat_gateway.schemas import (
    InviteGuildOut,
    PublicCommunityJoinOut,
    PublicCommunityPreviewOut,
)
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()

# Same opaque 404 for "no such handle", "handle is malformed" and "community is
# private". Three distinct internal reasons, one external signal — so a probe
# can't tell a private community apart from a non-existent one.
_NOT_FOUND = "community not found"


async def _member_count(session, guild_id: int) -> int:
    stmt = select(func.count()).select_from(GuildMember).where(
        GuildMember.guild_id == guild_id
    )
    return int((await session.execute(stmt)).scalar_one())


async def _first_text_channel_id(session, guild_id: int) -> int | None:
    from dcc_chat_gateway.models import CHANNEL_TYPE_TEXT, Channel

    stmt = (
        select(Channel.id)
        .where(Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_TEXT)
        .order_by(Channel.position, Channel.id)
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _public_guild_or_404(session, handle: str) -> Guild:
    """Resolve a *public* guild by handle or raise the opaque 404.

    A malformed handle short-circuits to 404 without a DB round-trip; a
    non-public match is treated exactly like "not found" (no existence leak).
    """
    # A handle is only ever stored if it passed validation, but a malformed
    # path segment can't match any row anyway — the query below returns None.
    guild = (
        await session.execute(select(Guild).where(Guild.handle == handle))
    ).scalar_one_or_none()
    if guild is None or not guild.is_public:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return guild


@router.get("/c/{handle}", response_model=PublicCommunityPreviewOut)
async def preview_public_community(
    handle: str,
    session: SessionDep,
    current: CurrentUser,
):
    """Minimal preview of a public community. Private/unknown → 404."""
    guild = await _public_guild_or_404(session, handle)
    return PublicCommunityPreviewOut(
        guild=InviteGuildOut(id=guild.id, name=guild.name, icon_url=guild.icon_url),
        member_count=await _member_count(session, guild.id),
        is_public=guild.is_public,
    )


@router.post("/c/{handle}/join", response_model=PublicCommunityJoinOut)
async def join_public_community(
    handle: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Join a public community by handle.

    On a Self-Host this also grants community-scoped *instance* membership,
    independent of ``join_mode`` (Entscheidung 5). Banned users get 403;
    already-members get an idempotent success.
    """
    guild = await _public_guild_or_404(session, handle)
    guild_id = guild.id
    guild_out = InviteGuildOut(id=guild.id, name=guild.name, icon_url=guild.icon_url)

    # Ban check first — a banned user must learn nothing more than a 403 and
    # must never reach the "already member" idempotent path. Imported lazily to
    # avoid the import cycle (bans.py imports from models via guilds).
    from dcc_chat_gateway.routes.bans import is_user_banned  # local: import cycle

    if await is_user_banned(session, guild_id, current.id):
        raise HTTPException(403, detail="you are banned from this server")

    # Late-import config so test fixtures that rebind
    # ``dcc_chat_gateway.config.get_settings`` at module level are honoured at
    # request time (same pattern as ``routes/_deps.py::require_cloud``).
    import dcc_chat_gateway.config as _cfg  # noqa: PLC0415

    is_self_host = _cfg.get_settings().pulse_instance_mode == "self-host"

    # Already a member: idempotent no-op success. We still make sure the
    # instance-membership row exists on self-host (covers the edge where a user
    # is a guild member but somehow lacks the instance row — e.g. data from
    # before public-join existed).
    existing = await session.get(GuildMember, (guild_id, current.id))
    if existing is not None:
        if is_self_host:
            await add_instance_member(
                session, current.user_identifier, joined_via="public_community"
            )
            await session.commit()
        channel_id = await _first_text_channel_id(session, guild_id)
        return PublicCommunityJoinOut(guild=guild_out, channel_id=channel_id)

    # New member. Stage the guild_members row, then re-check the ban list inside
    # the transaction before commit so a PUT /bans that committed between the
    # first check and now can't slip through.
    session.add(GuildMember(guild_id=guild_id, user_id=current.id))
    if is_self_host:
        # Public community = its own permission → grant instance membership,
        # join_mode-independent. ``add_instance_member`` is idempotent + flushes.
        await add_instance_member(
            session, current.user_identifier, joined_via="public_community"
        )
    if await is_user_banned(session, guild_id, current.id):
        await session.rollback()
        raise HTTPException(403, detail="you are banned from this server")

    actually_added = True
    try:
        await session.commit()
    except IntegrityError:
        # Race: another request added the same member concurrently. Treat as the
        # idempotent path — the join still succeeded from the caller's view.
        await session.rollback()
        actually_added = False

    channel_id = await _first_text_channel_id(session, guild_id)
    if actually_added:
        mgr = getattr(request.app.state, "connection_manager", None)
        if mgr is not None:
            await mgr.publish_guild_event(
                GuildMemberAddedEvent(
                    guild_id=str(guild_id), user_id=str(current.id)
                )
            )
    return PublicCommunityJoinOut(guild=guild_out, channel_id=channel_id)
