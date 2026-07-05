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
    active_key,
    parse_channel_user_path,
    stopping_key,
    streams_from_state,
)

log = structlog.get_logger(__name__)

_CHANNEL_STATE_SCAN_MATCH = "stream:channel:*"

# A live HQ stream is a ``(user_id, slot)`` pair — slot is a string here, as it
# comes straight off the parsed MediaMTX path ("0" for the legacy slot).
Pair = tuple[str, str]


def _user_ids(pairs: set[Pair]) -> list[str]:
    """Deduplicated, sorted set of streaming users (one entry per user)."""
    return sorted({uid for uid, _slot in pairs})


def _stream_descriptors(
    pairs: set[Pair], cid: str, label_of: dict[tuple[str, str, str], str]
) -> list[dict[str, Any]]:
    """``[{"user_id", "slot": int, "label"?}]`` for the channel-state ``streams``
    list, sorted by (user, slot) for stable comparison + output. ``label`` is
    pulled from the per-(channel,user,slot) map built earlier in the pass from
    ``stream:active`` records; absent when the streamer's platform can't name the
    source or the active record hasn't been written yet."""
    out: list[dict[str, Any]] = []
    for uid, slot in sorted(pairs, key=lambda p: (p[0], int(p[1]))):
        entry: dict[str, Any] = {"user_id": uid, "slot": int(slot)}
        label = label_of.get((cid, uid, slot))
        if isinstance(label, str) and label:
            entry["label"] = label
        out.append(entry)
    return out


def _is_multi(pairs: set[Pair]) -> bool:
    """True once any user runs slot ≥ 1 — only then is ``streams`` carried (it
    adds nothing over ``user_ids`` when everyone is on slot 0)."""
    return any(slot != "0" for _uid, slot in pairs)


def _pairs_from_state(state: dict[str, Any]) -> set[Pair]:
    """Reconstruct the ``(user_id, slot)`` set a previous channel-state stood
    for. Slot-aware records use ``streams``; legacy records (no ``streams``) map
    every user to slot "0"."""
    streams = streams_from_state(state)
    if streams:
        return {(d["user_id"], str(d["slot"])) for d in streams}
    return {(str(u), "0") for u in state.get("user_ids") or [] if u}


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


async def _fetch_channel_publishers(
    client: httpx.AsyncClient, url: str
) -> tuple[dict[str, set[Pair]], bool]:
    """``({channel_id: {(user_id, slot), ...}}, any_items_seen)`` for every
    ``channel-<cid>-<uid>[-s<slot>]`` path that has a publisher.
    Raises on transport/HTTP error — the caller handles it.

    ``any_items_seen`` is True if at least one path object was returned across
    all pages.  A False value alongside an empty result means MediaMTX reported
    zero paths total (e.g. during a rolling restart), which callers should treat
    as an unreliable snapshot rather than evidence that all streams ended.

    MediaMTX paginates ``/v3/paths/list``; we walk every page so a backlog of
    >1000 paths never silently drops streamers from the presence snapshot."""
    out: dict[str, set[Pair]] = {}
    any_items_seen = False
    page = 0
    items_per_page = 1000
    _MAX_PAGES = 10_000  # guard against an infinite-loop if MediaMTX always returns a full page
    while page < _MAX_PAGES:
        resp = await client.get(url, params={"itemsPerPage": items_per_page, "page": page})
        resp.raise_for_status()
        data = resp.json()
        items = (data.get("items") or []) if isinstance(data, dict) else []
        if items:
            any_items_seen = True
        for item in items:
            if not isinstance(item, dict):
                continue
            cu = parse_channel_user_path(item.get("name", ""))
            if cu is None:
                continue
            if _path_has_publisher(item):
                cid, uid, slot, _nonce = cu  # nonce is per-publish; presence not state
                out.setdefault(cid, set()).add((uid, slot))
        if len(items) < items_per_page:
            break
        page += 1
    else:
        log.warning("mediamtx_pagination_limit_reached", max_pages=_MAX_PAGES)
    return out, any_items_seen


async def _list_known_channels(redis: Redis) -> set[str]:
    """Channel ids that currently have a ``stream:channel:<cid>`` key."""
    out: set[str] = set()
    async for key in redis.scan_iter(match=_CHANNEL_STATE_SCAN_MATCH, count=100):
        key_s = key.decode() if isinstance(key, bytes) else key
        out.add(key_s.rsplit(":", 1)[-1])
    return out


async def _publish_event(
    redis: Redis,
    channel_id: str,
    user_ids: list[str],
    streams: list[dict[str, Any]] | None = None,
) -> None:
    from dcc_shared.events import StreamStateSnapshot

    snapshot = StreamStateSnapshot(channel_id=channel_id, user_ids=user_ids, streams=streams or [])
    data = snapshot.model_dump(mode="json")
    if not snapshot.streams:
        # Single-stream channels keep the legacy {channel_id, user_ids} shape.
        data.pop("streams", None)
    await redis.publish(STREAM_EVENTS_CHANNEL, json.dumps(data, separators=(",", ":")))


