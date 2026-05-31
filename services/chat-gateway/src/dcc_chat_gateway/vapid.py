"""VAPID key management for Web-Push (RFC 8292).

``ensure_vapid`` returns the in-process ``(private_pem, public_b64url)``
pair. If the operator pre-configures both via ``Settings.vapid_private_key``
+ ``vapid_public_key`` we trust those verbatim; otherwise we look on disk
at ``Settings.vapid_key_file`` and load the JSON we wrote on a previous
start; if neither exists we generate a fresh EC P-256 keypair, write
it (file 0600, dir 0700), and use it.

The keypair is cached at module scope — the first caller wins; subsequent
callers reuse the same in-memory pair. Tests can reset by calling
``reset_vapid_cache_for_tests()``.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from dcc_chat_gateway.config import Settings, get_settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class VapidKeys:
    """Loaded / generated VAPID material. Both fields are required to
    actually emit a push; ``public_b64url`` is what the browser passes
    to ``pushManager.subscribe({applicationServerKey})``."""

    private_pem: str
    public_b64url: str


_VAPID: VapidKeys | None = None


def _b64url(data: bytes) -> str:
    """URL-safe base64 with no ``=`` padding — RFC 7515 §2 / RFC 8292."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_keypair() -> VapidKeys:
    """Mint a fresh EC-P256 keypair. The public key is encoded as the
    raw 65-byte uncompressed point (0x04 || X || Y) base64url'd — that's
    what the W3C Push API spec requires for ``applicationServerKey``.
    The private key is PEM-encoded PKCS#8 (what pywebpush accepts)."""
    private = ec.generate_private_key(ec.SECP256R1())
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    public_raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return VapidKeys(private_pem=private_pem, public_b64url=_b64url(public_raw))


def _load_keypair_from_disk(path: Path) -> VapidKeys | None:
    """Read a previously-persisted JSON file. Returns ``None`` if the
    file doesn't exist or is corrupt — caller falls through to a fresh
    generation."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return VapidKeys(
            private_pem=data["private_pem"],
            public_b64url=data["public_b64url"],
        )
    except (OSError, ValueError, KeyError):
        log.exception("vapid key file at %s is corrupt; regenerating", path)
        return None


def _persist_keypair_to_disk(path: Path, keys: VapidKeys) -> None:
    """Write the keypair JSON with restrictive permissions.

    Dir is 0700, file is 0600 — the private key would let an attacker
    silently swap which push service we hit. Atomic via write-then-rename
    so a crash mid-write can't leave a half-empty file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        # Read-only mount / weird FS — best-effort, log but don't crash.
        log.warning("could not chmod 0700 on %s", path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(
            {"private_pem": keys.private_pem, "public_b64url": keys.public_b64url}
        )
    )
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        log.warning("could not chmod 0600 on %s", tmp)
    tmp.replace(path)


def _resolve_private_pem(raw: str) -> str:
    """Operator-provided private key, accepted as a raw PKCS#8 PEM *or* its
    base64 encoding.

    The base64 form exists because a multi-line PEM cannot survive a Docker
    ``env_file``: that format has no multi-line values, and Compose does not
    expand ``\\n`` escapes (verified against Compose v5.x). base64 collapses
    the PEM to a single line so it round-trips through ``env_file`` intact.

    Auto-detected: a value starting with ``-----BEGIN`` is used verbatim;
    anything else is treated as base64 and decoded. Raises ``ValueError`` if
    it is neither — a misconfigured key should fail loudly at startup, not
    silently fall through to a freshly generated keypair."""
    s = raw.strip()
    if s.startswith("-----BEGIN"):
        return raw
    try:
        return base64.b64decode(s, validate=True).decode("ascii")
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(
            "VAPID_PRIVATE_KEY must be a PKCS#8 PEM "
            "(-----BEGIN PRIVATE KEY-----) or its base64 encoding"
        ) from exc


def ensure_vapid(settings: Settings | None = None) -> VapidKeys | None:
    """Resolve the active VAPID keypair, generating + persisting if absent.

    Returns ``None`` only if generation is impossible (very unlikely;
    only if ``cryptography`` can't allocate). Operators who *don't* want
    push can leave it enabled — the public key endpoint will just hand
    out the auto-gen'd key.

    Caching: a process-level singleton. The first caller wins; subsequent
    callers reuse the same in-memory pair. Tests can reset by calling
    ``reset_vapid_cache_for_tests``.

    Emits a one-shot WARN log when we auto-generate a keypair on first
    startup (i.e. neither env vars nor an on-disk file were available).
    Operators running without a persistent volume on ``vapid_key_file``
    would otherwise silently invalidate every push subscription on each
    restart — the log makes that footgun visible.
    """
    global _VAPID
    if _VAPID is not None:
        return _VAPID
    settings = settings or get_settings()
    # Operator-provided: bypass the on-disk + auto-gen paths entirely.
    # The private key may be a raw PEM or base64-encoded PEM (see
    # ``_resolve_private_pem`` — base64 is the env_file-safe single-line form).
    if settings.vapid_private_key and settings.vapid_public_key:
        _VAPID = VapidKeys(
            private_pem=_resolve_private_pem(settings.vapid_private_key),
            public_b64url=settings.vapid_public_key,
        )
        return _VAPID

    path = Path(settings.vapid_key_file)
    on_disk = _load_keypair_from_disk(path)
    if on_disk is not None:
        _VAPID = on_disk
        return _VAPID

    fresh = _generate_keypair()
    persisted = True
    try:
        _persist_keypair_to_disk(path, fresh)
    except OSError:
        # Couldn't persist — still serve from memory; next restart will
        # regen and old subscriptions will break, but that's a deploy bug
        # rather than a user-facing crash.
        log.exception("could not persist VAPID key to %s", path)
        persisted = False
    # NB: stdlib logging reserves the ``message`` key on LogRecord — use
    # ``note`` so ``log.warning(..., extra={...})`` doesn't raise KeyError.
    log.warning(
        "vapid_auto_generated — Generated new VAPID keypair on first startup. "
        "In production set VAPID_PRIVATE_KEY/VAPID_PUBLIC_KEY env vars "
        "to a persistent keypair. Without persistence "
        "(e.g. Docker volume on vapid_key_file path), "
        "every restart will invalidate all push subscriptions silently.",
        extra={
            "vapid_key_file": str(settings.vapid_key_file),
            "persisted_to_disk": persisted,
        },
    )
    _VAPID = fresh
    return _VAPID


def reset_vapid_cache_for_tests() -> None:
    """Clear the process-level cache. Used by tests so each fixture can
    install its own deterministic key (or none at all)."""
    global _VAPID
    _VAPID = None


__all__ = [
    "VapidKeys",
    "ensure_vapid",
    "reset_vapid_cache_for_tests",
]
