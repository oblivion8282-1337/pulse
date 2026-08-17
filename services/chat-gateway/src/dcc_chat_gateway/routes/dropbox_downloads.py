"""Dropbox downloads — single-file URL mint + folder/multi ZIP archive.

Split out from ``routes/dropbox.py`` (which is already over the 350-line soft
cap, PLAN.md §12.1). Two endpoints:

* ``GET .../entries/{id}/download-url`` — mints a presigned GET URL signed with
  ``Content-Disposition: attachment`` so the browser downloads instead of
  rendering inline. Auth via the normal bearer header; the URL itself is
  MinIO-signed so the subsequent browser navigation needs no auth.

* ``GET .../download-archive`` — streams a ZIP. Auth via ``?token=`` (the
  ``CurrentUserQuery`` dependency) because ``window.location.href`` / ``<a>``
  can't attach an ``Authorization`` header. Streaming uses ``AioZipStream``
  which consumes our async ``s3.stream_object`` generator directly — no
  temp files, no buffering whole files, MinIO→ZIP→client chunked.

Download = read, so both endpoints gate on ``require_dropbox_view``
(Mitgliedschaft **und** ``VIEW_CHANNEL`` auf den Ablage-Kanal), mirroring
``list_entries`` — no ownership gate. Mitgliedschaft allein reichte hier bis
zum Bughunt vom 17. August: der Kanal ist der Rechteanker der Ablage, und ein
Riegel, der nur beim Auflisten sitzt, laesst den Herunterlade-Weg offen.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, or_, select
from zipstream import AioZipStream

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    DROPBOX_KIND_FOLDER,
    DropboxFile,
)
from dcc_chat_gateway.routes._dropbox_access import require_dropbox_view
from dcc_chat_gateway.routes._dropbox_helpers import (
    full_path,
    normalize_parent_path,
)
from dcc_chat_gateway.security import CurrentUser, CurrentUserQuery

router = APIRouter(tags=["dropbox"])

# Resource-exhaustion guards (413 on exceed). The archive is built on the fly
# and streamed, so these bound CPU/network time rather than memory — but a
# multi-gigabyte archive is still an expensive request to hold open.
MAX_ARCHIVE_FILES = 500
MAX_ARCHIVE_BYTES = 4 * 1024**3  # 4 GiB uncompressed
MAX_MULTI_IDS = 100  # URL-length-safe (100 snowflakes ≈ 1.9 kB)
CHUNK = 65536


def _sanitize_zip_filename(name: str) -> str:
    """Strip path separators + control chars so the ``Content-Disposition``
    filename can't break out of its quoted-string or smuggle a path."""
    cleaned = "".join(
        c for c in name if c not in "/\\\x00\r\n" and ord(c) >= 0x20
    )
    return cleaned or "download"


async def _live_file(
    session, guild_id: int, entry_id: int
) -> DropboxFile | None:
    return (
        await session.execute(
            select(DropboxFile).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.id == entry_id,
                DropboxFile.kind == DROPBOX_KIND_FILE,
                DropboxFile.deleted_at.is_(None),
            )
        )
    ).scalars().first()


# ---------------------------------------------------------------------------
# Single-file download URL
# ---------------------------------------------------------------------------


@router.get("/guilds/{guild_id}/dropbox/entries/{entry_id}/download-url")
async def get_download_url(
    guild_id: Annotated[int, Path(ge=1)],
    entry_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> dict[str, str]:
    """Mint a presigned GET URL that forces an attachment download
    (``Content-Disposition: attachment; filename=…``). Unlike ``entry.url``
    from the listing (which is ``inline`` for renderable types), this always
    downloads — the explicit "Download" button."""

    await require_dropbox_view(session, current, guild_id)
    if not ratelimit.check("dropbox_download", current.id):
        raise HTTPException(429, detail="too many download requests — slow down")
    entry = await _live_file(session, guild_id, entry_id)
    if entry is None or not entry.storage_key:
        raise HTTPException(404, detail="entry not found")
    try:
        url = await s3.presigned_get_url(
            entry.storage_key, filename=entry.name, inline=False
        )
    except Exception:  # noqa: BLE001 — MinIO unreachable: no graceful degrade
        raise HTTPException(503, detail="storage temporarily unavailable") from None
    return {"url": url}


# ---------------------------------------------------------------------------
# Folder / multi-select ZIP archive
# ---------------------------------------------------------------------------


async def _folder_exists(session, guild_id: int, folder_path: str) -> bool:
    """True if ``folder_path`` names a live folder. Root (``""``) trivially."""
    if not folder_path:
        return True
    parent, _, basename = folder_path.rpartition("/")
    hit = (
        await session.execute(
            select(DropboxFile.id).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.parent_path == parent,
                DropboxFile.name == basename,
                DropboxFile.kind == DROPBOX_KIND_FOLDER,
                DropboxFile.deleted_at.is_(None),
            ).limit(1)
        )
    ).scalar_one_or_none()
    return hit is not None


