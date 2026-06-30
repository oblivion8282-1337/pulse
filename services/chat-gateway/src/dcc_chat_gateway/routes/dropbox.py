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

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Request, status
from sqlalchemy import and_, func, select

from dcc_chat_gateway import s3
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
    normalize_parent_path,
    publish_entry_event,
    publish_quota_event,
    serialize_entry,
    utc_now,
    validate_name,
)
from dcc_chat_gateway.routes._dropbox_schemas import (
    DropboxChannelOut,
    DropboxConfigOut,
    DropboxEntriesOut,
    DropboxEntryOut,
    DropboxEntryPatchIn,
    DropboxFolderCreateIn,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import ChannelCreatedEvent

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


async def _get_or_create_config_locked(
    session, guild_id: int
) -> DropboxConfig:
    """Read-or-create the per-guild config with a row-level lock.

    Used by quota-mutating endpoints so concurrent uploads can't both
    pass the ``used_bytes + size <= total`` check (the classic
    check-then-act on a cached counter). Read-only endpoints use
    ``_get_config_unlocked`` instead."""
    cfg = (
        await session.execute(
            select(DropboxConfig)
            .where(DropboxConfig.guild_id == guild_id)
            .with_for_update()
        )
    ).scalars().first()
    if cfg is not None:
        return cfg
    cfg = DropboxConfig(guild_id=guild_id)
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
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxChannelOut:
    """Fetch the dropbox channel, creating it (and the config row) on
    first access. Requires MANAGE_CHANNELS — creating the channel is a
    structural decision made by an admin, not a side-effect of browsing."""

    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_CHANNELS
    )

    channel, created = await _get_or_create_dropbox_channel(session, guild_id)
    # Only the channel-creation path may need to allocate a config row.
    # Reading the channel must NOT auto-create a config (that would
    # silently re-enable dropbox for every guild that ever touched this
    # endpoint).
    if created:
        cfg = await _get_or_create_config_locked(session, guild_id)
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

    parent = normalize_parent_path(payload.parent_path)
    try:
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

    new_parent = (
        normalize_parent_path(payload.parent_path)
        if payload.parent_path is not None
        else entry.parent_path
    )
    try:
        new_name = (
            validate_name(payload.name)
            if payload.name is not None
            else entry.name
        )
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    if new_parent != entry.parent_path or new_name != entry.name:
        if new_parent != entry.parent_path and not await _parent_path_exists(
            session, guild_id, new_parent
        ):
            raise HTTPException(
                404, detail=f"parent path '{new_parent}' does not exist"
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

    cfg = await _get_or_create_config_locked(session, guild_id)
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

    cfg = await _get_or_create_config_locked(session, guild_id)
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
