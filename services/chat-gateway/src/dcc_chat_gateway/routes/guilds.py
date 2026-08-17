"""Guild CRUD + member endpoints."""

from __future__ import annotations

from dcc_shared.events import (
    GuildDeletedEvent,
    GuildMemberAddedEvent,
    GuildMemberRemovedEvent,
    GuildMembershipRevokedEvent,
    GuildMemberUpdatedEvent,
    GuildUpdatedEvent,
    _EventBase,
)
from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS
from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.audit_log import write_audit_log
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.guild_limits import clamp_to_ceilings, effective_wire_limits
from dcc_chat_gateway.guild_caps import enforce_member_cap
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildMember,
    GuildSoundOverride,
    Message,
    MessageAttachment,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.remote_guard import (
    collect_devices_for_cascade,
    end_remote_sessions_for_member,
    forget_devices_after_cascade,
    remove_devices_for_member,
)
from dcc_chat_gateway.stream_evict import end_active_streams_for_member
from dcc_chat_gateway.stream_revoke import revoke_read_tokens_for_viewer
from dcc_chat_gateway.watch_evict import end_watch_parties_for_member
from dcc_chat_gateway.role_hierarchy import assert_actor_outranks
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes.attachments import hard_delete_attachments, purge_s3_keys
from dcc_chat_gateway.routes.dropbox_admin import purge_guild_dropbox_objects
from dcc_chat_gateway.schemas import (
    GuildIn,
    GuildOut,
    GuildPatchIn,
    GuildSettingsOut,
    MemberIn,
    MemberNicknameIn,
    MemberOut,
    TransferOwnershipIn,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_chat_gateway.voice_evict import (
    evict_all_from_voice_channels,
    evict_user_from_guild_voice,
    voice_channels_for_guild,
)

router = APIRouter()


def _guild_dict(guild: Guild) -> dict[str, object]:
    """Wire shape for guild:events envelopes — same field names as GuildOut
    (minus created_at, which lifecycle consumers don't need)."""
    return {
        "id": str(guild.id),
        "name": guild.name,
        "icon_url": guild.icon_url,
        "owner_id": str(guild.owner_id),
        "attachment_max_size_bytes": guild.attachment_max_size_bytes,
        "attachment_max_count_per_message": guild.attachment_max_count_per_message,
        "suspended": guild.suspended_at is not None,
        # Wirksame Grenzen: Wert der Community, sonst Obergrenze des Betreibers.
        # Der Client klemmt beim Senden gegen genau diese Zahlen — ihm die
        # Obergrenze zu schicken, wo die Community sich selbst kleiner gesetzt
        # hat, würde die eigene Einstellung wirkungslos machen.
        **effective_wire_limits(guild),
        # Feature permission — the client hides the Ablage (channel-create
        # option + section) when the operator hasn't unlocked it. Server-side
        # enforcement is the router gate; this only keeps the UI honest.
        "dropbox_allowed": guild.dropbox_allowed,
    }


async def _publish_guild_event(
    request: Request, envelope: _EventBase | dict[str, object]
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(envelope)


# ---- Guilds ----------------------------------------------------------------


@router.post("/guilds", response_model=GuildOut, status_code=status.HTTP_201_CREATED)
async def create_guild(payload: GuildIn, session: SessionDep, current: CurrentUser):
    if not ratelimit.check("create_guild", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    # Admin-gated when allow_guild_creation is off. Admins always pass.
    if not current.is_admin:
        from dcc_chat_gateway.models import ChatSettings  # avoid circular
        settings_row = await session.get(ChatSettings, 1)
        if settings_row is not None and not settings_row.allow_guild_creation:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="server creation is disabled by the admin",
            )
    guild = Guild(
        id=next_id(),
        name=payload.name,
        icon_url=payload.icon_url,
        owner_id=current.id,
    )
    session.add(guild)
    await session.flush()
    session.add(GuildMember(guild_id=guild.id, user_id=current.id))
    # Seed @everyone so the permission resolver has something to anchor on
    # for non-owner members joining later. Mirrors the data-migration in
    # 0009 that did the same for guilds existing before the feature shipped.
    session.add(
        Role(
            id=next_id(),
            guild_id=guild.id,
            name="@everyone",
            permissions=DEFAULT_EVERYONE_PERMISSIONS,
            position=0,
            is_everyone=True,
        )
    )
    await session.commit()
    await session.refresh(guild)
    return guild


@router.get("/guilds", response_model=list[GuildOut])
async def list_guilds(session: SessionDep, current: CurrentUser):
    stmt = (
        select(Guild)
        .join(GuildMember, GuildMember.guild_id == Guild.id)
        .where(GuildMember.user_id == current.id)
        .order_by(Guild.id)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.get("/guilds/{guild_id}", response_model=GuildOut)
async def get_guild(guild_id: int, session: SessionDep, current: CurrentUser):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await require_member(session, guild_id, current.id)
    return guild


def _address_path(handle: str | None) -> str | None:
    """Host-relative public-address path for a handle (``/c/<handle>``)."""
    return f"/c/{handle}" if handle else None


@router.get("/guilds/{guild_id}/settings", response_model=GuildSettingsOut)
async def get_guild_settings(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    """Public-address settings (handle + is_public + computed address path).

    Requires ``MANAGE_GUILD`` — the handle/address is a server-management
    concern, and we don't want a regular member enumerating whether a community
    is publicly addressable from inside."""
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(session, current, guild_id, Permissions.MANAGE_GUILD)
    return GuildSettingsOut(
        id=guild.id,
        name=guild.name,
        handle=guild.handle,
        is_public=guild.is_public,
        address_path=_address_path(guild.handle),
    )


@router.patch("/guilds/{guild_id}", response_model=GuildOut)
async def patch_guild(
    guild_id: int,
    payload: GuildPatchIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Rename / update guild metadata + public-address settings. Requires
    ``MANAGE_GUILD``.

    Public-address rules (Stufe 4):
      * ``handle`` must be a valid slug (format checked in the schema) and
        **unique per instance** — a collision raises 409 (DB partial-unique
        index closes the TOCTOU window; we don't pre-check-then-write).
      * ``handle=""`` clears the handle, but only if the community is *not*
        becoming/staying public — a public community must keep an address.
      * ``is_public=true`` requires a handle to exist (either already set or
        being set in the same patch); otherwise 400. We compute the *resulting*
        handle from the patch so a single call can set handle + flag together.

    Broadcasts ``op:guild_updated`` on guild:events so every connected client
    can refresh its sidebar without a refetch.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(session, current, guild_id, Permissions.MANAGE_GUILD)
    if payload.name is not None:
        guild.name = payload.name
    if payload.icon_url is not None:
        guild.icon_url = payload.icon_url
    if payload.attachment_max_size_bytes is not None:
        guild.attachment_max_size_bytes = payload.attachment_max_size_bytes
    if payload.attachment_max_count_per_message is not None:
        guild.attachment_max_count_per_message = payload.attachment_max_count_per_message
    # Diese zwei Felder sind Werte der Community, keine Obergrenzen — ohne das
    # Klemmen könnte MANAGE_GUILD hier die Vorgabe des Betreibers überschreiben
    # (genau die Lücke, die Migration 0057 geschlossen hat).
    clamp_to_ceilings(guild)

    # ---- Public-address fields ------------------------------------------
    # Resolve the handle the guild will have AFTER this patch (None = unchanged).
    if payload.handle is not None:
        new_handle = None if payload.handle == "" else payload.handle
    else:
        new_handle = guild.handle
    # Resolve the is_public the guild will have after this patch.
    new_is_public = payload.is_public if payload.is_public is not None else guild.is_public

    # Invariant: a public community must have a handle. Reject either clearing
    # the handle while public, or flipping public without one.
    if new_is_public and not new_handle:
        raise HTTPException(
            400, detail="a public community must have a handle"
        )

    if payload.handle is not None:
        guild.handle = new_handle
    if payload.is_public is not None:
        guild.is_public = payload.is_public

    try:
        await session.commit()
    except IntegrityError:
        # The per-instance handle unique index fired: another community on this
        # instance already owns this handle. Closes the check-then-write race —
        # we never pre-query for the handle, we let the DB be the arbiter.
        await session.rollback()
        raise HTTPException(  # noqa: B904
            status.HTTP_409_CONFLICT, detail="handle is already taken"
        )
    await session.refresh(guild)
    await _publish_guild_event(
        request, GuildUpdatedEvent(guild=_guild_dict(guild))
    )
    return guild


@router.delete("/guilds/{guild_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_guild(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Delete a guild and everything inside it. Owner-only (a
    MANAGE_GUILD permission grants rename/icon edits, not nuke).
    Global admins bypass.

    Channels / members / invites cascade via ON DELETE CASCADE in the DB
    schema; messages have no FK on ``channel_id`` (Migration 0005) and are
    deleted explicitly below. Broadcasts ``op:guild_deleted`` so clients can
    navigate away and prune their local stores.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id and not current.is_admin:
        raise HTTPException(403, detail="only the owner can delete the guild")
    mgr = getattr(request.app.state, "connection_manager", None)
    # Hard-delete MinIO attachments for all channels before the DB cascade
    # removes the rows — the cascade can't clean up object-store objects.
    channel_ids_stmt = select(Channel.id).where(Channel.guild_id == guild_id)
    channel_ids = list((await session.execute(channel_ids_stmt)).scalars())
    # Voice-Channels jetzt erfassen (vor dem Cascade-Delete) — nach dem Commit
    # werfen wir alle dort Anwesenden aus der Voice-Session.
    voice_channel_ids = await voice_channels_for_guild(session, guild_id)
    # Standplatz-Geräte jetzt erfassen (vor dem Cascade-Delete) — das
    # In-Prozess-Register (device_registry.py) erfährt von der DB-Kaskade
    # sonst nie (Bughunt 2026-08-17, daten.md).
    devices_removed = await collect_devices_for_cascade(session, mgr, guild_id=guild_id)
    s3_keys_to_purge: list[str] = []
    if channel_ids:
        att_ids_stmt = select(MessageAttachment.id).where(
            MessageAttachment.channel_id.in_(channel_ids),
            MessageAttachment.deleted_at.is_(None),
        )
        att_ids = list((await session.execute(att_ids_stmt)).scalars())
        if att_ids:
            await hard_delete_attachments(
                session, attachment_ids=att_ids, defer_s3=s3_keys_to_purge
            )
        # messages.channel_id has NO FK (Migration 0005 dropped it so the
        # column can reference channels OR direct_message_channels), so the
        # guild cascade never reaches message rows — delete them explicitly,
        # mirroring routes/channels.py::delete_channel.
        await session.execute(sa_delete(Message).where(Message.channel_id.in_(channel_ids)))
    # Sound-Overrides: dieselbe Kaskade wie bei Anhängen (ON DELETE CASCADE auf
    # guild_sound_overrides.guild_id räumt die Zeile), aber MinIO erfährt auch
    # davon nichts — dieselbe purge_s3_keys-Runde nach dem Commit nimmt sie
    # gleich mit (Bughunt 2026-08-17, chat.md).
    sound_keys_stmt = select(GuildSoundOverride.storage_key).where(
        GuildSoundOverride.guild_id == guild_id
    )
    s3_keys_to_purge.extend((await session.execute(sound_keys_stmt)).scalars())
    await session.delete(guild)
    await session.commit()
    # Purge MinIO objects only after the commit succeeds — a rollback must not
    # leave the bytes deleted while rows still reference them.
    await purge_s3_keys(s3_keys_to_purge)
    # Same pattern for dropbox objects: ON DELETE CASCADE on dropbox_configs
    # / dropbox_files removes the DB rows, but MinIO holds the bytes under
    # ``dropbox/<gid>/…`` and never knows about the cascade. Best-effort —
    # a transient MinIO outage leaves a few orphans, picked up by the next
    # sweep iteration.
    await purge_guild_dropbox_objects(guild_id)
    # Community-Symbol: liegt lokal auf der Platte (nicht in MinIO) und wird
    # von keiner Kaskade und keinem Aufräumer erfasst (Bughunt 2026-08-17,
    # ablage.md). Lazy import: guild_icons.py importiert seinerseits aus
    # diesem Modul (_guild_dict/_publish_guild_event).
    from dcc_chat_gateway.routes.guild_icons import purge_icon_file  # noqa: PLC0415

    purge_icon_file(guild_id)
    await _publish_guild_event(
        request, GuildDeletedEvent(guild_id=str(guild_id))
    )
    # Anwesende aus allen (jetzt gelöschten) Voice-Channels werfen — sonst
    # hängen sie in Ghost-Sessions. Best-effort, nach dem Commit.
    if voice_channel_ids:
        await evict_all_from_voice_channels(getattr(mgr, "_redis", None), voice_channel_ids)
    # Und das Geräte-Register vergisst, was die Kaskade gerade geräumt hat.
    await forget_devices_after_cascade(mgr, guild_id, devices_removed)


@router.post(
    "/guilds/{guild_id}/transfer-ownership",
    response_model=GuildOut,
)
async def transfer_ownership(
    guild_id: int,
    payload: TransferOwnershipIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Hand the guild over to another member.

    Only the current owner may call this. The target must already be a
    guild member (no implicit invite). ``confirm_name`` must match the
    guild's current name verbatim — see ``TransferOwnershipIn`` for the
    reasoning. The transfer is atomic: the previous owner stays as a
    regular member afterward.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id:
        raise HTTPException(
            403, detail="only the owner can transfer ownership"
        )
    if payload.confirm_name != guild.name:
        raise HTTPException(
            400, detail="confirm_name does not match the guild name"
        )
    if payload.new_owner_id == current.id:
        raise HTTPException(
            400, detail="cannot transfer ownership to yourself"
        )
    target_member = await session.get(
        GuildMember, (guild_id, payload.new_owner_id)
    )
    if target_member is None:
        raise HTTPException(
            400, detail="target user is not a member of this guild"
        )

    guild.owner_id = payload.new_owner_id
    await session.commit()
    await session.refresh(guild)
    await _publish_guild_event(
        request, GuildUpdatedEvent(guild=_guild_dict(guild))
    )
    return guild


# ---- Members (lightweight invite-by-id) ------------------------------------


@router.post("/guilds/{guild_id}/members", response_model=MemberOut, status_code=201)
async def add_member(
    guild_id: int,
    payload: MemberIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    # MANAGE_INVITES gates direct-add-by-id (same caller-trust as creating
    # an invite link). Self-add is intentionally NOT allowed: guild IDs are
    # enumerable, so a self-add path would let any authenticated user join
    # any guild (IDOR over all channels/messages/voice tokens).
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_INVITES,
        detail="not allowed to add members",
    )
    # Ban check — even a MANAGE_INVITES caller can't re-add a banned
    # user; unban is the explicit path. Imported lazily to avoid the
    # import cycle (bans.py needs to import from guilds via models).
    from dcc_chat_gateway.routes.bans import is_user_banned  # local

    if await is_user_banned(session, guild_id, payload.user_id):
        raise HTTPException(403, detail="user is banned from this server")
    await enforce_member_cap(session, guild_id)
    member = GuildMember(guild_id=guild_id, user_id=payload.user_id)
    session.add(member)
    # Re-check the ban-list inside the transaction (post-INSERT, pre-
    # commit) so a concurrent PUT /bans/{uid} that committed between
    # the first check and now can't sneak through.
    if await is_user_banned(session, guild_id, payload.user_id):
        await session.rollback()
        raise HTTPException(403, detail="user is banned from this server")
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # idempotent: already a member
        member = await session.get(GuildMember, (guild_id, payload.user_id))
        return member  # type: ignore[return-value]
    await session.refresh(member)
    await _publish_guild_event(
        request,
        GuildMemberAddedEvent(
            guild_id=str(guild_id),
            user_id=str(payload.user_id),
        ),
    )
    return member


def _normalise_nickname(value: str | None) -> str | None:
    """Trim whitespace; empty / whitespace-only string clears the nickname.

    Single source of truth so the @me and admin routes agree on what
    "" vs None means. ``None`` from the payload means "no change" and
    is filtered upstream — by the time we reach here we already know
    the caller is patching the field.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


@router.patch(
    "/guilds/{guild_id}/members/@me",
    response_model=MemberOut,
)
async def patch_self_member(
    guild_id: int,
    payload: MemberNicknameIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Update the caller's own per-guild profile. Currently only
    nickname; requires ``CHANGE_NICKNAME``."""
    member = await session.get(GuildMember, (guild_id, current.id))
    if member is None:
        raise HTTPException(404, detail="not a member of this guild")
    if payload.nickname is None:
        # Caller submitted an empty patch — return current state untouched.
        return member
    await check_permission(
        session, current, guild_id, Permissions.CHANGE_NICKNAME
    )
    member.nickname = _normalise_nickname(payload.nickname)
    await session.commit()
    await session.refresh(member)
    await _publish_guild_event(
        request,
        GuildMemberUpdatedEvent(
            guild_id=str(guild_id),
            user_id=str(current.id),
            nickname=member.nickname,
        ),
    )
    return member


@router.get(
    "/guilds/{guild_id}/members/{user_id}",
    response_model=MemberOut,
)
async def get_member(
    guild_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    """Fetch a single guild member. Returns 200 with the member row, or
    404 if the user isn't a member of this guild. The caller must itself
    be a member (mirrors ``list_members``).

    voice-signaling relies on this for its target-membership check on the
    admin mute / move endpoints — without a registered GET handler the
    path matched only PATCH/DELETE and FastAPI replied 405, which
    voice-signaling surfaced to the client as ``membership check
    unavailable``."""
    await require_member(session, guild_id, current.id)
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(404, detail="member not found")
    return member


@router.patch(
    "/guilds/{guild_id}/members/{user_id}",
    response_model=MemberOut,
)
async def patch_member(
    guild_id: int,
    user_id: int,
    payload: MemberNicknameIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Update another member's per-guild profile. Currently only the
    nickname, which requires ``MANAGE_NICKNAMES``. Callers patching their
    own row should use ``PATCH .../members/@me`` — this route 400s on
    ``user_id == current.id`` so the two paths don't share a gate.

    Restrictions mirror ``kick_member``: the guild owner is immune (only
    they can change their own nickname, via ``@me``), and the caller must
    outrank the target by role hierarchy — a mod cannot rename a member
    with an equal or higher top role. Instance admins and the guild owner
    bypass the hierarchy check.

    The guard order is load-bearing: the self-check, guild fetch, and
    ``require_member`` gate run before the owner guard and member fetch so
    that a non-member cannot use this route as a cross-guild membership or
    owner oracle."""
    if user_id == current.id:
        raise HTTPException(400, detail="use PATCH .../members/@me for self-edits")
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    # Membership gate before any target-specific lookup: an empty body ({})
    # must not leak the target's nickname/join time, and a non-member must get
    # the generic 403 here rather than a distinguishable owner-vs-not response
    # from the owner guard below (mirrors get_member and the sibling routes).
    await require_member(session, guild_id, current.id)
    if guild.owner_id == user_id:
        raise HTTPException(403, detail="cannot rename the guild owner")
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(404, detail="member not found")
    if payload.nickname is None:
        return member
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_NICKNAMES
    )
    await assert_actor_outranks(
        session,
        current,
        guild,
        user_id,
        detail="cannot rename a member with an equal or higher role",
    )
    member.nickname = _normalise_nickname(payload.nickname)
    await session.commit()
    await session.refresh(member)
    await _publish_guild_event(
        request,
        GuildMemberUpdatedEvent(
            guild_id=str(guild_id),
            user_id=str(user_id),
            nickname=member.nickname,
        ),
    )
    return member


async def _remove_guild_member(
    session: SessionDep,
    request: Request,
    guild_id: int,
    user_id: int,
    member: GuildMember,
) -> None:
    """Shared member-removal mechanics for kick + leave.

    Wipes per-channel user-target overwrites (composite FKs only cascade
    ``member_roles``), deletes the membership, evicts the user from this guild's
    voice channels, and broadcasts ``guild_member_removed``. The CALLER owns the
    authorization guard (kick → ``KICK_MEMBERS``; leave → self) plus the
    owner/not-self checks.
    """
    channel_ids_stmt = select(Channel.id).where(Channel.guild_id == guild_id)
    channel_ids = list((await session.execute(channel_ids_stmt)).scalars())
    if channel_ids:
        await session.execute(
            sa_delete(PermissionOverwrite).where(
                PermissionOverwrite.channel_id.in_(channel_ids),
                PermissionOverwrite.target_type == 1,
                PermissionOverwrite.target_id == user_id,
            )
        )
    await session.delete(member)
    await session.commit()
    # Yank the user out of LiveKit + clear voice-overrides for every voice
    # channel of this guild. Fire-and-forget — failure is logged but doesn't
    # unwind the removal (the WS event already went out, membership is gone).
    await evict_user_from_guild_voice(session, guild_id, user_id)
    # Und aus jeder Fernsteuerung dieses Servers — in BEIDEN Rollen. Der
    # Takt-Prueflauf (remote_guard) braucht bis zu 30 s; ein ausdruecklicher
    # Rauswurf muss laut Wire-Protokoll v2 sofort trennen, sonst tippt der
    # Rausgeworfene noch eine halbe Minute auf einem fremden Rechner.
    await end_remote_sessions_for_member(
        session,
        getattr(request.app.state, "connection_manager", None),
        guild_id,
        user_id,
        reason="membership_revoked",
    )
    # Und die Geraetezeilen dieses Mitglieds — Begruendung in
    # ``remote_guard.remove_devices_for_member``.
    await remove_devices_for_member(
        session,
        getattr(request.app.state, "connection_manager", None),
        guild_id,
        user_id,
    )
    # Und die Lese-Token für laufende Streams: sie sind an Kanal und
    # Streamer gebunden, nicht an die Person, und werden nicht verbraucht —
    # ohne das hier schaut der Entfernte bis zu eine Stunde weiter und kann
    # die Adresse weitergeben (s. `stream_revoke`).
    await revoke_read_tokens_for_viewer(
        getattr(request.app.state, "redis", None),
        session,
        guild_id,
        user_id,
        grund="membership_revoked",
    )
    # Und die SENDE-Seite: ohne das laeuft der Sidecar des Entfernten weiter
    # und der media-svc-Poller haelt den Kanal auf "live". Der Bann-Pfad tut
    # dasselbe — die Zeile gehoert hierher, weil Rauswurf und Austritt beide
    # ueber diesen Helfer laufen und sonst nur die halbe Wirkung haetten.
    await end_active_streams_for_member(
        getattr(request.app.state, "redis", None),
        session,
        guild_id,
        user_id,
        grund="membership_revoked",
    )
    # Und eine laufende Watch-Party, die der Entfernte hostet: watch_control,
    # watch_heartbeat und watch_stop pruefen nach dem Start nur noch, ob er
    # der Host ist, nie ob er noch Mitglied ist.
    await end_watch_parties_for_member(
        session,
        getattr(request.app.state, "redis", None),
        getattr(request.app.state, "connection_manager", None),
        guild_id,
        user_id,
    )
    await _publish_guild_event(
        request,
        GuildMemberRemovedEvent(guild_id=str(guild_id), user_id=str(user_id)),
    )


@router.delete(
    "/guilds/{guild_id}/members/@me",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def leave_guild(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Leave a guild (self-removal). Any member may leave EXCEPT the owner —
    the owner must transfer ownership or delete the guild first (a guild is
    never left ownerless). Works identically on Cloud and Self-Host.

    MUST be declared before the ``{user_id}`` kick route so ``@me`` matches the
    literal path instead of being parsed as ``user_id`` (mirrors the @me/{id}
    PATCH pair above). Same removal mechanics as ``kick_member``, gated on
    "self" instead of ``KICK_MEMBERS``.
    """
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id == current.id:
        raise HTTPException(403, detail="owner_cannot_leave")
    member = await session.get(GuildMember, (guild_id, current.id))
    if member is None:
        raise HTTPException(404, detail="member not found")
    await _remove_guild_member(session, request, guild_id, current.id, member)


@router.delete(
    "/guilds/{guild_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def kick_member(
    guild_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Remove a member from a guild. Requires ``KICK_MEMBERS``.

    Restrictions:
      * cannot kick yourself — use the ``@me`` leave route instead;
      * cannot kick the guild owner — ownership transfer is the only path;
      * member-role rows cascade via the composite FK on ``member_roles``;
      * per-channel user-target permission overwrites for this user are
        wiped explicitly (they're not cascaded — see
        ``permission_overwrites`` schema).

    Broadcasts ``guild_member_removed`` on guild:events. Clients that are
    the kicked user drop the guild locally; other clients prune their
    member list. The WS connection is not force-closed — the next
    permission-gated action on that guild will 403 naturally.
    """
    if user_id == current.id:
        raise HTTPException(400, detail="cannot kick yourself")
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id == user_id:
        raise HTTPException(403, detail="cannot kick the guild owner")
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(404, detail="member not found")
    await check_permission(
        session, current, guild_id, Permissions.KICK_MEMBERS
    )
    await assert_actor_outranks(
        session,
        current,
        guild,
        user_id,
        detail="cannot kick a member with an equal or higher role",
    )
    # Audit only the moderator-initiated kick — ``leave_guild`` shares the same
    # removal mechanics but is self-removal and intentionally not audited.
    await write_audit_log(
        session,
        guild_id=guild_id,
        actor_user_id=current.id,
        action_type="kick",
        target_kind="user",
        target_id=user_id,
    )
    await _remove_guild_member(session, request, guild_id, user_id, member)
    # Tell the kicked user directly — otherwise the community just silently
    # vanishes from their client. No reason + no rejoin invite: a kick isn't a
    # block, so they can re-join on their own. (Placed here, NOT in the shared
    # ``_remove_guild_member`` helper, so a voluntary ``leave_guild`` stays
    # silent.)
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_user_event(
            user_id,
            GuildMembershipRevokedEvent(
                guild_id=str(guild_id),
                guild_name=guild.name,
                kind="kick",
                reason=None,
            ),
        )
    # Durable PM from the acting admin (bypasses the friend-gate). No reason
    # and no "permanent" wording — a kick isn't a block.
    from dcc_chat_gateway.system_dm import send_moderation_dm

    await send_moderation_dm(
        session,
        mgr,
        from_user_id=current.id,
        to_user_id=user_id,
        content=f"Du wurdest aus der Community „{guild.name}“ entfernt.",
    )


@router.get("/guilds/{guild_id}/members", response_model=list[MemberOut])
async def list_members(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    limit: int = Query(100, ge=1, le=500),
    after_user_id: int | None = Query(None),
):
    await require_member(session, guild_id, current.id)
    stmt = (
        select(GuildMember)
        .where(GuildMember.guild_id == guild_id)
        .order_by(GuildMember.user_id)
    )
    if after_user_id is not None:
        stmt = stmt.where(GuildMember.user_id > after_user_id)
    stmt = stmt.limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)
