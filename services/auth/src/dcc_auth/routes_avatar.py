"""Avatar upload/delete/serve routes for the auth service."""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
import secrets
from pathlib import Path

import dcc_auth.config as _config
from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError

# Guard against decompression-bomb DoS: a highly compressed 5 MB PNG can
# expand to >1 GB in RAM. 16 MP is more than enough for profile pictures.
Image.MAX_IMAGE_PIXELS = 16 * 1024 * 1024

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.routes import _get_current_user
from dcc_auth.schemas import UserPublic

router = APIRouter()

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_RAW_BYTES = 5 * 1024 * 1024  # 5 MB
_MAX_DIM = 256
_FILENAME_RE = re.compile(r"^\d+\.webp$")
# Content-addressed avatar key: SHA-256 hex of the processed WEBP bytes.
_HASH_FILENAME_RE = re.compile(r"^[0-9a-f]{64}\.webp$")


def _process_image(raw: bytes) -> bytes:
    """Validate + resize, return the processed WEBP bytes — runs in a thread pool."""
    img = Image.open(io.BytesIO(raw))
    img.verify()
    img = Image.open(io.BytesIO(raw))  # re-open after verify() (it exhausts the stream)
    img.thumbnail((_MAX_DIM, _MAX_DIM), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "WEBP", quality=85)
    return out.getvalue()


def _avatar_dir() -> Path:
    settings = _config.get_settings()
    d = Path(settings.avatar_upload_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _avatar_path(user_id: int) -> Path:
    return _avatar_dir() / f"{user_id}.webp"


def _by_hash_dir() -> Path:
    """Content-addressed avatar store. A by-hash copy lets Self-Host instances
    fetch a user's Cloud avatar via ``/avatars/by-hash/<hash>.webp`` — keyed by
    the ``avatar_hash`` from the signed profile-statement — WITHOUT learning the
    user's Cloud user-id (which the user-id-keyed path would leak, breaking the
    pairwise-sub privacy model self-hosts rely on)."""
    d = _avatar_dir() / "by-hash"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/me/avatar", response_model=UserPublic)
async def upload_avatar(
    file: UploadFile,
    session: SessionDep,
    current: User = Depends(_get_current_user),
):
    if file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="unsupported image type")

    raw = await file.read(_MAX_RAW_BYTES + 1)
    if len(raw) > _MAX_RAW_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="file too large (max 5 MB)")

    try:
        processed = await asyncio.to_thread(_process_image, raw)
    except (UnidentifiedImageError, Exception) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid image file") from exc

    # User-id-keyed file (Cloud frontend serves it via ``avatar_url``) PLUS a
    # content-addressed copy so Self-Hosts can resolve the avatar from the
    # ``avatar_hash`` carried in the profile-statement (see _by_hash_dir).
    avatar_hash = hashlib.sha256(processed).hexdigest()
    dest = _avatar_path(current.id)
    by_hash = _by_hash_dir() / f"{avatar_hash}.webp"
    dest.write_bytes(processed)
    if not by_hash.exists():
        by_hash.write_bytes(processed)

    # Cache-Buster: der Dateiname bleibt gleich (<user_id>.webp), also würde der
    # Browser das alte Bild aus dem Cache nehmen. Ein neuer ?v=-Token bei jedem
    # Upload macht die URL eindeutig — der GET-Endpoint ignoriert Query-Params.
    current.avatar_url = f"/api/auth/avatars/{current.id}.webp?v={secrets.token_urlsafe(6)}"
    current.avatar_hash = avatar_hash
    session.add(current)
    await session.commit()
    await session.refresh(current)
    return current


@router.delete("/me/avatar", status_code=status.HTTP_204_NO_CONTENT)
async def delete_avatar(
    session: SessionDep,
    current: User = Depends(_get_current_user),
):
    dest = _avatar_path(current.id)
    if dest.exists():
        dest.unlink()

    # The by-hash copy is content-addressed and may be shared by another user
    # with an identical image, so it's intentionally left in place (orphaned
    # blobs are harmless; a GC sweep can reap them later). Clearing the hash on
    # the user is what stops self-hosts from resolving the (now-deleted) avatar.
    current.avatar_url = None
    current.avatar_hash = None
    session.add(current)
    await session.commit()


@router.get("/avatars/by-hash/{filename}")
async def serve_avatar_by_hash(filename: str):
    """Content-addressed avatar serve — the path Self-Hosts use. Anonymous and
    immutable (the bytes are fixed by their hash), so it caches forever."""
    if not _HASH_FILENAME_RE.match(filename):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    path = _by_hash_dir() / filename
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/avatars/{filename}")
async def serve_avatar(filename: str):
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    path = _avatar_dir() / filename
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=86400"},
    )