def _parse_state(raw: bytes | str | None) -> dict[str, Any] | None:
    """Decode a raw Redis value into a state dict, or None on any error."""
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, TypeError, AttributeError):
        return None
    return data if isinstance(data, dict) else None


def _active_created_after(raw: bytes | str | None, cutoff: datetime) -> bool:
    """True if a ``stream:active`` record's ``started_at`` is at/after ``cutoff``.

    Used by the stale-cleanup to spare a record written by a fresh publish that
    raced in *after* this reconcile pass took its MediaMTX snapshot. A record
    with a missing/unparseable ``started_at`` is treated as old (returns False)
    so genuinely-stale keys still self-heal."""
    state = _parse_state(raw)
    started_at = (state or {}).get("started_at")
    if not isinstance(started_at, str):
        return False
    try:
        started = datetime.fromisoformat(started_at)
    except ValueError:
        return False
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    return started >= cutoff


# Consecutive fully-empty MediaMTX snapshots required before we trust "all
# streams stopped" and tear down the remaining Redis state. A single empty
# snapshot can be a transient MediaMTX blip; but a solo/last streamer stopping
# shows up as a genuinely empty list, so we MUST eventually act on it — just not
# on the first sample. (At a 3s poll interval, grace=2 clears a stopped solo
# stream within ~one extra poll while still filtering single-poll blips.)
_EMPTY_SNAPSHOT_GRACE_POLLS = 2
_empty_snapshot_streak = 0


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
    # Snapshot the pass-start time *before* querying MediaMTX. Any
    # ``stream:active`` record written by the auth-hook after this instant
    # belongs to a brand-new publish that MediaMTX hadn't reported yet (RTMP
    # handshake, pre-keyframe) — the stale-cleanup below must NOT delete it.
    pass_start = datetime.now(UTC)
    publishers, any_items_seen = await _fetch_channel_publishers(client, settings.mediamtx_api_url)

    # Honor explicit-stop suppression (see routes.stop_stream): a user who just
    # clicked "stop" carries a short-lived ``stream:stopping`` tombstone. MediaMTX
    # may still list their path for a few seconds (its disconnect detection lags),
    # but we must NOT re-mark them live — the stop route already published their
    # departure. Drop suppressed (cid,uid) pairs; a channel left empty falls
    # through to the stale-cleanup below (which publishes the empty set).
    if publishers:
        triples = [
            (cid, uid, slot)
            for cid, prs in publishers.items()
            for (uid, slot) in sorted(prs)
        ]
        flags = await redis.mget(*[stopping_key(cid, uid, int(slot)) for cid, uid, slot in triples])
        for (cid, uid, slot), flag in zip(triples, flags):
            if flag is not None:
                publishers[cid].discard((uid, slot))
        publishers = {cid: prs for cid, prs in publishers.items() if prs}

    known = await _list_known_channels(redis)

    # Guard: a fully-empty MediaMTX snapshot (zero paths) while Redis still knows
    # active channels is ambiguous — it could be a transient MediaMTX blip (mid-
    # restart) OR the genuine "last/only streamer just stopped" case (which DOES
    # arrive as an empty list when that publisher held the sole path). Treating
    # the first empty sample as authoritative would wrongly tear down live
    # streams; treating it as always-transient (the previous behaviour) left a
    # stopped solo stream marked "live" forever. So we debounce: skip the first
    # empty sample(s), but once empty persists across the grace window, trust it
    # and let the stale-cleanup below run.
    global _empty_snapshot_streak
    if not publishers and not any_items_seen and known:
        _empty_snapshot_streak += 1
        if _empty_snapshot_streak < _EMPTY_SNAPSHOT_GRACE_POLLS:
            log.warning(
                "mediamtx_empty_snapshot_skipped",
                known_channels=len(known),
                streak=_empty_snapshot_streak,
                grace=_EMPTY_SNAPSHOT_GRACE_POLLS,
                reason="zero paths but Redis knows active channels; treating the "
                "first empty sample as a possible MediaMTX blip",
            )
            return
        log.info(
            "mediamtx_empty_snapshot_confirmed",
            known_channels=len(known),
            streak=_empty_snapshot_streak,
            reason="empty across the grace window — treating as genuine all-stopped",
        )
        _empty_snapshot_streak = 0
        # fall through → stale-cleanup tears the now-dead channels down
    else:
        _empty_snapshot_streak = 0

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

    # --- Read per-stream labels (set by the auth-hook on publish-auth) ----
    # The poller attributes streams from the MediaMTX *path* (carrying only
    # cid/uid/slot), so the human-readable label needs a second lookup: one MGET
    # over every publisher's ``stream:active`` record. Absent/empty → no label
    # (legacy clients fall back to a generic "Stream N" in the picker).
    label_of: dict[tuple[str, str, str], str] = {}
    all_pairs = [(cid, uid, slot) for cid, prs in publishers.items() for (uid, slot) in prs]
    if all_pairs:
        avals = await redis.mget(*[active_key(cid, uid, int(slot)) for cid, uid, slot in all_pairs])
        for (cid, uid, slot), raw in zip(all_pairs, avals):
            state = _parse_state(raw)
            label = (state or {}).get("label")
            if isinstance(label, str) and label:
                label_of[(cid, uid, slot)] = label

    # --- Compute changes, then flush writes in one pipeline ---------------
    ttl = settings.channel_state_ttl_s
    async with redis.pipeline(transaction=False) as pipe:
        # (cid, new_uids, streams|None) for PUBLISH — streams only when multi.
        changed: list[tuple[str, list[str], list[dict[str, Any]] | None]] = []
        for cid, prs in publishers.items():
            new_uids = _user_ids(prs)
            multi = _is_multi(prs)
            prev = prev_states.get(cid)
            prev_pairs = _pairs_from_state(prev) if prev else set()
            if prev is not None and prev_pairs == prs:
                pipe.expire(CHANNEL_STATE_KEY.format(channel_id=cid), ttl)
                for uid, slot in prs:
                    pipe.expire(active_key(cid, uid, int(slot)), ttl)
                continue
            # Carry `since` forward only if at least one user from the previous
            # set is still present; if the entire set turned over, reset to now
            # so the UI doesn't show the new streamer as having started during
            # the old session.
            prev_uids = {uid for uid, _slot in prev_pairs}
            carry_since = bool(prev and prev_uids & set(new_uids))
            since = (prev or {}).get("since") if carry_since else None
            new_state: dict[str, Any] = {
                "user_ids": new_uids,
                "since": since or datetime.now(UTC).isoformat(),
            }
            # ``streams`` is additive — only when a user runs slot ≥ 1, so a
            # single-stream channel keeps the legacy {user_ids, since} record.
            if multi:
                new_state["streams"] = _stream_descriptors(prs, cid, label_of)
            pipe.set(
                CHANNEL_STATE_KEY.format(channel_id=cid),
                json.dumps(new_state, separators=(",", ":")),
                ex=ttl,
            )
            for uid, slot in prs:
                pipe.expire(active_key(cid, uid, int(slot)), ttl)
            # Clean up stream:active keys for (user, slot) pairs that left this
            # channel while at least one other stream stays (partial-departure).
            # The full-channel-gone path is handled below in the stale-channel
            # self-heal; here we only touch pairs no longer present.
            for uid, slot in prev_pairs - prs:
                pipe.delete(active_key(cid, uid, int(slot)))
            changed.append((cid, new_uids, new_state.get("streams")))
        await pipe.execute()

    # Publish change events after the pipeline flush (outside the pipeline so
    # subscribers see the new state already written).
    await asyncio.gather(
        *[_publish_event(redis, cid, new_uids, streams) for cid, new_uids, streams in changed]
    )
    for cid, new_uids, _streams in changed:
        log.info("stream_state_change", channel_id=cid, user_ids=new_uids)

    # --- Self-heal: channels no longer reported by MediaMTX ---------------
    stale = known - set(publishers)
    if stale:
        async with redis.pipeline(transaction=False) as pipe:
            for cid in stale:
                pipe.delete(CHANNEL_STATE_KEY.format(channel_id=cid))
            await pipe.execute()
        # Also remove any stream:active:channel-<cid>-<uid> keys that linger
        # after the publisher disconnected — otherwise get_whep_url returns 200
        # with a stale path for a dead stream until the 6h TTL expires.
        # TOCTOU guard: a new publisher can authenticate (auth-hook writes a
        # fresh stream:active) in the window between our MediaMTX snapshot and
        # this scan, before MediaMTX reports the path as ready. Skip deleting any
        # record whose started_at is at/after this pass's start — that record
        # belongs to a live, brand-new session, not a dead one.
        for cid in stale:
            pattern = f"stream:active:channel-{cid}-*"
            active_keys = [k async for k in redis.scan_iter(match=pattern, count=100)]
            if not active_keys:
                continue
            values = await redis.mget(*active_keys)
            to_delete = [
                k
                for k, raw in zip(active_keys, values, strict=False)
                if not _active_created_after(raw, pass_start)
            ]
            if to_delete:
                await redis.delete(*to_delete)
        await asyncio.gather(*[_publish_event(redis, cid, []) for cid in stale])
        for cid in stale:
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
