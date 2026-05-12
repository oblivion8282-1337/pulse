"""MediaMTX stream-presence poller.

Every ``POLL_INTERVAL_S`` seconds we hit the MediaMTX control API
(``/v3/paths/list``) and look for paths named ``channel-<id>`` that currently
have an active publisher. From that we reconcile the per-channel stream state in
Redis (``stream:channel:<id>``) and publish any change on ``stream:events``.

Who is publishing? The auth hook wrote ``stream:active:channel-<id>`` →
``{user_id, started_at}`` when it approved the publish, so we look the user up
there. (If that record is missing for some reason — e.g. the hook restarted —
we still report ``active: true`` with ``user_id: null``.)

Self-heal: any channel Redis still marks ``active`` but MediaMTX no longer lists
with a publisher → flip to ``active: false`` and emit the event. Tolerant of a
dead/unreachable MediaMTX API (logs + retries, never crashes).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog
from redis.asyncio import Redis

from dcc_media_svc.config import get_settings
from dcc_media_svc.streamkeys import (
    ACTIVE_KEY,
    CHANNEL_STATE_KEY,
    STREAM_EVENTS_CHANNEL,
    channel_id_from_path,
)

log = structlog.get_logger(__name__)

_CHANNEL_STATE_SCAN_MATCH = "stream:channel:*"


def _path_has_publisher(path_obj: dict[str, Any]) -> bool:
    """True if a MediaMTX path object represents an active inbound stream.

    MediaMTX 1.18 renamed ``ready`` → ``available``/``online`` (``ready`` is
    kept as a deprecated alias). We accept any of them, and additionally require
    a non-null ``source`` (a path with only readers and no publisher has
    ``source: null``)."""
    source = path_obj.get("source")
    if not source:
        return False
    for flag in ("ready", "available", "online"):
        if path_obj.get(flag) is True:
            return True
    # Some builds omit the boolean but still expose a populated source for an
    # active publisher — treat a present source as "live" as a last resort.
    return True


async def _fetch_channel_publishers(client: httpx.AsyncClient, url: str) -> dict[str, bool]:
    """Return {channel_id: True} for every ``channel-<id>`` path with a publisher.

    Raises on transport/HTTP error — the caller handles it.
    """
    resp = await client.get(url, params={"itemsPerPage": 1000, "page": 0})
    resp.raise_for_status()
    data = resp.json()
    items = data.get("items", []) if isinstance(data, dict) else []
    out: dict[str, bool] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        cid = channel_id_from_path(item.get("name", ""))
        if cid is None:
            continue
        if _path_has_publisher(item):
            out[cid] = True
    return out


async def _read_state(redis: Redis, channel_id: str) -> dict[str, Any] | None:
    raw = await redis.get(CHANNEL_STATE_KEY.format(channel_id=channel_id))
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return None
    return data if isinstance(data, dict) else None


async def _publisher_user_id(redis: Redis, channel_id: str) -> str | None:
    raw = await redis.get(ACTIVE_KEY.format(channel_id=channel_id))
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return None
    uid = data.get("user_id") if isinstance(data, dict) else None
    return str(uid) if uid else None


async def _list_known_active_channels(redis: Redis) -> set[str]:
    """Channel ids currently marked ``active: true`` in Redis."""
    active: set[str] = set()
    async for key in redis.scan_iter(match=_CHANNEL_STATE_SCAN_MATCH):
        key_s = key.decode() if isinstance(key, bytes) else key
        cid = key_s.rsplit(":", 1)[-1]
        state = await _read_state(redis, cid)
        if state and state.get("active"):
            active.add(cid)
    return active


async def _publish_event(redis: Redis, channel_id: str, active: bool, user_id: str | None) -> None:
    await redis.publish(
        STREAM_EVENTS_CHANNEL,
        json.dumps(
            {"channel_id": channel_id, "active": active, "user_id": user_id},
            separators=(",", ":"),
        ),
    )


async def reconcile_once(redis: Redis, client: httpx.AsyncClient) -> None:
    """One reconciliation pass. Safe to call repeatedly; raises only on a
    MediaMTX-API failure (the loop swallows that)."""
    settings = get_settings()
    publishers = await _fetch_channel_publishers(client, settings.mediamtx_api_url)
    known_active = await _list_known_active_channels(redis)

    # New / continuing streams.
    for cid in publishers:
        user_id = await _publisher_user_id(redis, cid)
        prev = await _read_state(redis, cid)
        new_state = {
            "active": True,
            "user_id": user_id,
            "since": (prev or {}).get("since") or datetime.now(UTC).isoformat(),
        }
        if prev == new_state:
            # Refresh the TTL so the self-heal window stays bounded but the
            # value doesn't churn.
            await redis.expire(
                CHANNEL_STATE_KEY.format(channel_id=cid), settings.channel_state_ttl_s
            )
            continue
        await redis.set(
            CHANNEL_STATE_KEY.format(channel_id=cid),
            json.dumps(new_state, separators=(",", ":")),
            ex=settings.channel_state_ttl_s,
        )
        await _publish_event(redis, cid, True, user_id)
        log.info("stream_state_change", channel_id=cid, active=True, user_id=user_id)

    # Streams that went away → self-heal to inactive + event.
    for cid in known_active - set(publishers):
        await redis.delete(
            CHANNEL_STATE_KEY.format(channel_id=cid), ACTIVE_KEY.format(channel_id=cid)
        )
        await _publish_event(redis, cid, False, None)
        log.info("stream_state_change", channel_id=cid, active=False, user_id=None)


async def run_poller(redis: Redis, *, stop_event: asyncio.Event | None = None) -> None:
    """Long-running reconciliation loop. Resilient to MediaMTX being down."""
    settings = get_settings()
    stop = stop_event or asyncio.Event()
    async with httpx.AsyncClient(timeout=5.0) as client:
        while not stop.is_set():
            try:
                await reconcile_once(redis, client)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — MediaMTX may be unreachable
                log.warning("mediamtx_poll_failed", error=str(exc))
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.poll_interval_s)
            except TimeoutError:
                pass
