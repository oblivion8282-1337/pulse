"""Who may use the Ablage (dropbox) — and how much room they get.

The *permission* half of the feature, kept apart from the mechanics in
``_dropbox_helpers.py`` (path normalisation, quota bookkeeping, events).
Three levels, all of which must say yes:

  1. instance   — ``require_dropbox_available`` (the Cloud can turn the
                  whole feature off)
  2. operator   — ``require_guild_dropbox_allowed`` (``guilds.dropbox_allowed``,
                  per community, off by default)
  3. community  — ``dropbox_configs.enabled`` (its own MANAGE_GUILD switch)

Level 2 has to sit above level 3: ``dropbox_configs.enabled`` hangs off
MANAGE_GUILD, so without it the target of an operator ban could simply
switch the feature back on.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DropboxConfig, Guild


# Level 1 — instance ---------------------------------------------------


def require_dropbox_available() -> None:
    """Router-level gate: 404 the whole Ablage when the Cloud has it off.

    Cloud-only. The Ablage takes arbitrary file types, which hash-matching
    cannot inspect, so the Cloud does not offer it at all (default) — see
    docs/medien-speicher-und-scanning.md. Self-hosts are never gated here;
    their operator answers for their own content under the cert model.

    404 rather than 403 so a disabled feature is indistinguishable from one
    that was never there, matching the existing per-guild
    ``dropbox disabled for this guild`` response. Re-arm with
    ``CLOUD_DROPBOX_ENABLED=true``."""
    settings = chat_config.get_settings()
    if settings.pulse_instance_mode != "cloud":
        return
    if not settings.cloud_dropbox_enabled:
        raise HTTPException(404, detail="dropbox is not available on this server")


# Level 2 — operator, per community ------------------------------------


async def require_guild_dropbox_allowed(
    guild_id: Annotated[int, Path(ge=1)],
    session: SessionDep,
) -> Guild:
    """Router-level gate: 404 the Ablage for a community the operator hasn't
    unlocked. One level above the community's own ``dropbox_configs.enabled``.

    Set only via ``/owner/communities/{id}/limits``; a community's own admin
    cannot lift it (that's the whole point — ``dropbox_configs.enabled`` hangs
    off MANAGE_GUILD and would let the target of a ban undo it).

    Applies on self-hosts too: there the operator IS the instance admin and
    unlocks their own communities. Default is locked (migration 0056).

    A missing guild 404s the same way — the routes below have no case where
    the community exists but the row doesn't."""
    guild = await session.get(Guild, guild_id)
    if guild is None or not guild.dropbox_allowed:
        raise HTTPException(404, detail="dropbox is not enabled for this community")
    return guild


#: The guild the gate above already loaded. FastAPI solves a dependency once
#: per request, so a route asking for this pays nothing extra — it just gets
#: handed the row instead of fetching it a second time.
DropboxGuild = Annotated[Guild, Depends(require_guild_dropbox_allowed)]


# Storage ceiling ------------------------------------------------------

#: Instance standard for a community's Ablage storage, used when the operator
#: has set no per-community ceiling (``guilds.dropbox_quota_bytes IS NULL``).
#: Deliberately well below the old 5 GiB ``DropboxConfig`` column default: that
#: value was never operator-controlled, and the Ablage stores file types no
#: scan can inspect. An operator who wants more raises it per community.
DEFAULT_DROPBOX_QUOTA_BYTES = 1024 * 1024 * 1024  # 1 GiB


def dropbox_quota_ceiling(guild: Guild) -> int:
    """The operator's storage ceiling for this community's Ablage."""
    if guild.dropbox_quota_bytes is None:
        return DEFAULT_DROPBOX_QUOTA_BYTES
    return guild.dropbox_quota_bytes


def new_dropbox_config(guild: Guild) -> DropboxConfig:
    """A community's first config row, starting at the operator's ceiling
    rather than the column default (5 GiB) — otherwise every new community
    would silently begin above the limit and get clamped on its first save."""
    return DropboxConfig(
        guild_id=guild.id, total_quota_bytes=dropbox_quota_ceiling(guild)
    )


async def clamp_dropbox_quota_to_ceiling(session: AsyncSession, guild: Guild) -> None:
    """Pull a community's own quota down to the operator ceiling if it sits
    above it. No-op while the community has never opened its Ablage.

    Deliberately allowed to land BELOW ``used_bytes``: an operator must be able
    to cap a community that has already filled up. The effect is that further
    uploads are refused — existing files stay readable and downloadable. This is
    the one path that may do that; the community's own editor still refuses to
    shrink below what it is using (``dropbox_admin.patch_settings``)."""
    cfg = await session.get(DropboxConfig, guild.id)
    if cfg is None:
        return
    cfg.total_quota_bytes = min(cfg.total_quota_bytes, dropbox_quota_ceiling(guild))
