"""JWKS-Pinning (Defense-in-Depth, DE 11 / Phase 3.1).

On every JWKS pull the set of ``kid`` values is hashed (SHA-256 over the
sorted kid list, hex-encoded).  The result is compared against the stored
pin (``settings.jwks_pin_file``).

Pin lifecycle
-------------
* **First pull** — no pin file exists → write the computed hash as the
  initial pin.  Silent (no warning).
* **Subsequent pull, hash unchanged** — silent (normal operation).
* **Graduated key-rotation** — new JWKS contains all old kids (or a
  super-set).  Old pin is stale; update it silently.  This is the
  expected rotation pattern: Cloud adds a new key first, waits for
  caches to expire, then retires the old key in a later pull.
* **Unexpected replacement** — new JWKS shares *no* kid with the pinned
  set.  WARN log + ``app.state.jwks_changed_unexpectedly = True``.  Pin
  is **NOT** automatically updated.  The operator must either:
  - Delete the pin file and restart, OR
  - Call ``DELETE /internal/jwks-pin`` (Phase 4 stub).

JWKS cold-start handling (Punkt 12)
-------------------------------------
If Redis is cold (no cached JWKS) *and* auth-svc (``settings.auth_jwks_url``,
by default a service in the same network resp. container) does not answer at
startup, ``jwks_ready`` stays ``False``.  A background retry-loop
(``jwks_retry_loop``) polls every 30 s and sets ``jwks_ready = True``
once a JWKS can be fetched.  WS connections return close-code **4046**
while ``jwks_ready`` is ``False``.  ``/health`` answers 200 with
``status=warming_up`` rather than 503 — the process is alive, only the
JWKS cache is still cold.

Public API
----------
``compute_jwks_pin(jwks_json)`` — pure, testable, no I/O.
``load_pin(path)``              — read pin file; ``None`` if absent.
``save_pin(path, pin)``         — atomic write via tmp-rename.
``check_and_update_pin(jwks_json, path, app_state)`` — full lifecycle.
``jwks_retry_loop(redis, settings, app_state)`` — background task.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    pass

log = logging.getLogger(__name__)

# Redis key where the JWKS is cached (mirrors credential_validator.py)
REDIS_JWKS_KEY = "auth:jwks:cached"

# Retry interval for cold-start JWKS fetch (seconds)
JWKS_RETRY_INTERVAL = 30


# ---------------------------------------------------------------------------
# Pure helpers — no I/O
# ---------------------------------------------------------------------------

def compute_jwks_pin(jwks_json: str) -> str | None:
    """Compute a SHA-256 pin over the sorted ``kid`` list in *jwks_json*.

    Returns a 64-char hex string, or ``None`` when the JWKS has no keys
    (empty key-set should not be pinned).
    """
    try:
        keys = json.loads(jwks_json).get("keys", [])
    except Exception:  # noqa: BLE001
        return None

    kids = sorted(k.get("kid", "") for k in keys if k.get("kid"))
    if not kids:
        return None

    digest = hashlib.sha256("|".join(kids).encode()).hexdigest()
    return digest


def _extract_kids(jwks_json: str) -> frozenset[str]:
    """Return the set of ``kid`` values present in *jwks_json*."""
    try:
        keys = json.loads(jwks_json).get("keys", [])
        return frozenset(k.get("kid", "") for k in keys if k.get("kid"))
    except Exception:  # noqa: BLE001
        return frozenset()


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def load_pin(path: str) -> str | None:
    """Load the stored pin from *path*.  Returns ``None`` if the file is absent."""
    p = Path(path)
    try:
        return p.read_text().strip() or None
    except FileNotFoundError:
        return None
    except OSError as exc:
        log.warning("jwks_pin: could not read pin file %s: %s", path, exc)
        return None


def save_pin(path: str, pin: str) -> None:
    """Atomically write *pin* to *path* (tmp-rename pattern).

    Creates parent directories as needed.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".jwks-pin-")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(pin)
        os.replace(tmp, p)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Pin lifecycle
# ---------------------------------------------------------------------------

