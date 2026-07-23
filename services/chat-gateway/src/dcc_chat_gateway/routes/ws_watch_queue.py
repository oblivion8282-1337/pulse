"""WebSocket op handlers for the watch-party queue.

Split out from ``routes/ws_watch.py`` to keep both files under the size policy.
Shares that module's small payload/response helpers (``_channel_id`` etc.) —
the queue ops sit on the same party state and speak the same error frames.

Ownership + host gates for the mutations live atomically in
``watchkeys.queue_*`` (WATCH/MULTI); these handlers only validate the payload,
do the membership/permission checks that need the DB (add), and translate the
mutation result into an error frame via :func:`_queue_result`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

from dcc_chat_gateway import watchkeys
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE
from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.routes.ws_watch import _channel_id, _err, _party_id, _redis
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.snowflake import next_id
from dcc_chat_gateway.watch_source import parse_source


async def _queue_result(websocket: WebSocket, result: object) -> None:
    """Map a ``watchkeys.queue_*`` result to an error frame (or nothing).

    A dict is the new state — the mutation already published it, no reply
    needed. ``EMPTY`` (auto-advance past the last video) and ``CONTENDED`` (lost
    the optimistic race, vanishingly rare) stay silent — the party just stays
    put and the user can retry."""
    mapping = {
        None: (4016, "no active watch party"),
        "FORBIDDEN": (4015, "not allowed"),
        "FULL": (4018, "queue is full"),
        "NOTFOUND": (4019, "queue item not found"),
    }
    # A dict result is unhashable, so guard the lookup by type: only None and
    # the error-code strings map to a frame; everything else stays silent.
    entry = mapping.get(result) if isinstance(result, (str, type(None))) else None
    if entry is not None:
        await _err(websocket, *entry)


def _queue_position(value: object) -> int | None:
    """Non-negative int index, or None if malformed."""
    try:
        idx = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return idx if idx >= 0 else None


async def handle_queue_add(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
    *,
    session_factory: Callable,
) -> None:
    """Anyone in the channel enqueues the next video. Same source validation +
    membership/VIEW gate as :func:`ws_watch.handle_start`; native URLs still need
    MANAGE_CHANNELS (SSRF). The host moderates order + removal afterwards."""
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    source_url = msg.get("source_url")
    if cid_int is None or pid is None or not isinstance(source_url, str):
        await _err(websocket, 4012, "invalid watch_queue_add payload")
        return
    source = parse_source(source_url)
    if source is None:
        await _err(websocket, 4013, "unsupported source")
        return
    cid = str(cid_int)
    async with session_factory() as session:
        channel = await channel_membership(session, cid_int, user.id)
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            await _err(websocket, 4004, "channel not accessible")
            return
        perms = await resolve_permissions(session, user, channel.guild_id, cid_int)
        if not has_permission(perms, Permissions.VIEW_CHANNEL):
            await _err(websocket, 4004, "channel not accessible")
            return
        if source.get("type") == "native" and not has_permission(
            perms, Permissions.MANAGE_CHANNELS
        ):
            await _err(websocket, 4003, "missing permission: MANAGE_CHANNELS")
            return
    redis = _redis(websocket)
    if redis is None:
        await _err(websocket, 4017, "watch service unavailable")
        return
    item = {
        "id": str(next_id()),
        "source": source,
        "submitted_by": str(user.id),
        "submitted_at": watchkeys.now_ms(),
    }
    await _queue_result(websocket, await watchkeys.queue_add(redis, cid, pid, item))


async def handle_queue_remove(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    """Drop a queued item. Host (moderation) or the submitter; the ownership
    check is atomic inside :func:`watchkeys.queue_remove`."""
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    qid = _party_id(msg.get("item_id"))
    if cid_int is None or pid is None or qid is None:
        await _err(websocket, 4012, "invalid watch_queue_remove payload")
        return
    redis = _redis(websocket)
    if redis is None:
        return
    result = await watchkeys.queue_remove(redis, str(cid_int), pid, qid, str(user.id))
    await _queue_result(websocket, result)


async def handle_queue_move(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    """Reorder a queued item (host only, enforced in the mutation)."""
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    qid = _party_id(msg.get("item_id"))
    new_index = _queue_position(msg.get("index"))
    if cid_int is None or pid is None or qid is None or new_index is None:
        await _err(websocket, 4012, "invalid watch_queue_move payload")
        return
    redis = _redis(websocket)
    if redis is None:
        return
    result = await watchkeys.queue_move(
        redis, str(cid_int), pid, qid, new_index, str(user.id)
    )
    await _queue_result(websocket, result)


async def handle_queue_advance(
    websocket: WebSocket,
    user: AuthenticatedUser,
    msg: dict[str, Any],
) -> None:
    """Promote a queued item to the live source (host only). Empty ``item_id``
    = the first item (auto-advance when the current video ends); a specific id
    = play it now, skipping ahead. If the queue is empty the party stays put."""
    cid_int = _channel_id(msg.get("channel_id"))
    pid = _party_id(msg.get("party_id"))
    # item_id is optional: absent/empty → advance to the first queued item; a
    # present-but-malformed id is a bad payload, not an implicit auto-advance.
    raw_qid = msg.get("item_id")
    if raw_qid in (None, ""):
        qid = ""
    else:
        qid = _party_id(raw_qid)
    if cid_int is None or pid is None or qid is None:
        await _err(websocket, 4012, "invalid watch_queue_advance payload")
        return
    redis = _redis(websocket)
    if redis is None:
        return
    result = await watchkeys.queue_advance(redis, str(cid_int), pid, str(user.id), qid)
    await _queue_result(websocket, result)
