"""Dropbox / Ablage — list, folder, entries, restore.

Co-located route group for the per-guild dropbox feature. Companion
modules:
  - ``routes/dropbox_uploads.py``  — presigned PUT mint + finish-upload
  - ``routes/dropbox_admin.py``    — admin settings + sweep

Each module owns its own APIRouter; the parent ``routes/__init__.py``
includes all three. Module split keeps every file under the 350-line
soft cap (PLAN.md §12.1).
"""

from __future__ import annotations

import structlog
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Request, status
from sqlalchemy import and_, func, or_, select

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_DROPBOX,
    DROPBOX_KIND_FILE,
    DROPBOX_KIND_FOLDER,
    Channel,
    DropboxConfig,
    DropboxFile,
    Guild,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes._dropbox_helpers import (
    bump_used,
    fresh_entry_id,
    locked_config,
    normalize_parent_path,
    publish_entry_event,
    publish_purge_event,
    publish_quota_event,
    serialize_entry,
    utc_now,
    validate_name,
    with_quota_lock,
)
from dcc_chat_gateway.routes._dropbox_policy import DropboxGuild, new_dropbox_config
from dcc_chat_gateway.routes._dropbox_schemas import (
    DropboxChannelCreateIn,
    DropboxChannelOut,
    DropboxConfigOut,
    DropboxEntriesOut,
    DropboxEntryOut,
    DropboxEntryPatchIn,
    DropboxFolderCreateIn,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import ChannelCreatedEvent

log = structlog.get_logger(__name__)

router = APIRouter(tags=["dropbox"])


# ---------------------------------------------------------------------------
# Internal: get-or-create the dropbox channel + per-guild config
# ---------------------------------------------------------------------------


async def _get_or_create_dropbox_channel(
    session, guild_id: int, *, name: str = "ablage"
) -> tuple[Channel, bool]:
    """Singleton dropbox channel. Idempotent — returns (channel, created)."""

    stmt = select(Channel).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_DROPBOX
    )
    existing = (await session.execute(stmt)).scalars().first()
    if existing is not None:
        return existing, False
    # Neu-Erstellung respektiert den Community-Master-Schalter: hat die
    # Community-Leitung die Ablage abgeschaltet (Config existiert mit
    # enabled=false), darf kein neuer Kanal entstehen — sonst stünde ein Kanal
    # da, den niemand nutzen kann (die Nutzungs-Routen 404/403en auf enabled).
    # Ein bereits vorhandener Kanal (oben) wird davon nicht berührt: der bleibt
    # sichtbar, nur deaktiviert.
    cfg = await session.get(DropboxConfig, guild_id)
    if cfg is not None and not cfg.enabled:
        raise HTTPException(409, detail="dropbox is disabled for this community")
    pos_stmt = select(func.coalesce(func.max(Channel.position), -1)).where(
        Channel.guild_id == guild_id
    )
    max_pos = (await session.execute(pos_stmt)).scalar_one()
    channel = Channel(
        id=fresh_entry_id(),
        guild_id=guild_id,
        name=name,
        type=CHANNEL_TYPE_DROPBOX,
        position=int(max_pos) + 1,
    )
    session.add(channel)
    return channel, True


async def _get_or_create_config_locked(session, guild: Guild) -> DropboxConfig:
    """Read-or-create the per-guild config with a row-level lock.

    Used by quota-mutating endpoints so concurrent uploads can't both
    pass the ``used_bytes + size <= total`` check (the classic
    check-then-act on a cached counter). Read-only endpoints use
    ``_get_config_unlocked`` instead."""
    cfg = (
        await session.execute(
            select(DropboxConfig)
            .where(DropboxConfig.guild_id == guild.id)
            .with_for_update()
        )
    ).scalars().first()
    if cfg is not None:
        return cfg
    cfg = new_dropbox_config(guild)
    session.add(cfg)
    await session.flush()
    return cfg


async def _get_config_unlocked(session, guild_id: int) -> DropboxConfig | None:
    """Cheap, unlocked read for endpoints that don't mutate quota."""
    return await session.get(DropboxConfig, guild_id)


