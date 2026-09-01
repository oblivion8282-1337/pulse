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
    Self-Host, the community-scoped ``instance_members`` row — a public community
    is the community's own decision to be open. The single "Server gesperrt"
    (``locked``) not-aus toggle (Stufe 5) overrides even this on a Self-Host: a
    NEW instance join is refused (403) while locked. Existing instance members
    (and Cloud, which has no instance lock) still join the community normally.
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
from dcc_chat_gateway.guild_caps import enforce_member_cap
from dcc_chat_gateway.routes._deps import publish_guild_event
from dcc_chat_gateway.routes.invites import (
    _first_text_channel_id,
    _member_count,
)
from dcc_chat_gateway.membership import (
    add_member as add_instance_member,
    is_instance_locked,
    is_member as is_instance_member,
)
from dcc_chat_gateway.models import Guild, GuildMember
from dcc_chat_gateway.community_categories import is_valid_category
from dcc_chat_gateway.schemas import (
    DirectoryEntryOut,
    DirectoryOut,
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


#: Serverseitiger Deckel der Seitengroesse. Der chat-gateway hat KEINEN
#: Ratenbegrenzer (``slowapi`` laeuft nur im auth-svc), deshalb ist die
#: Anmeldepflicht unten der eigentliche Riegel und dieser Deckel die zweite,
#: billige Schranke gegen ein versehentliches „gib mir alles".
_VERZEICHNIS_MAX = 50


@router.get("/c", response_model=DirectoryOut)
async def list_public_communities(
    session: SessionDep,
    current: CurrentUser,
    q: str | None = None,
    category: str | None = None,
    limit: int = 30,
):
    """Durchsuchbares Verzeichnis oeffentlicher Communities (Entdecken).

    **``is_public AND listed``, beides.** Eine oeffentliche Adresse heisst „wer
    den Link kennt, kommt rein" — nicht „stell mich in ein Schaufenster". Wer
    nur das Erste erlaubt hat, taucht hier nicht auf; ``listed`` kommt mit
    ``false`` an und wird nirgends nachgezogen.

    **Verlangt eine Anmeldung**, genau wie die Vorschau ``GET /c/{handle}``.
    Das ist kein zusaetzlicher Riegel, sondern der vorhandene: ohne ihn waere
    das ein unbegrenzt abfragbarer Endpunkt (s. ``_VERZEICHNIS_MAX``).
    """
    if not is_valid_category(category):
        # Unbekannte Kategorie = leeres Ergebnis, kein Fehler. Ein 400 waere
        # hier nur eine Auskunft darueber, welche Kennungen es gibt.
        return DirectoryOut(items=[])

    stmt = select(Guild).where(Guild.is_public.is_(True), Guild.listed.is_(True))
    if category:
        stmt = stmt.where(Guild.category == category)
    if q:
        begriff = q.strip()
        if begriff:
            stmt = stmt.where(Guild.name.ilike(f"%{begriff}%"))
    stmt = stmt.order_by(Guild.name, Guild.id).limit(
        max(1, min(limit, _VERZEICHNIS_MAX))
    )
    rows = list((await session.execute(stmt)).scalars().all())
    if not rows:
        return DirectoryOut(items=[])

    # Mitgliederzahlen in EINER Abfrage statt einer je Community.
    zaehl_stmt = (
        select(GuildMember.guild_id, func.count())
        .where(GuildMember.guild_id.in_([g.id for g in rows]))
        .group_by(GuildMember.guild_id)
    )
    zahlen = {gid: n for gid, n in (await session.execute(zaehl_stmt)).all()}
    return DirectoryOut(
        items=[
            DirectoryEntryOut(
                id=g.id,
                handle=g.handle or "",
                name=g.name,
                icon_url=g.icon_url,
                category=g.category,
                member_count=int(zahlen.get(g.id, 0)),
            )
            for g in rows
        ]
    )


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

    On a Self-Host this also grants community-scoped *instance* membership
    (Entscheidung 5). The single "Server gesperrt" (``locked``) not-aus toggle
    (Stufe 5) overrides it: a NEW instance join is refused (403) while locked —
    existing instance members and Cloud are unaffected. Banned users get 403;
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

    # "Server gesperrt" not-aus toggle (Stufe 5). Defensive instance-grant guard:
    # the primary lock sits in the cert-login gate (a new user can't even mint a
    # session token while locked), but block here too so this path never coins a
    # NEW instance membership on a sealed self-host. Existing instance members
    # pass (re-join the community freely); Cloud has no instance lock. Checked
    # before any membership write so a locked instance stays sealed.
    if (
        is_self_host
        and not await is_instance_member(session, current.user_identifier)
        and await is_instance_locked(session)
    ):
        raise HTTPException(403, detail="join_locked")

    # Already a member: idempotent no-op success. We still make sure the
    # instance-membership row exists on self-host (covers the edge where a user
    # is a guild member but somehow lacks the instance row — e.g. data from
    # before public-join existed; the lock guard above already let an existing
    # instance member through, and a non-member would have been refused).
    existing = await session.get(GuildMember, (guild_id, current.id))
    if existing is not None:
        if is_self_host:
            await add_instance_member(
                session, current.user_identifier, joined_via="public_community"
            )
            await session.commit()
        channel_id = await _first_text_channel_id(session, guild_id)
        return PublicCommunityJoinOut(guild=guild_out, channel_id=channel_id)

    # Community member cap (before staging the new membership).
    await enforce_member_cap(session, guild_id)

    # New member. Stage the guild_members row, then re-check the ban list inside
    # the transaction before commit so a PUT /bans that committed between the
    # first check and now can't slip through.
    session.add(GuildMember(guild_id=guild_id, user_id=current.id))
    if is_self_host:
        # Public community = its own permission → grant instance membership (the
        # ``locked`` guard above already rejected a new join on a sealed
        # instance). ``add_instance_member`` is idempotent + flushes.
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
        await publish_guild_event(
            request,
            GuildMemberAddedEvent(
                guild_id=str(guild_id), user_id=str(current.id)
            ),
        )
    return PublicCommunityJoinOut(guild=guild_out, channel_id=channel_id)
