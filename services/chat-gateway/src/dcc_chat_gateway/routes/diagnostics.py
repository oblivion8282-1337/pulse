"""User-triggered diagnostic uploads — short bitstream captures from the
desktop sidecar.

Use case: AMD-VAAPI-AV1 stream freezes after a few seconds with audio still
playing. WHEP-receiver stats showed a 96% decode-failure rate plus a
software-decoder fallback to dav1d, which strongly suggests the AV1
bitstream itself is unparseable. To distinguish "AMD encoder produces
invalid OBUs" from "MediaMTX RTP packetizer mangles them", the admin needs
the raw FLV file straight off GSR's `-o` — bypassing MediaMTX. That file
is what this endpoint accepts.

Why a separate endpoint and not the avatar/icon path: this stores arbitrary
binary blobs (≤60 MB, ~10s of CBR AV1), not images, and skips all
content-inspection. Auth via the normal chat-gateway JWT — only logged-in
users can upload, and files are scoped to `<user_id>/...` so a careless
upload by one user cannot stomp on another's.

Storage is a host bind-mount (`~/pulse/diagnostics` on the VPS → mounted as
`/app/diagnostics` in the container) so the admin can `scp` results without
fishing them out of a Docker named volume. Files are NEVER served back
over HTTP — this is upload-only. Read-out happens via SSH.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import dcc_chat_gateway.config as _config
import structlog
from fastapi import APIRouter, Form, HTTPException, UploadFile, status

from dcc_chat_gateway.security import CurrentUser

log = structlog.get_logger(__name__)
router = APIRouter()

# Whitelist of file extensions we accept. Kept tight — the only legitimate
# producer right now is GSR-via-sidecar emitting FLV/MKV. Reject anything
# else to keep the volume from becoming a generic file-drop.
_ALLOWED_SUFFIXES = {".flv", ".mkv", ".mp4", ".ts", ".webm"}
_FILENAME_SAFE_RE = re.compile(r"[^a-zA-Z0-9._-]")


def _upload_root() -> Path:
    d = Path(_config.get_settings().diagnostics_upload_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _user_dir(user_id: int) -> Path:
    d = _upload_root() / str(user_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_filename(name: str | None, suffix: str) -> str:
    """Build a per-upload filename with an ISO timestamp + safe suffix.

    The client-supplied name is reduced to its suffix (anything else gets
    a timestamp prefix). Prevents path traversal and weird unicode without
    going full werkzeug.secure_filename. We don't trust the client to pick
    the on-disk name, only the extension.
    """
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = _FILENAME_SAFE_RE.sub("_", (name or "diag").rsplit("/", 1)[-1])[:40] or "diag"
    if not suffix.startswith("."):
        suffix = "." + suffix
    return f"{ts}-{base}{suffix}"


@router.post("/diagnostics/upload", status_code=status.HTTP_201_CREATED)
async def upload_diagnostic(
    file: UploadFile,
    current: CurrentUser,
    metadata: str | None = Form(default=None),
):
    """Accept a short diagnostic recording from an authenticated client.

    Multipart form:
      - ``file`` (required): the bitstream (.flv/.mkv/.mp4/.ts/.webm),
        ≤ ``diagnostics_max_bytes`` after read.
      - ``metadata`` (optional): a JSON blob with GPU/codec/UA/etc.
        Saved next to the file as ``<base>.meta.json``.

    Returns ``{ filename, size_bytes, user_id }``. The path is intentionally
    not returned in a serve-able form — pickup is SSH-only.
    """
    settings = _config.get_settings()
    max_bytes = settings.diagnostics_max_bytes

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ALLOWED_SUFFIXES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported extension '{suffix}' (allowed: {sorted(_ALLOWED_SUFFIXES)})",
        )

    # Stream-read with a hard cap. UploadFile uses SpooledTemporaryFile so
    # reading the whole thing in is fine up to ~60 MB; reject anything
    # larger by stopping after max_bytes+1.
    raw = await file.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"file exceeds {max_bytes // (1024 * 1024)} MB limit",
        )
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="empty file")

    fname = _safe_filename(file.filename, suffix)
    target = _user_dir(current.id) / fname
    target.write_bytes(raw)

    # Best-effort metadata sidecar. JSON-parse-then-pretty-print so we
    # neither store garbage nor lose structure on the disk.
    meta_obj: dict[str, object] | None = None
    if metadata:
        try:
            parsed = json.loads(metadata)
            if isinstance(parsed, dict):
                meta_obj = parsed
        except (json.JSONDecodeError, ValueError):
            log.warning(
                "diagnostic_metadata_unparseable",
                user_id=current.id,
                filename=fname,
            )
    if meta_obj is not None:
        meta_path = target.with_suffix(target.suffix + ".meta.json")
        meta_path.write_text(json.dumps(meta_obj, indent=2, ensure_ascii=False))

    log.info(
        "diagnostic_uploaded",
        user_id=current.id,
        filename=fname,
        size_bytes=len(raw),
        has_metadata=meta_obj is not None,
    )

    return {
        "filename": fname,
        "size_bytes": len(raw),
        "user_id": current.id,
    }
