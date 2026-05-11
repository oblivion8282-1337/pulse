"""Avatar upload/delete/serve routes for the auth service."""

from __future__ import annotations

import io
import re
from pathlib import Path

import dcc_auth.config as _config
from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.routes import _get_current_user
from dcc_auth.schemas import UserPublic

router = APIRouter()

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_RAW_BYTES = 5 * 1024 * 1024  # 5 MB
_MAX_DIM = 256
_FILENAME_RE = re.compile(r"^\d+\.webp$")


def _avatar_dir() -> Path:
    settings = _config.get_settings()
    d = Path(settings.avatar_upload_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _avatar_path(user_id: int) -> Path:
    return _avatar_dir() / f"{user_id}.webp"


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
        img = Image.open(io.BytesIO(raw))
        img.verify()
        img = Image.open(io.BytesIO(raw))  # re-open after verify() (it exhausts the stream)
    except (UnidentifiedImageError, Exception) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid image file") from exc

    img.thumbnail((_MAX_DIM, _MAX_DIM), Image.LANCZOS)

    dest = _avatar_path(current.id)
    img.save(dest, "WEBP", quality=85)

    current.avatar_url = f"/api/auth/avatars/{current.id}.webp"
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

    current.avatar_url = None
    session.add(current)
    await session.commit()


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
