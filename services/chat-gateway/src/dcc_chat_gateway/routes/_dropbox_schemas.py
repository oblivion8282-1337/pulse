"""Pydantic schemas for the dropbox feature.

Co-located with ``routes/dropbox.py`` rather than the central
``schemas.py`` to keep each file under the 350-line soft cap
(PLAN.md §12.1) and to keep the entire feature's wire surface in one
importable module.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_serializer


# ---- Quota / settings ------------------------------------------------------


class DropboxConfigOut(BaseModel):
    """The quota + per-guild admin settings a sidebar+settings-UI reads."""

    model_config = ConfigDict(from_attributes=True)

    guild_id: int
    enabled: bool
    total_quota_bytes: int
    per_file_max_bytes: int
    used_bytes: int
    trash_retention_days: int
    updated_at: datetime

    @field_serializer("guild_id")
    def _ser_gid(self, v: int) -> str:
        return str(v)


class DropboxConfigPatch(BaseModel):
    """Admin-only update. All fields optional — partial patches land cleanly."""

    enabled: bool | None = None
    total_quota_bytes: Annotated[
        int | None, Field(default=None, ge=1024 * 1024, le=10 * 1024**4)
    ] = None
    per_file_max_bytes: Annotated[
        int | None, Field(default=None, ge=1024, le=4 * 1024**4)
    ] = None
    trash_retention_days: Annotated[
        int | None, Field(default=None, ge=1, le=365)
    ] = None


# ---- Channel ---------------------------------------------------------------


class DropboxChannelOut(BaseModel):
    """Returned by ``GET /guilds/{id}/dropbox/channel`` (ensure-or-fetch).

    The frontend uses the channel id (``type=2``) to navigate to the
    dropbox view in the same way it navigates to text / voice channels
    — no separate routing surface. ``created`` tells the FE whether it
    should fire the empty-state ("Lege deinen ersten Ordner an …") or a
    populated view."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    guild_id: int
    name: str
    type: int
    position: int
    created: bool  # True iff this call just created the channel

    @field_serializer("id", "guild_id")
    def _ser_ids(self, v: int) -> str:
        return str(v)


# ---- Mutations -------------------------------------------------------------


class DropboxChannelCreateIn(BaseModel):
    """Body for ``POST /guilds/{id}/dropbox/channel``.

    Optional ``name``: applied on creation only. If a dropbox channel
    already exists for the guild the existing one is returned unchanged
    (singleton semantics — admins rename via PATCH instead)."""

    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None


# ---- Laufwerk (Freigabe-Adresse) -------------------------------------------


class FreigabeAdresseIn(BaseModel):
    """Body zum Setzen einer Netzwerk-Freigabe (Kanal- UND Community-Laufwerk;
    vorher in ``ablage_kanal.py``/``ablage_guild_laufwerk.py`` doppelt)."""

    model_config = ConfigDict(extra="forbid")

    freigabe_adresse: Annotated[str, Field(min_length=1, max_length=8192)]