def check_and_update_pin(
    jwks_json: str,
    pin_path: str,
    app_state: Any,
) -> None:
    """Check the JWKS against the stored pin; update or warn as appropriate.

    ``app_state`` is the FastAPI ``app.state`` object.  On unexpected key
    replacement, ``app_state.jwks_changed_unexpectedly`` is set to ``True``
    and the pin is **not** updated.

    This function is synchronous and does only local I/O (file read/write).
    Call it from whichever async context fetched the JWKS.
    """
    new_pin = compute_jwks_pin(jwks_json)
    if new_pin is None:
        log.debug("jwks_pin: empty JWKS received, skipping pin check")
        return

    old_pin = load_pin(pin_path)

    if old_pin is None:
        # First pull — establish the pin and the kids file silently.
        # The kids file is required so that the *next* pull can distinguish a
        # graduated rotation from an unexpected full replacement.
        try:
            save_pin(pin_path, new_pin)
            new_kids = _extract_kids(jwks_json)
            Path(pin_path + ".kids").write_text("|".join(sorted(new_kids)))
            log.info("jwks_pin: initial pin written (%s…)", new_pin[:8])
        except OSError as exc:
            log.warning("jwks_pin: could not write initial pin to %s: %s", pin_path, exc)
        return

    if new_pin == old_pin:
        # Pin matches — no-op
        log.debug("jwks_pin: pin unchanged")
        return

    # Hash changed — determine whether it's a graduated rotation or an
    # unexpected replacement by checking kid overlap.
    new_kids = _extract_kids(jwks_json)
    old_kids_pin_path = pin_path + ".kids"
    try:
        old_kids_raw = Path(old_kids_pin_path).read_text().strip()
        old_kids: frozenset[str] = frozenset(old_kids_raw.split("|")) if old_kids_raw else frozenset()
    except FileNotFoundError:
        old_kids = frozenset()

    if old_kids and not (old_kids & new_kids):
        # No kid overlap → unexpected full replacement
        log.warning(
            "jwks_pin: Cloud JWKS changed unexpectedly — "
            "no previously-pinned kids present in new set. "
            "Operator action required: delete %s and restart, or call "
            "DELETE /internal/jwks-pin to reset. "
            "Old pin=%s…, new pin=%s…",
            pin_path,
            old_pin[:8],
            new_pin[:8],
        )
        setattr(app_state, "jwks_changed_unexpectedly", True)
        # Do NOT update the pin file
        return

    # Graduated rotation (overlap exists) — update pin silently
    try:
        save_pin(pin_path, new_pin)
        # Persist new kid list for future overlap checks
        Path(old_kids_pin_path).write_text("|".join(sorted(new_kids)))
        log.info("jwks_pin: graduated rotation detected, pin updated (%s…)", new_pin[:8])
    except OSError as exc:
        log.warning("jwks_pin: could not update pin file: %s", exc)
    # Clear the flag in case it was previously set
    setattr(app_state, "jwks_changed_unexpectedly", False)


# ---------------------------------------------------------------------------
# JWKS cold-start / background retry
# ---------------------------------------------------------------------------

async def _try_fetch_jwks(jwks_url: str, redis: Any) -> bool:
    """Attempt to fetch the JWKS from *jwks_url* and warm the Redis cache.

    Returns ``True`` on success.  The CRL-poller and security.py keep the
    Redis key warm in steady-state; this is only the cold-start path.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(jwks_url)
            resp.raise_for_status()
            await redis.set(REDIS_JWKS_KEY, resp.text)
            return True
    except Exception as exc:  # noqa: BLE001
        log.warning("jwks_retry: fetch failed (%s: %s)", type(exc).__name__, exc)
        return False


async def jwks_retry_loop(redis: Any, settings: Any, app_state: Any) -> None:
    """Background task: retry JWKS fetch every 30 s until ready.

    Sets ``app_state.jwks_ready = True`` once the JWKS is in Redis.
    Designed to be launched as an asyncio.Task; cancellation bubbles out.
    """
    log.info("jwks_retry: starting cold-start retry loop")
    while True:
        raw = await redis.get(REDIS_JWKS_KEY)
        if raw:
            log.info("jwks_retry: JWKS now available in Redis, marking ready")
            app_state.jwks_ready = True
            return

        log.info("jwks_retry: Redis JWKS cold, attempting fetch from %s", settings.auth_jwks_url)
        ok = await _try_fetch_jwks(settings.auth_jwks_url, redis)
        if ok:
            log.info("jwks_retry: JWKS fetched successfully, marking ready")
            app_state.jwks_ready = True
            return

        try:
            await asyncio.sleep(JWKS_RETRY_INTERVAL)
        except asyncio.CancelledError:
            raise
