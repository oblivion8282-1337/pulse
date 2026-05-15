"""URL → watch-party source parser (authoritative).

The frontend has a mirror copy for live input feedback in the start popover,
but the WS handler revalidates with this function and rejects unknown sources
regardless — never trust the client's parse.

Supported v1:
  * YouTube — ``youtu.be/<id>``, ``youtube.com/watch?v=<id>``,
    ``/embed/<id>``, ``/shorts/<id>``. Optional ``t=`` / ``start=`` (whole
    seconds or ``Xh Ym Zs``) → ``start_seconds``.
  * Twitch VOD — ``twitch.tv/videos/<id>``. Live streams have no seek and are
    explicitly rejected.
  * Native — direct ``https://`` URL ending in ``.mp4`` / ``.webm`` / ``.m3u8``.

Returns the parsed source dict, or ``None`` for anything we can't sync.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

_MAX_URL_LEN = 2048

_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_TWITCH_VOD_PATH = re.compile(r"^/videos/(\d+)/?$")
_NATIVE_SUFFIX = re.compile(r"\.(mp4|webm|m3u8)$", re.IGNORECASE)
_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "www.youtube-nocookie.com",
}


def _parse_t(values: list[str]) -> int | None:
    """``42`` / ``42s`` / ``1m30s`` / ``1h2m3s`` → whole seconds."""
    if not values:
        return None
    raw = values[0].strip()
    if raw.isdigit():
        return int(raw)
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", raw)
    if m and any(m.groups()):
        h = int(m.group(1) or 0)
        mn = int(m.group(2) or 0)
        s = int(m.group(3) or 0)
        return h * 3600 + mn * 60 + s
    return None


def _start_seconds(qs: dict[str, list[str]]) -> int | None:
    for k in ("t", "start"):
        v = _parse_t(qs.get(k) or [])
        if v is not None:
            return v
    return None


def _yt(vid: str, qs: dict[str, list[str]]) -> dict:
    out: dict = {"type": "youtube", "embed_id": vid}
    start = _start_seconds(qs)
    if start is not None:
        out["start_seconds"] = start
    return out


def parse_source(url: object) -> dict | None:
    if not isinstance(url, str):
        return None
    url = url.strip()
    if not url or len(url) > _MAX_URL_LEN:
        return None
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme != "https":
        return None
    host = (u.hostname or "").lower()
    qs = parse_qs(u.query)

    # --- YouTube ---
    if host == "youtu.be":
        vid = u.path.lstrip("/").split("/", 1)[0]
        if _YOUTUBE_ID.match(vid):
            return _yt(vid, qs)
        return None
    if host in _YOUTUBE_HOSTS:
        vid: str | None = None
        if u.path == "/watch":
            vs = qs.get("v")
            vid = vs[0] if vs else None
        elif u.path.startswith("/embed/") or u.path.startswith("/shorts/"):
            parts = u.path.split("/", 2)
            if len(parts) >= 3:
                vid = parts[2].split("/", 1)[0]
        if vid and _YOUTUBE_ID.match(vid):
            return _yt(vid, qs)
        return None

    # --- Twitch VOD only ---
    if host in ("twitch.tv", "www.twitch.tv"):
        m = _TWITCH_VOD_PATH.match(u.path)
        if m:
            return {"type": "twitch", "embed_id": m.group(1)}
        return None

    # --- Native mp4/webm/m3u8 ---
    if _NATIVE_SUFFIX.search(u.path):
        return {"type": "native", "url": url}

    return None
