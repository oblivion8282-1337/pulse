"""Guild-icon upload/delete/serve. Owner-only writes, anonymous reads.

Mirrors the avatar route in auth-svc: incoming PNG/JPEG/WebP is resized to
256x256 (max) and re-saved as WebP. The `icon_url` on the Guild row points
back at `/api/chat/guild-icons/<guild_id>.webp?v=<random>` — the query token
is the cache-buster since the file name itself stays constant.

`guild_updated` is broadcast on Redis so every connected client refreshes
its sidebar without a refetch.
"""

from __future__ import annotations

import asyncio
import io
import re
import secrets
from pathlib import Path

import dcc_chat_gateway.config as _config
import structlog
from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 16 * 1024 * 1024

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import guild_or_404
from dcc_chat_gateway.routes.guilds import _guild_dict, _publish_guild_event
from dcc_chat_gateway.schemas import GuildOut
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import GuildUpdatedEvent

log = structlog.get_logger(__name__)
router = APIRouter()

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_RAW_BYTES = 5 * 1024 * 1024
_MAX_DIM = 256
_FILENAME_RE = re.compile(r"^\d+\.webp$")


def _icon_dir() -> Path:
    d = Path(_config.get_settings().guild_icon_upload_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _icon_path(guild_id: int) -> Path:
    return _icon_dir() / f"{guild_id}.webp"


def purge_icon_file(guild_id: int) -> None:
    """Die Symboldatei eines Servers best-effort vom Datentraeger entfernen.

    Gerufen aus den Loeschwegen (``routes.guilds.delete_guild``) NACH dem
    Commit — die DB-Zeile ist dann schon weg. Anders als Anhaenge und
    Ablage liegt das Symbol nicht in MinIO, sondern lokal
    (``<guild_icon_upload_dir>/<guild_id>.webp``, s. Modulkopf); ohne diesen
    Aufruf ueberlebt es die Community, zu der es gehoerte, und bleibt unter
    seiner deterministischen Adresse abrufbar (Bughunt 2026-08-17,
    ``ablage.md``). Ein Fehler bricht die Loeschung nicht ab — best-effort wie
    die MinIO-Purges daneben.
    """
    path = _icon_path(guild_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.warning("guild_icon_purge_failed", guild_id=guild_id)


class _KaputtesBild(ValueError):
    """Decode-Check (``Image.open``/``verify``) fehlgeschlagen → 400.

    Eigene Klasse statt bloßem ``except ValueError``, damit ein späterer
    ValueError aus exif_transpose/thumbnail/save weiterhin ein 500 bleibt.
    """


def _icon_verarbeiten(raw: bytes, ziel: Path) -> None:
    """CPU-Teil des Icon-Uploads: dekodieren, drehen, skalieren, als WebP
    schreiben. PIL ist durchweg sync — der Aufrufer verlagert das per
    ``asyncio.to_thread`` in den Thread-Pool (Muster wie ``push.py``), damit
    ein bis-5-MB-Bild den Event-Loop nicht anhält (Perf-Hunt 06.10.).

    Gleiche Schritte, gleiche Reihenfolge wie vormals inline im Handler.
    """
    try:
        img = Image.open(io.BytesIO(raw))
        img.verify()
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise _KaputtesBild("invalid image file") from exc
    img = ImageOps.exif_transpose(img)  # Handy-JPEGs: Orientation physisch anwenden
    if img.mode in ("P", "LA"):
        img = img.convert("RGBA")  # Paletten-Transparenz geht sonst verloren
    img.thumbnail((_MAX_DIM, _MAX_DIM), Image.LANCZOS)
    img.save(ziel, "WEBP", quality=85)


@router.post("/guilds/{guild_id}/icon", response_model=GuildOut)
async def upload_icon(
    guild_id: int,
    file: UploadFile,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    guild = await guild_or_404(session, guild_id)
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_GUILD,
        detail="only the owner can change the icon",
    )

    if file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="unsupported image type"
        )

    raw = await file.read(_MAX_RAW_BYTES + 1)
    if len(raw) > _MAX_RAW_BYTES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="file too large (max 5 MB)"
        )

    # Temp-Datei + Umbenennen nach dem Commit (Bughunt Runde 7, Spiegel zu
    # routes_avatar): das Icon ist die EINZIGE Kopie — ein Commit-Fehler nach
    # dem Überschreiben hätte das alte Wappen still zerstört, während die DB
    # weiter darauf zeigte.
    icon_tmp = _icon_path(guild.id).with_suffix(".webp.tmp")
    try:
        # CPU-Anteil (Dekodieren/Drehen/Skalieren/WebP) läuft im Thread-Pool,
        # nicht am Event-Loop (Perf-Hunt 06.10., Muster wie push.py).
        await asyncio.to_thread(_icon_verarbeiten, raw, icon_tmp)
    except _KaputtesBild as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="invalid image file"
        ) from exc

    guild.icon_url = f"/api/chat/guild-icons/{guild.id}.webp?v={secrets.token_urlsafe(6)}"
    await session.commit()
    icon_tmp.replace(_icon_path(guild.id))
    await session.refresh(guild)

    await _publish_guild_event(
        request, GuildUpdatedEvent(guild=_guild_dict(guild))
    )
    log.info("guild_icon_uploaded", guild_id=guild.id, user_id=current.id)
    return guild


@router.delete("/guilds/{guild_id}/icon", status_code=status.HTTP_204_NO_CONTENT)
async def delete_icon(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    guild = await guild_or_404(session, guild_id)
    await check_permission(
        session, current, guild_id, Permissions.MANAGE_GUILD,
        detail="only the owner can clear the icon",
    )

    path = _icon_path(guild.id)
    guild.icon_url = None
    await session.commit()
    # Unlink erst NACH dem Commit (Bughunt Runde 37, Spiegel zum Upload-Dort:
    # Temp+Rename-nach-Commit) — schlug der Commit fehl, zeigte icon_url
    # weiter auf bereits geloeschte Bytes.
    if path.exists():
        path.unlink()
    await _publish_guild_event(
        request, GuildUpdatedEvent(guild=_guild_dict(guild))
    )
    log.info("guild_icon_deleted", guild_id=guild.id, user_id=current.id)


@router.get("/guild-icons/{filename}")
async def serve_icon(filename: str):
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    path = _icon_dir() / filename
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=86400"},
    )
