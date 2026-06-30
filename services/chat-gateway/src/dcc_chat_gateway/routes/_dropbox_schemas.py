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

from dcc_chat_gateway.schemas import SnowflakeId


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


# ---- Listing ---------------------------------------------------------------


class DropboxEntryOut(BaseModel):
    """Wire representation of one folder or file entry inside the dropbox.

    ``url`` is only set for files (folders never carry a presigned GET).
    Both fields are short-lived (~30 min) — the FE re-fetches via
    ``/download-url`` on 403 just like message-attachments do. The
    frontend treats folders and files uniformly (one FileCard component)
    with ``kind`` driving the variant. ``deleted_at`` is None for live
    entries and set on trashed ones; clients use the field to flip the
    Trash UI without a separate listing."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    guild_id: int
    channel_id: int
    parent_path: str
    name: str
    kind: int  # 0 = folder, 1 = file
    size_bytes: int | None = None
    content_type: str | None = None
    version: int = 1
    uploaded_by_id: int
    uploaded_at: datetime
    updated_at: datetime
    pinned: bool = False
    deleted_at: datetime | None = None
    # Set only for files and only when ``include_urls=true`` (default).
    url: str | None = None
    thumb_url: str | None = None

    @field_serializer("id", "guild_id", "channel_id", "uploaded_by_id")
    def _ser_ids(self, v: int) -> str:
        return str(v)


class DropboxEntriesOut(BaseModel):
    """Paginated folder listing. ``truncated`` = true on the (current)
    first-cut implementation: we hand back up to 500 entries per call;
    bigger folders are virtualised client-side. The shape is kept
    forward-compatible with cursor-paginated variants."""

    entries: list[DropboxEntryOut]
    parent_path: str
    truncated: bool = False


# ---- Mutations -------------------------------------------------------------


class DropboxFolderCreateIn(BaseModel):
    parent_path: Annotated[str, Field(default="", max_length=2048)] = ""
    name: Annotated[str, Field(min_length=1, max_length=255)]


class DropboxEntryPatchIn(BaseModel):
    """Entry mutation: rename, move, pin toggle. All optional — partial.

    `rename` and `move` together cover the two keyboard flows (F2 + drag
    in the file list). ``pinned`` is independent — you can pin/unpin
    without changing name or location."""

    name: Annotated[str | None, Field(default=None, min_length=1, max_length=255)] = None
    parent_path: Annotated[str | None, Field(default=None, max_length=2048)] = None
    pinned: bool | None = None


# ---- Upload (presigned PUT) ------------------------------------------------


class DropboxUploadUrlIn(BaseModel):
    """Client asks for a presigned PUT URL."""

    parent_path: Annotated[str, Field(default="", max_length=2048)] = ""
    name: Annotated[str, Field(min_length=1, max_length=255)]
    content_type: Annotated[str, Field(min_length=1, max_length=128)]
    size_bytes: Annotated[int, Field(ge=1, le=4 * 1024**4)]


# Note: the original schema carried optional ``width``/``height`` for
# image/video thumbnail aspect-ratio. The fields were never persisted
# on ``DropboxFile``, so they were removed instead of accumulating as
# dead columns in a future migration. Client side stops sending them.


class DropboxUploadUrlOut(BaseModel):
    """Server hands the client a single PUT URL + the snowflake id under
    which the file will be persisted once the upload commits. The client
    uses ``temp_id`` in the matching ``/finish-upload`` call."""

    id: SnowflakeId  # future entry id — client stores it for finish-upload
    upload_url: str
    # Storage path the client doesn't need but a curious developer
    # appreciates seeing in DevTools.
    storage_key: str

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return str(v)


class DropboxFinishUploadIn(BaseModel):
    """Called after the PUT to MinIO completes. The client echoes back the
    upload context (parent_path / name / size / content_type) so the
    server can HEAD the right object and verify both the size and
    content-type match the declared values (the pre-signed URL pinned
    both, so a mismatch means a tampered request). The ``id`` field is
    the snowflake the server reserved at mint time."""

    id: SnowflakeId
    parent_path: Annotated[str, Field(default="", max_length=2048)] = ""
    name: Annotated[str, Field(min_length=1, max_length=255)]
    # Echoed for the route's HEAD check; the server trusts the HEAD's
    # ContentLength as the truth and only uses size to fast-fail.
    size_bytes: Annotated[int, Field(ge=1, le=4 * 1024**4)]
    content_type: Annotated[str, Field(min_length=1, max_length=128)] = "application/octet-stream"
