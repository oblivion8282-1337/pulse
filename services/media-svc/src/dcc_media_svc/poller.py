"""MediaMTX stream-presence poller.

Every ``POLL_INTERVAL_S`` seconds we hit the MediaMTX control API
(``/v3/paths/list``) and look for paths named ``channel-<cid>-<uid>`` that
currently have an active publisher. From that we reconcile the per-channel
*set* of HQ streamers in Redis (``stream:channel:<cid>`` →
``{user_ids: [...], since}``) and publish any change on ``stream:events``.

The publisher's user-id is right there in the path, so no ``stream:active:``
lookup is needed for attribution (the auth hook still writes those records;
they self-heal via TTL and are useful for debugging).

Self-heal: any channel Redis still marks as having streamers but MediaMTX no
longer lists any ``channel-<cid>-*`` publisher → drop the key + emit an empty
event. Tolerant of a dead/unreachable MediaMTX API (logs + retries, never
crashes).
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
    CHANNEL_STATE_KEY,
    STREAM_EVENTS_CHANNEL,
    parse_channel_user_path,
)

log = structlog.get_logger(__name__)

_CHANNEL_STATE_SCAN_MATCH = "stream:channel:*"


def _path_has_publisher(path_obj: dict[str, Any]) -> bool:
    """True if a MediaMTX path object represents an active inbound stream.

    MediaMTX 1.18 renamed ``ready`` → ``available``/``online`` (``ready`` is
    kept as a deprecated alias). We accept any of them, and additionally require
    a non-null ``source`` (a path with only readers has ``source: null``)."""
    source = path_obj.get("source")
    if not source:
        return False
    for flag in ("ready", "available", "online"):
        if path_obj.get(flag) is True:
            return True
    # ``source`` is set but no readiness flag fired. That happens during the
    # RTMP handshake (TCP up, no keyframe yet) — MediaMTX won't actually serve
    # the path to WHEP readers in this state, so treat it as not-live to avoid
    # publishing flapping presence events.
    return False


async def _fetch_channel_publishers(client: httpx.AsyncClient, url: str) -> dict[str, set[str]]:
    """``{channel_id: {user_id, ...}}`` for every ``channel-<cid>-<uid>`` path
    that has a publisher. Raises on transport/HTTP error — the caller handles it.

    MediaMTX paginates ``/v3/paths/list``; we walk every page so a backlog of
    >1000 paths never silently drops streamers from the presence snapshot."""
    out: dict[str, set[str]] = {}
    page = 0
    items_per_page = 1000
    _MAX_PAGES = 10_000  # guard against an infinite-loop if MediaMTX always returns a full page
    while page < _MAX_PAGES:
        resp = await client.get(url, params={"itemsPerPage": items_per_page, "page": page})
        resp.raise_for_status()
        data = resp.json()
        items = (data.get("items") or []) if isinstance(data, dict) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            cu = parse_channel_user_path(item.get("name", ""))
            if cu is None:
                continue
            if _path_has_publisher(item):
                cid, uid, _nonce = cu  # nonce is per-publish; presence not state
                out.setdefault(cid, set()).add(uid)
        if len(items) < items_per_page:
            break
        page += 1
    else:
        log.warning("mediamtx_pagination_limit_reached", max_pages=_MAX_PAGES)
    return out


async def _list_known_channels(redis: Redis) -> set[str]:
    """Channel ids that currently have a ``stream:channel:<cid>`` key."""
    out: set[str] = set()
    async for key in redis.scan_iter(match=_CHANNEL_STATE_SCAN_MATCH):
        key_s = key.decode() if isinstance(key, bytes) else key
        out.add(key_s.rsplit(":", 1)[-1])
    return out


async def _publish_event(redis: Redis, channel_id: str, user_ids: list[str]) -> None:
    from dcc_shared.events import StreamStateSnapshot

    snapshot = StreamStateSnapshot(channel_id=channel_id, user_ids=user_ids)
    await redis.publish(
        STREAM_EVENTS_CHANNEL,
        json.dumps(snapshot.model_dump(mode="json"), separators=(",", ":")),
    )


def _parse_state(raw: bytes | str | None) -> dict[str, Any] | None:
    """Decode a raw Redis value into a state dict, or None on any error."""
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return None
    return data if isinstance(data, dict) else None


async def reconcile_once(redis: Redis, client: httpx.AsyncClient) -> None:
    """One reconciliation pass. Raises only on a MediaMTX-API failure (the loop
    swallows that).

    Redis access pattern:
     1. One MGET for all known channel states (batch read).
     2. One pipeline flush for all EXPIRE/SET writes and PUBLISH calls.
     3. One pipeline flush for stale-channel DEL+PUBLISH.
    This reduces O(N) sequential round-trips to O(1) network calls regardless
    of how many channels are active.
    """
    settings = get_settings()
    publishers = await _fetch_channel_publishers(client, settings.mediamtx_api_url)
    known = await _list_known_channels(redis)

    # --- Batch-read all channel states we need to inspect ----------------
    all_cids = list(publishers.keys())
    if all_cids:
        keys = [CHANNEL_STATE_KEY.format(channel_id=cid) for cid in all_cids]
        raw_values = await redis.mget(*keys)
        prev_states: dict[str, dict[str, Any] | None] = {
            cid: _parse_state(raw) for cid, raw in zip(all_cids, raw_values)
        }
    else:
        prev_states = {}

    # --- Compute changes, then flush writes in one pipeline ---------------
    async with redis.pipeline(transaction=False) as pipe:
        changed: list[tuple[str, list[str]]] = []  # (cid, new_uids) for PUBLISH
        for cid, uids in publishers.items():
            new_uids = sorted(uids)
            prev = prev_states.get(cid)
            prev_uids = sorted(str(u) for u in (prev or {}).get("user_ids", []) if u)
            if prev is not None and prev_uids == new_uids:
                pipe.expire(CHANNEL_STATE_KEY.format(channel_id=cid), settings.channel_state_ttl_s)
                continue
            # Carry `since` forward only if at least one user from the previous
            # set is still present; if the entire set turned over, reset to now
            # so the UI doesn't show the new streamer as having started during
            # the old session.
            prev_uid_set = set(prev_uids)
            carry_since = bool(prev and prev_uid_set & set(new_uids))
            since = (prev or {}).get("since") if carry_since else None
            new_state = {"user_ids": new_uids, "since": since or datetime.now(UTC).isoformat()}
            pipe.set(
                CHANNEL_STATE_KEY.format(channel_id=cid),
                json.dumps(new_state, separators=(",", ":")),
                ex=settings.channel_state_ttl_s,
            )
            changed.append((cid, new_uids))
        await pipe.execute()

    # Publish change events after the pipeline flush (outside the pipeline so
    # subscribers see the new state already written).
    for cid, new_uids in changed:
        await _publish_event(redis, cid, new_uids)
        log.info("stream_state_change", channel_id=cid, user_ids=new_uids)

    # --- Self-heal: channels no longer reported by MediaMTX ---------------
    stale = known - set(publishers)
    if stale:
        async with redis.pipeline(transaction=False) as pipe:
            for cid in stale:
                pipe.delete(CHANNEL_STATE_KEY.format(channel_id=cid))
            await pipe.execute()
        for cid in stale:
            await _publish_event(redis, cid, [])
            log.info("stream_state_change", channel_id=cid, user_ids=[])


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
