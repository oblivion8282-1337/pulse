"""Cloud policy background poller (Phase 3.3).

Polls ``{cloud_origin}/.well-known/pulse-version-policy.json`` every 6 h
(configurable via ``settings.cloud_policy_poll_interval``).

Expected response shape::

    {
        "version": 1,
        "current_version": "0.8.0",
        "min_version": "0.7.0",
        "updated_at": "2026-05-26T00:00:00Z"
    }

Persistence: ``chat:cloud_policy:current`` (no TTL — last-known-good stays
until overwritten). Helpers read this key to drive the WS hello-frame check
that Phase 4 will add to the frontend.

Fail-soft: Cloud unerreichbar → log WARN, letzter Stand bleibt.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

# Redis key — no TTL, last-known-good.
REDIS_POLICY_KEY = "chat:cloud_policy:current"

# HTTP timeout for a single policy fetch.
_FETCH_TIMEOUT = 10.0


async def _fetch_policy(client: httpx.AsyncClient, url: str) -> dict | None:
    """Return the parsed policy dict, or None on any error (fail-soft)."""
    try:
        resp = await client.get(url, timeout=_FETCH_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as exc:
        log.warning(
            "cloud_policy_poll: HTTP %s from %s — keeping last-known-good",
            exc.response.status_code,
            url,
        )
    except (httpx.RequestError, Exception) as exc:  # noqa: BLE001
        log.warning(
            "cloud_policy_poll: fetch failed (%s: %s) — keeping last-known-good",
            type(exc).__name__,
            exc,
        )
    return None


async def cloud_policy_poll_once(redis: Any, cloud_origin: str, client: httpx.AsyncClient) -> None:
    """Run a single policy-poll cycle (called from the background loop)."""
    url = f"{cloud_origin.rstrip('/')}/.well-known/pulse-version-policy.json"
    data = await _fetch_policy(client, url)
    if data is None:
        return
    await redis.set(REDIS_POLICY_KEY, json.dumps(data))
    log.info(
        "cloud_policy_poll: current=%s min=%s",
        data.get("current_version"),
        data.get("min_version"),
    )


async def cloud_policy_poller_loop(
    redis: Any,
    cloud_origin: str,
    interval: int,
) -> None:
    """Background task: poll the cloud policy document every ``interval`` seconds.

    Designed to be launched as an asyncio.Task in the chat-gateway lifespan.
    CancelledError bubbles out cleanly.
    """
    log.info(
        "cloud_policy_poller started (origin=%s, interval=%ds)", cloud_origin, interval
    )
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await cloud_policy_poll_once(redis, cloud_origin, client)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("Unexpected error in cloud_policy_poll cycle")
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise


async def get_cached_policy(redis: Any) -> dict | None:
    """Return the last-known-good cloud policy, or None if not yet fetched."""
    raw = await redis.get(REDIS_POLICY_KEY)
    if raw is None:
        return None
    try:
        text = raw.decode() if isinstance(raw, bytes) else raw
        return json.loads(text)
    except (json.JSONDecodeError, AttributeError):
        return None
