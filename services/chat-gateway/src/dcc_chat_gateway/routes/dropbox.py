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
    DROPBOX_KIND_FOLDER,
    Channel,
    DropboxConfig,
    DropboxFile,
    Guild,
)
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._dropbox_access import require_dropbox_view
from dcc_chat_gateway.routes._dropbox_helpers import (
    fresh_entry_id,
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
from dcc_chat_gateway.routes._dropbox_writes import (
    commit_or_conflict,
    like_prefix,
    perform_restore,
    perform_trash,
)
from dcc_chat_gateway.routes._deps import guild_oder_404, publish_guild_event
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import ChannelCreatedEvent

log = structlog.get_logger(__name__)

router = APIRouter(tags=["dropbox"])

#: Kanal-Anlege-Route OHNE die Betreiber-/Instanz-Gates: Seit dem
#: Pulse-Laufwerk (Spec §11, 2026-09-11) ist die Ablage im Plus-Menü für
#: jede Community sichtbar, und der Kanal selbst verbraucht keinen alten
#: Dropbox-Speicher — der Inhalt liegt verschlüsselt auf dem Pulse-Laufwerk.
#: Der Community-Schalter (``dropbox_configs.enabled``) bleibt in
#: ``_get_or_create_dropbox_channel`` trotzdem wirksam. Alle ÜBRIGEN
#: Dropbox-Routen (alter Speicherweg) bleiben hinter ``_dropbox_gate``.
kanal_router = APIRouter(tags=["dropbox"])


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
        await publish_guild_event(
            request,
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
            ),
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


@kanal_router.post(
    "/guilds/{guild_id}/dropbox/channel",
    response_model=DropboxChannelOut,
)
async def create_dropbox_channel(
    guild_id: Annotated[int, Path(ge=1)],
    payload: DropboxChannelCreateIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> DropboxChannelOut:
    """Idempotent dropbox-channel create. Used by the frontend's
    "Create channel → Ablage" flow, which needs to honour the user-typed
    name. If a dropbox channel already exists, returns it unchanged
    (singleton — admins rename via PATCH, not by creating a new one).

    Seit dem 2026-09-11 (Pulse-Laufwerk, Spec §11) KEINE
    Betreiber-Freigabe (``guilds.dropbox_allowed``) mehr: die Ablage ist
    im Plus-Menü für jede Community sichtbar, der Kanal selbst verbraucht
    keinen alten Dropbox-Speicher — der Inhalt liegt verschlüsselt auf dem
    Pulse-Laufwerk. Der Community-Schalter (``dropbox_configs.enabled``)
    bleibt trotzdem wirksam (s. ``_get_or_create_dropbox_channel``)."""

    await check_permission(
        session, current, guild_id, Permissions.MANAGE_CHANNELS
    )
    guild = await guild_oder_404(session, guild_id)

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

        await publish_guild_event(
            request,
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
            ),
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

    await require_dropbox_view(session, current, guild_id)
    cfg = await _get_config_unlocked(session, guild_id)
    if cfg is None:
        raise HTTPException(404, detail="dropbox not provisioned for this guild")
    return DropboxConfigOut.model_validate(cfg)


# (Alter Dropbox-Speicherweg — Entries, Ordner, Upload, Download,
# Papierkorb, Umbenennen, Verschieben — am 2026-09-11 eingestellt:
# unverschlüsselte beliebige Dateitypen auf dem Server waren die Lücke,
# die die Pulse-Ablage schließt. Daten in MinIO bleiben kalt liegen;
# die Kanal-/Quota-/Einstellungs-Routen oben tragen die neue Ablage.)