async def _collect_folder_files(
    session, guild_id: int, folder_path: str
) -> list[DropboxFile]:
    """All live files inside ``folder_path`` (recursive). Root (``""``)
    matches every live file in the guild; a non-empty prefix matches itself
    plus any descendant path."""
    conditions: list[Any] = [
        DropboxFile.guild_id == guild_id,
        DropboxFile.kind == DROPBOX_KIND_FILE,
        DropboxFile.deleted_at.is_(None),
    ]
    if folder_path:
        conditions.append(
            or_(
                DropboxFile.parent_path == folder_path,
                DropboxFile.parent_path.like(f"{folder_path}/%"),
            )
        )
    stmt = (
        select(DropboxFile)
        .where(and_(*conditions))
        .order_by(DropboxFile.parent_path, DropboxFile.name)
    )
    return list((await session.execute(stmt)).scalars())


async def _collect_entries_by_ids(
    session, guild_id: int, entry_ids: list[int]
) -> list[DropboxFile]:
    rows = (
        await session.execute(
            select(DropboxFile).where(
                DropboxFile.guild_id == guild_id,
                DropboxFile.id.in_(entry_ids),
                DropboxFile.kind == DROPBOX_KIND_FILE,
                DropboxFile.deleted_at.is_(None),
            )
        )
    ).scalars()
    # Preserve caller order; ignore ids that don't resolve (e.g. trashed mid-
    # request) rather than 404'ing the whole batch.
    by_id = {r.id: r for r in rows}
    return [by_id[i] for i in entry_ids if i in by_id]


def _parse_entry_ids(raw: str) -> list[int]:
    """Comma-separated snowflake strings → ints. Rejects non-digits so a
    malformed query can't reach the DB."""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        raise HTTPException(422, detail="entry_ids is empty")
    if len(parts) > MAX_MULTI_IDS:
        raise HTTPException(
            413, detail=f"too many files (max {MAX_MULTI_IDS})"
        )
    out: list[int] = []
    for p in parts:
        if not p.isdigit():
            raise HTTPException(422, detail="entry_ids must be numeric ids")
        out.append(int(p))
    return out


def _enforce_caps(files: list[DropboxFile]) -> None:
    if len(files) > MAX_ARCHIVE_FILES:
        raise HTTPException(
            413, detail=f"archive too large (max {MAX_ARCHIVE_FILES} files)"
        )
    total = sum(int(f.size_bytes or 0) for f in files)
    if total > MAX_ARCHIVE_BYTES:
        raise HTTPException(
            413, detail="archive too large (max 4 GiB)"
        )


async def _archive_stream(
    files: list[DropboxFile],
) -> AsyncIterator[bytes]:
    """Stream a ZIP. Each entry pulls its bytes lazily from MinIO via
    ``s3.stream_object`` (async generator), so only one file is in flight
    at a time and nothing is buffered whole."""
    entries: list[dict[str, Any]] = [
        {"name": full_path(f.parent_path or "", f.name).lstrip("/"),
         "stream": s3.stream_object(f.storage_key)}
        for f in files
        if f.storage_key
    ]
    aio = AioZipStream(entries, chunksize=CHUNK)
    async for chunk in aio.stream():
        yield chunk


@router.get("/guilds/{guild_id}/dropbox/download-archive")
async def download_archive(
    guild_id: Annotated[int, Path(ge=1)],
    session: SessionDep,
    current: CurrentUserQuery,
    token: Annotated[str, Query(description="bearer access token (browser-download auth)")],
    path: Annotated[str, Query(max_length=2048)] = "",
    entry_ids: Annotated[str, Query(max_length=4096)] = "",
) -> StreamingResponse:
    """Stream a ZIP of either a whole folder (``path``, recursive) or an
    explicit set of files (``entry_ids``). Exactly one of the two must be
    set. ``token`` is the bearer access token — browsers can't attach an
    ``Authorization`` header to a navigation, so it rides in the query
    string (same pattern as the WS endpoint)."""

    await require_dropbox_view(session, current, guild_id)
    if not ratelimit.check("dropbox_download", current.id):
        raise HTTPException(429, detail="too many download requests — slow down")

    if bool(path) == bool(entry_ids):
        raise HTTPException(
            422, detail="set exactly one of 'path' or 'entry_ids'"
        )

    if path:
        try:
            folder = normalize_parent_path(path)
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        if not await _folder_exists(session, guild_id, folder):
            raise HTTPException(404, detail="folder not found")
        files = await _collect_folder_files(session, guild_id, folder)
        zip_name = _sanitize_zip_filename(folder.rpartition("/")[2] or folder)
    else:
        ids = _parse_entry_ids(entry_ids)
        files = await _collect_entries_by_ids(session, guild_id, ids)
        zip_name = "dropbox-selection"

    if not files:
        raise HTTPException(404, detail="no files to download")
    _enforce_caps(files)

    return StreamingResponse(
        _archive_stream(files),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_name}.zip"',
        },
    )