# ---------------------------------------------------------------------------
# Channel + quota
# ---------------------------------------------------------------------------


@router.get(
    "/guilds/{guild_id}/dropbox/channel",
    response_model=DropboxChannelOut,
)
async def ensure_dropbox_channel(
    guild_id: Annotated[int, Path(ge=1)],
    guild: DropboxGuild,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxChannelOut:
    """Fetch the dropbox channel, creating it (and the config row) on
    first access. Requires MANAGE_CHANNELS — creating the channel is a
    structural decision made by an admin, not a side-effect of browsing."""

    await check_permission(
        session, current, guild_id, Permissions.MANAGE_CHANNELS
    )

    channel, created = await _get_or_create_dropbox_channel(session, guild_id)
    # Only the channel-creation path may need to allocate a config row.
    # Reading the channel must NOT auto-create a config (that would
    # silently re-enable dropbox for every guild that ever touched this
    # endpoint).
    if created:
        cfg = await _get_or_create_config_locked(session, guild)
        await session.commit()
        await session.refresh(channel)
        await session.refresh(cfg)

        mgr = getattr(request.app.state, "connection_manager", None)
        if mgr is not None:
            await mgr.publish_guild_event(
                ChannelCreatedEvent(
                    channel={
                        "id": str(channel.id),
                        "guild_id": str(channel.guild_id),
                        "name": channel.name,
                        "type": channel.type,
                        "position": channel.position,
                        "topic": channel.topic,
                        "restricted": False,
                        "name_color": None,
                        "name_color_secondary": None,
                        "name_gradient_angle": None,
                    }
                )
            )
            await publish_quota_event(mgr, cfg)
    else:
        await session.commit()

    return DropboxChannelOut(
        id=channel.id,
        guild_id=channel.guild_id,
        name=channel.name,
        type=channel.type,
        position=channel.position,
        created=created,
    )


@router.post(
    "/guilds/{guild_id}/dropbox/channel",
    response_model=DropboxChannelOut,
)
async def create_dropbox_channel(
    guild_id: Annotated[int, Path(ge=1)],
    guild: DropboxGuild,
    payload: DropboxChannelCreateIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxChannelOut:
    """Idempotent dropbox-channel create. Used by the frontend's
    "Create channel → Ablage" flow, which needs to honour the user-typed
    name. If a dropbox channel already exists, returns it unchanged
    (singleton — admins rename via PATCH, not by creating a new one)."""

    await check_permission(
        session, current, guild_id, Permissions.MANAGE_CHANNELS
    )

    # Display-string sink — same hardening as patch_entry / create_folder
    # (validate_name rejects path-traversal, bidi-spoof, homograph chars
    # and strips zero-width-invisible / bidi-format).
    raw = payload.name or "ablage"
    try:
        name = validate_name(raw)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc
    channel, created = await _get_or_create_dropbox_channel(
        session, guild_id, name=name
    )
    if created:
        cfg = await _get_or_create_config_locked(session, guild)
        await session.commit()
        await session.refresh(channel)
        await session.refresh(cfg)

        mgr = getattr(request.app.state, "connection_manager", None)
        if mgr is not None:
            await mgr.publish_guild_event(
                ChannelCreatedEvent(
                    channel={
                        "id": str(channel.id),
                        "guild_id": str(channel.guild_id),
                        "name": channel.name,
                        "type": channel.type,
                        "position": channel.position,
                        "topic": channel.topic,
                        "restricted": False,
                        "name_color": None,
                    }
                )
            )
    return DropboxChannelOut(
        id=channel.id,
        guild_id=channel.guild_id,
        name=channel.name,
        type=channel.type,
        position=channel.position,
        created=created,
    )


@router.get(
    "/guilds/{guild_id}/dropbox/quota",
    response_model=DropboxConfigOut,
)
async def get_quota(
    guild_id: Annotated[int, Path(ge=1)],
    session: SessionDep,
    current: CurrentUser,
) -> DropboxConfigOut:
    """Public read — every guild member can see how full the dropbox is.

    Read-only: returns 404 instead of silently creating a config row
    when the dropbox was never provisioned. Otherwise a quota ping
    would re-enable the feature for every guild (DB side-effect on
    a pure GET)."""

    await require_member(session, guild_id, current.id)
    cfg = await _get_config_unlocked(session, guild_id)
    if cfg is None:
        raise HTTPException(404, detail="dropbox not provisioned for this guild")
    return DropboxConfigOut.model_validate(cfg)


# ---------------------------------------------------------------------------
# Listing + search + trash
# ---------------------------------------------------------------------------


@router.get(
    "/guilds/{guild_id}/dropbox/entries",
    response_model=DropboxEntriesOut,
)
async def list_entries(
    guild_id: Annotated[int, Path(ge=1)],
    session: SessionDep,
    current: CurrentUser,
    path: Annotated[str, Query(max_length=2048)] = "",
    q: Annotated[str, Query(max_length=128)] = "",
    include_trash: bool = False,
) -> DropboxEntriesOut:
    """Folder listing + search + trash view.

    - ``path``          — parent path to list (empty = root)
    - ``q``             — full-dropbox substring search on name
    - ``include_trash`` — switch to trash listing (path/q ignored)
    """

    await require_member(session, guild_id, current.id)
    cfg = await _get_config_unlocked(session, guild_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    if include_trash:
        stmt = (
            select(DropboxFile)
            .where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.deleted_at.is_not(None),
            )
            .order_by(DropboxFile.deleted_at.desc())
            .limit(500)
        )
        rows = list((await session.execute(stmt)).scalars())
        return DropboxEntriesOut(
            entries=[await serialize_entry(session, e) for e in rows],
            parent_path="",
            truncated=len(rows) >= 500,
        )

    base_filter = and_(
        DropboxFile.guild_id == guild_id,
        DropboxFile.deleted_at.is_(None),
    )
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = (
            select(DropboxFile)
            .where(and_(base_filter, DropboxFile.name.ilike(like)))
            .order_by(
                DropboxFile.pinned.desc(),
                DropboxFile.uploaded_at.desc(),
            )
            .limit(200)
        )
        rows = list((await session.execute(stmt)).scalars())
        return DropboxEntriesOut(
            entries=[await serialize_entry(session, e) for e in rows],
            parent_path="",
            truncated=len(rows) >= 200,
        )

    parent = normalize_parent_path(path)
    stmt = (
        select(DropboxFile)
        .where(and_(base_filter, DropboxFile.parent_path == parent))
        .order_by(
            DropboxFile.kind.asc(),  # folders first (kind=0)
            DropboxFile.pinned.desc(),
            DropboxFile.name.asc(),
        )
        .limit(500)
    )
    rows = list((await session.execute(stmt)).scalars())
    return DropboxEntriesOut(
        entries=[await serialize_entry(session, e) for e in rows],
        parent_path=parent,
        truncated=len(rows) >= 500,
    )


async def _parent_path_exists(
    session, guild_id: int, parent_path: str
) -> bool:
    """True if every segment of ``parent_path`` exists as a live folder.

    Root (``""``) trivially exists. Otherwise each segment must match a
    folder row whose own ``parent_path`` extends the previous. Catches
    the "create folder under non-existent parent" bug — without this
    the row lands in DB but is unreachable from any UI listing."""
    if not parent_path:
        return True
    parts = parent_path.split("/")
    cursor = ""
    for seg in parts:
        exists = (
            await session.execute(
                select(DropboxFile.id).where(
                    DropboxFile.guild_id == guild_id,
                    DropboxFile.parent_path == cursor,
                    DropboxFile.name == seg,
                    DropboxFile.kind == DROPBOX_KIND_FOLDER,
                    DropboxFile.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if exists is None:
            return False
        cursor = f"{cursor}/{seg}" if cursor else seg
    return True


# ---------------------------------------------------------------------------
# Folder creation
# ---------------------------------------------------------------------------


@router.post(
    "/guilds/{guild_id}/dropbox/folders",
    response_model=DropboxEntryOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_folder(
    guild_id: Annotated[int, Path(ge=1)],
    payload: DropboxFolderCreateIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxEntryOut:
    """Create a folder under ``parent_path``. Membership-only — no extra
    permission. Pre-flight SELECT catches the unique-index violation
    BEFORE the INSERT, so we can hand back a clean 409."""

    await require_member(session, guild_id, current.id)
    cfg = await _get_config_unlocked(session, guild_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, detail="dropbox disabled for this guild")

    if not ratelimit.check("dropbox_folder_create", current.id):
        raise HTTPException(
            429, detail="too many folder creates — slow down"
        )

    try:
        parent = normalize_parent_path(payload.parent_path)
        name = validate_name(payload.name)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    if not await _parent_path_exists(session, guild_id, parent):
        raise HTTPException(
            404, detail=f"parent path '{parent}' does not exist"
        )

    clash = await session.execute(
        select(DropboxFile.id).where(
            DropboxFile.guild_id == guild_id,
            DropboxFile.parent_path == parent,
            DropboxFile.name == name,
            DropboxFile.deleted_at.is_(None),
        )
    )
    if clash.scalar_one_or_none() is not None:
        raise HTTPException(409, detail=f"'{name}' already exists at this path")

    channel, _ = await _get_or_create_dropbox_channel(session, guild_id)
    entry = DropboxFile(
        id=fresh_entry_id(),
        guild_id=guild_id,
        channel_id=channel.id,
        parent_path=parent,
        name=name,
        kind=DROPBOX_KIND_FOLDER,
        size_bytes=None,
        content_type=None,
        storage_key=None,
        version=1,
        uploaded_by_id=current.id,
        uploaded_at=utc_now(),
        updated_at=utc_now(),
        pinned=False,
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)

    await publish_entry_event(
        getattr(request.app.state, "connection_manager", None),
        kind="created",
        guild_id=guild_id,
        entry=entry,
    )
    return await serialize_entry(session, entry)


# ---------------------------------------------------------------------------
# Mutations: rename / move / pin / soft-delete / restore
# ---------------------------------------------------------------------------


@router.patch(
    "/guilds/{guild_id}/dropbox/entries/{entry_id}",
    response_model=DropboxEntryOut,
)
async def patch_entry(
    guild_id: Annotated[int, Path(ge=1)],
    entry_id: int,
    payload: DropboxEntryPatchIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxEntryOut:
    """Rename / move / pin-toggle. Members can edit their own uploads;
    others' edits require MANAGE_CHANNELS."""

    await require_member(session, guild_id, current.id)
    if not ratelimit.check("dropbox_patch", current.id):
        raise HTTPException(
            429, detail="too many patch requests — slow down"
        )
    entry = (
        await session.execute(
            select(DropboxFile).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.id == entry_id,
                DropboxFile.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    if entry is None:
        raise HTTPException(404, detail="entry not found")

    # Pin is an edit on a foreign asset just like rename/move — gate
    # both on ownership *or* MANAGE_CHANNELS. Without this, any
    # member can toggle the pinned flag on files they don't own.
    is_foreign = entry.uploaded_by_id != current.id
    if is_foreign:
        await check_permission(
            session,
            current,
            guild_id,
            Permissions.MANAGE_CHANNELS,
        )

    if payload.pinned is not None and payload.pinned != entry.pinned:
        entry.pinned = bool(payload.pinned)

    try:
        new_parent = (
            normalize_parent_path(payload.parent_path)
            if payload.parent_path is not None
            else entry.parent_path
        )
        new_name = (
            validate_name(payload.name)
            if payload.name is not None
            else entry.name
        )
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    if new_parent != entry.parent_path or new_name != entry.name:
        # Snapshot the old self-path BEFORE we mutate the row. We need
        # it both for the descendant rewrite (folders only) and the
        # cycle-prevention check below.
        old_self_path = (
            f"{entry.parent_path}/{entry.name}"
            if entry.parent_path
            else entry.name
        )
        is_folder_move = (
            entry.kind == DROPBOX_KIND_FOLDER
            and new_parent != entry.parent_path
        )

        if new_parent != entry.parent_path and not await _parent_path_exists(
            session, guild_id, new_parent
        ):
            raise HTTPException(
                404, detail=f"parent path '{new_parent}' does not exist"
            )
        # Cycle guard: a folder can't be moved under itself or any of
        # its descendants, or the parent_path graph becomes a cycle
        # and descendants land at paths that no longer exist
        # (the orphan bug — child's parent_path remained pointing at
        # the old self-path after the move).
        if is_folder_move and (
            new_parent == old_self_path
            or new_parent.startswith(f"{old_self_path}/")
        ):
            raise HTTPException(
                422,
                detail="cannot move a folder into itself or a descendant",
            )
        clash = await session.execute(
            select(DropboxFile.id).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.parent_path == new_parent,
                DropboxFile.name == new_name,
                DropboxFile.deleted_at.is_(None),
                DropboxFile.id != entry.id,
            )
        )
        if clash.scalar_one_or_none() is not None:
            raise HTTPException(
                409,
                detail=f"'{new_name}' already exists at the destination",
            )
        entry.parent_path = new_parent
        entry.name = new_name
        entry.updated_at = utc_now()

        if is_folder_move:
            # Rewrite every descendant's parent_path: drop the old
            # prefix, prepend the new one. The OR covers direct
            # children (parent_path == old_self_path, no trailing
            # slash) and deeper descendants (LIKE prefix/%). LIKE
            # with trailing '/%' is safe against '/A' matching
            # '/A1' because '%' must be preceded by '/'.
            new_self_path = (
                f"{new_parent}/{entry.name}"
                if new_parent
                else entry.name
            )
            desc_stmt = select(DropboxFile).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.id != entry.id,
                or_(
                    DropboxFile.parent_path == old_self_path,
                    DropboxFile.parent_path.like(f"{old_self_path}/%"),
                ),
            )
            for d in (await session.execute(desc_stmt)).scalars():
                d.parent_path = (
                    new_self_path + d.parent_path[len(old_self_path):]
                )
                d.updated_at = utc_now()

    await session.commit()
    await session.refresh(entry)

    await publish_entry_event(
        getattr(request.app.state, "connection_manager", None),
        kind="updated",
        guild_id=guild_id,
        entry=entry,
    )
    return await serialize_entry(session, entry)


@router.delete(
    "/guilds/{guild_id}/dropbox/entries/{entry_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_entry(
    guild_id: Annotated[int, Path(ge=1)],
    entry_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> None:
    """Soft-delete (trash). Members can trash their own uploads;
    others' require MANAGE_CHANNELS. MinIO bytes stay — the sweep
    task purges after ``trash_retention_days``."""

    await require_member(session, guild_id, current.id)
    if not ratelimit.check("dropbox_delete", current.id):
        raise HTTPException(
            429, detail="too many trash requests — slow down"
        )
    entry = (
        await session.execute(
            select(DropboxFile).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.id == entry_id,
                DropboxFile.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    if entry is None:
        raise HTTPException(404, detail="entry not found")
    if entry.uploaded_by_id != current.id:
        await check_permission(
            session,
            current,
            guild_id,
            Permissions.MANAGE_CHANNELS,
        )

    async with with_quota_lock(guild_id):
        cfg = await locked_config(session, guild_id)
        now = utc_now()
        entry.deleted_at = now
        entry.deleted_by_id = current.id
        entry.updated_at = now
        is_file = entry.kind == DROPBOX_KIND_FILE
        if is_file and entry.size_bytes:
            bump_used(cfg, -int(entry.size_bytes))
        await session.commit()
    await session.refresh(entry)

    await publish_entry_event(
        getattr(request.app.state, "connection_manager", None),
        kind="deleted",
        guild_id=guild_id,
        entry=entry,
    )
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await publish_quota_event(mgr, cfg)


@router.post(
    "/guilds/{guild_id}/dropbox/trash/empty",
    response_model=None,
)
async def empty_trash(
    guild_id: Annotated[int, Path(ge=1)],
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> dict:
    """Hard-delete every trashed entry in this guild.

    Skips the ``trash_retention_days`` window — admin's choice. Members
    cannot wipe the trash; gated on MANAGE_CHANNELS so a stray member
    can't erase something their team is about to restore.

    Quota is **not** touched here: ``delete_entry`` already debited
    ``cfg.used_bytes`` at trash time via ``bump_used(-size)``,
    ``restore_entry`` re-credits. Subtracting again here would drift
    the counter negative. MinIO bytes freed are reported back for the
    toast, no quota event needed.

    Wrapped in ``with_quota_lock`` to serialize against concurrent
    uploads / restores — same pattern as ``delete_entry`` /
    ``restore_entry``.
    """

    if not ratelimit.check("dropbox_empty_trash", current.id):
        raise HTTPException(
            429, detail="too many empty-trash requests — slow down"
        )
    await require_member(session, guild_id, current.id)
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_CHANNELS,
    )

    purged: list[tuple[int, int]] = []
    bytes_reclaimed = 0
    mgr = getattr(request.app.state, "connection_manager", None)
    async with with_quota_lock(guild_id):
        # ponytail: 10k cap mirrors the sweep. A guild that genuinely
        # has more trash than that needs a paginated variant — but
        # that's a future iteration, not a today problem.
        rows = list(
            (
                await session.execute(
                    select(DropboxFile).where(
                        DropboxFile.guild_id == guild_id,
                        DropboxFile.deleted_at.is_not(None),
                    ).limit(10_000)
                )
            ).scalars()
        )
        if not rows:
            return {"purged": 0, "bytes_reclaimed": 0}
        for entry in rows:
            if entry.storage_key:
                try:
                    await s3.delete_object(entry.storage_key)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "dropbox_empty_trash_minio_delete_failed",
                        guild_id=guild_id,
                        entry_id=entry.id,
                        storage_key=entry.storage_key,
                        error=str(exc),
                    )
                    # Leave the row in place — next sweep retries.
                    # Bytes may be temporarily orphaned; bandwidth-safe.
                    continue
            purged.append((entry.id, entry.kind))
            if entry.size_bytes:
                bytes_reclaimed += int(entry.size_bytes)
            await session.delete(entry)
        await session.commit()

    for entry_id, kind in purged:
        await publish_purge_event(
            mgr, guild_id=guild_id, entry_id=entry_id, kind=kind,
        )

    return {"purged": len(purged), "bytes_reclaimed": bytes_reclaimed}


@router.post(
    "/guilds/{guild_id}/dropbox/entries/{entry_id}/restore",
    response_model=DropboxEntryOut,
)
async def restore_entry(
    guild_id: Annotated[int, Path(ge=1)],
    entry_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxEntryOut:
    """Bring an entry back from the trash. Same ownership rule as
    delete. Restoring re-bumps the quota (file only) — refuses if the
    community is over-full in the meantime."""

    await require_member(session, guild_id, current.id)
    if not ratelimit.check("dropbox_restore", current.id):
        raise HTTPException(
            429, detail="too many restore requests — slow down"
        )
    entry = (
        await session.execute(
            select(DropboxFile).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.id == entry_id,
                DropboxFile.deleted_at.is_not(None),
            )
        )
    ).scalars().first()
    if entry is None:
        raise HTTPException(404, detail="entry not in trash")
    if entry.uploaded_by_id != current.id:
        await check_permission(
            session,
            current,
            guild_id,
            Permissions.MANAGE_CHANNELS,
        )

    async with with_quota_lock(guild_id):
        cfg = await locked_config(session, guild_id)
        is_file = entry.kind == DROPBOX_KIND_FILE
        if is_file and entry.size_bytes:
            projected = cfg.used_bytes + int(entry.size_bytes)
            if projected > cfg.total_quota_bytes:
                raise HTTPException(
                    409,
                    detail=(
                        "restore would exceed the community's quota "
                        f"(free: {cfg.total_quota_bytes - cfg.used_bytes} bytes)"
                    ),
                )
            cfg.used_bytes = projected

        entry.deleted_at = None
        entry.deleted_by_id = None
        entry.updated_at = utc_now()
        await session.commit()
    await session.refresh(entry)

    await publish_entry_event(
        getattr(request.app.state, "connection_manager", None),
        kind="restored",
        guild_id=guild_id,
        entry=entry,
    )
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await publish_quota_event(mgr, cfg)
    return await serialize_entry(session, entry)
