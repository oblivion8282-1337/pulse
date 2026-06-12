"""URL → watch-party source parser (authoritative).

The frontend has a mirror copy for live input feedback in the start popover,
but the WS handler revalidates with this function and rejects unknown sources
regardless — never trust the client's parse.

Supported v1:
  * YouTube — ``youtu.be/<id>``, ``youtube.com/watch?v=<id>``,
    ``/embed/<id>``, ``/shorts/<id>``. Optional ``t=`` / ``start=`` (whole
    seconds or ``Xh Ym Zs``) → ``start_seconds``.
  * Twitch VOD — ``twitch.tv/videos/<id>``.
  * Twitch live channel — ``twitch.tv/<channel_name>``. Yields
    ``{"type": "twitch_live", "channel": "<name>"}``. Live sources are
    treated as a passive shared embed by the watch-party tile: no
    heartbeat sync, no drift correction, no play/pause broadcast (Twitch
    doesn't expose seek/position on live streams, and viewers' HLS buffers
    keep them within ~1-2s anyway). The host role reduces to "started it /
    can stop it".
  * Native — direct ``https://`` URL ending in ``.mp4`` / ``.webm``. (HLS
    ``.m3u8`` is intentionally NOT accepted: the viewer is a plain ``<video>``
    element and Pulse targets Chromium/Electron, which can't play HLS natively
    — accepting it would only produce a silent load failure. Re-add together
    with an hls.js MSE path if HLS is ever wanted.)

Returns the parsed source dict, or ``None`` for anything we can't sync.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import parse_qs, urlparse

_MAX_URL_LEN = 2048

_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_TWITCH_VOD_PATH = re.compile(r"^/videos/(\d+)/?$")
_NATIVE_SUFFIX = re.compile(r"\.(mp4|webm)$", re.IGNORECASE)
_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "www.youtube-nocookie.com",
}

# Twitch channel-name rules are community-derived (no official regex):
#  * Letters/digits/underscores, 1-25 chars (modern accounts ≥4, but legacy
#    accounts from old contests can be 1-3, so we accept).
#  * Names can't start with underscore on new accounts; legacy may, so the
#    pattern allows it. Twitch rejects invalid names server-side anyway.
_TWITCH_CHANNEL_NAME = re.compile(r"^[A-Za-z0-9_]{1,25}$")
# Path segments under twitch.tv/ that are NOT channel homes. If `parse_source`
# is handed e.g. `twitch.tv/directory` it must not embed a non-existent
# "directory" channel. Keep in sync with the frontend mirror in source.ts.
_TWITCH_RESERVED_PATHS = frozenset(
    {
        "videos",
        "directory",
        "p",
        "user",
        "users",
        "legal",
        "admin",
        "login",
        "signup",
        "logout",
        "jobs",
        "team",
        "teams",
        "subscriptions",
        "friends",
        "inventory",
        "wallet",
        "downloads",
        "search",
        "settings",
        "moderator",
        "following",
        "followers",
        "popout",
        "embed",
        "clip",
        "clips",
        "collections",
        "creatorcamp",
        "turbo",
        "prime",
        "drops",
        "store",
        "broadcast",
        "dashboard",
    }
)


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

    # --- Twitch VOD + live channel ---
    if host in ("twitch.tv", "www.twitch.tv", "m.twitch.tv", "go.twitch.tv"):
        m = _TWITCH_VOD_PATH.match(u.path)
        if m:
            out: dict = {"type": "twitch", "embed_id": m.group(1)}
            start = _start_seconds(qs)
            if start is not None:
                out["start_seconds"] = start
            return out
        # Live channel: exactly one path segment, not a reserved keyword,
        # matches the channel-name pattern. Anything multi-segment (clips,
        # /<name>/v/<id>, /<name>/clip/<slug>, etc.) is intentionally not
        # supported v1 — keep the surface small.
        parts = [p for p in u.path.split("/") if p]
        if len(parts) == 1:
            name = parts[0].lower()
            if name not in _TWITCH_RESERVED_PATHS and _TWITCH_CHANNEL_NAME.match(parts[0]):
                return {"type": "twitch_live", "channel": parts[0]}
        return None

    # --- Native mp4/webm ---
    if _NATIVE_SUFFIX.search(u.path):
        if _is_private_host(host):
            return None
        return {"type": "native", "url": url}

    return None


def _is_private_host(hostname: str) -> bool:
    """Return True if *hostname* refers to a private/internal network address.

    Prevents guild members from using the watch-party native-URL feature to
    weaponize other viewers' browsers as probes against internal hosts (SSRF
    via client-side fetch).  We block:

    * Unresolvable / empty hostnames (no host at all)
    * ``localhost`` and loopback aliases
    * RFC-1918 private ranges, link-local, and similar non-public ranges,
      detected via :func:`ipaddress.ip_address` ``is_private`` / ``is_loopback``
      / ``is_link_local`` flags (covers IPv4 and IPv6 literals).
    * Bare numeric IPv4/IPv6 literals (same check applied after parsing).
    * Well-known private/internal DNS TLDs and suffixes (``*.local``,
      ``*.internal``, ``*.intranet``, ``*.corp``, ``*.lan``, ``*.home``,
      ``*.localdomain``, ``*.localhost``).

    Limitation: a public DNS name that resolves to a private IP (DNS-rebinding /
    split-horizon DNS) cannot be caught here without an async resolver, which
    would be a DoS vector.  That residual risk is mitigated at the permission
    layer — the ``watch_start`` WS op requires channel membership, and native
    URLs additionally require MANAGE_CHANNELS (enforced in
    ``routes/ws_watch.py::handle_start``).
    """
    if not hostname:
        return True

    # Well-known localhost / loopback aliases.
    _LOCALHOST_NAMES = frozenset({"localhost", "localhost.localdomain"})
    if hostname in _LOCALHOST_NAMES:
        return True

    # Private / internal DNS TLDs and common split-horizon suffixes.
    # These are never valid public hostnames (RFC-6762 reserves .local for
    # mDNS; IANA has not delegated any of the others as public TLDs).
    _PRIVATE_TLDS = frozenset(
        {
            "local",
            "internal",
            "intranet",
            "corp",
            "lan",
            "home",
            "localdomain",
            "localhost",
        }
    )
    # hostname is already lowercased by the caller (urlparse .hostname).
    parts = hostname.split(".")
    if parts[-1] in _PRIVATE_TLDS:
        return True

    # Try to parse as a raw IP address (IPv4 literal or bracketed IPv6).
    try:
        addr = ipaddress.ip_address(hostname)
        return (
            addr.is_loopback
            or addr.is_private
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        )
    except ValueError:
        # Not an IP literal — it's a regular hostname.  We cannot do DNS
        # resolution here (no async context, and resolving would be a DoS
        # vector).  Public hostnames that split-horizon-resolve to private IPs
        # are mitigated by the permission gate described in the docstring.
        return False
