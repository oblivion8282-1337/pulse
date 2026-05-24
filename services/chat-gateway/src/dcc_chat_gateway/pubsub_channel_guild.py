"""Guild-events pub/sub handler (Plugin-System Schritt 2).

Lifted out of :mod:`pubsub_channel_handlers` to keep the per-channel
handler file under the 350-line policy. ``guild:events`` is the busiest
branch — it ships member-scoped fan-out, two distinct presence filters,
and the ``channel_bump`` VIEW gate. Each sub-op is verbatim from the
pre-split listener.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from dcc_chat_gateway.pubsub_channel_registry import register_channel_handler
from dcc_chat_gateway.pubsub_channels import GUILD_EVENTS_CHANNEL
from dcc_chat_gateway.pubsub_event_validation import maybe_drop

if TYPE_CHECKING:
    from dcc_chat_gateway.pubsub import ConnectionManager

log = logging.getLogger(__name__)


def _filter_presence_for_sender(
    manager: "ConnectionManager",
    targets: list,
    sender_uid: int,
) -> list:
    """Strip the sender's own sockets, then apply the block-aware
    visibility filter.

    Shared by ``presence_update`` and ``presence_status_changed`` — both
    have the same delivery rule. Returns the trimmed target list.
    """
    targets = [
        ws for ws in targets
        if (u := manager._ws_user.get(ws)) is None or u.id != sender_uid
    ]
    target_uids = {
        u.id for ws in targets
        if (u := manager._ws_user.get(ws)) is not None
    }
    visible = manager._filter_presence_visibility(target_uids, sender_uid)
    if visible != target_uids:
        targets = [
            ws for ws in targets
            if (u := manager._ws_user.get(ws)) is not None
            and u.id in visible
        ]
    return targets


@register_channel_handler(GUILD_EVENTS_CHANNEL)
async def handle_guild_events(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    payload = manager._decode_payload(msg["data"], GUILD_EVENTS_CHANNEL)
    if not isinstance(payload, dict) or "op" not in payload:
        log.warning("guild:events malformed or missing op: %r", payload)
        return
    # Schema validation runs BEFORE the membership-update + invalidation
    # side effects so a malformed event in strict mode never mutates the
    # per-socket caches. ``presence_status_changed`` carries an alias
    # ``_sender_user_id`` that the model knows about (via Field(alias=…)),
    # so validation works at this point — the pop() below is only for
    # downstream code that wants the value out of the dict.
    if maybe_drop(payload["op"], payload, GUILD_EVENTS_CHANNEL):
        return
    manager._apply_guild_membership_update(payload)
    manager._maybe_invalidate(payload)
    async with manager._lock:
        targets = list(manager._connections)
    # Per-guild events (bans, member adds/removes/updates, channel_bump)
    # are scoped to actual guild members rather than blasted to every
    # connected socket. Other ops keep the wide broadcast pattern they
    # were built on.
    targets = manager._filter_targets_by_guild(payload, targets)
    op = payload.get("op")
    # ``presence_update`` is broadcast to *every* connected socket so
    # clients learn about online/offline transitions in any guild they
    # share — but we never deliver the event for our OWN user to OUR
    # sockets (semantically meaningless + races the ready frame). The
    # block-aware visibility filter then makes sure a blocker / blocked
    # party doesn't see the other's status transitions. Friend-only /
    # shared-guild gating stays purely client-side (the FE filters by
    # ``visible_member_ids``); this filter only blocks the hard cut.
    if op == "presence_update":
        try:
            self_uid = int(payload.get("user_id", "0"))
        except (TypeError, ValueError):
            self_uid = 0
        if self_uid:
            targets = _filter_presence_for_sender(manager, targets, self_uid)
    # ``presence_status_changed`` (Etappe 3) is published on guild:events
    # by the REST route + idle sweeper. The envelope carries
    # ``_sender_user_id`` so we can strip the sender's own sockets (they
    # already received the real status via USER_EVENTS_CHANNEL) and
    # apply the same block-aware filter. The status value has already
    # been masked (invisible → offline) by the publisher.
    elif op == "presence_status_changed":
        sender_raw = payload.pop("_sender_user_id", None)
        try:
            sender_uid = int(sender_raw) if sender_raw else 0
        except (TypeError, ValueError):
            sender_uid = 0
        if sender_uid:
            targets = _filter_presence_for_sender(manager, targets, sender_uid)
    # ``channel_bump`` carries no body but still flags a channel as
    # unread + plays a ping sound. On top of the guild-member scoping
    # above, gate it on VIEW_CHANNEL so a member without access to a
    # private channel isn't pinged for it. ``dm_bump`` deliberately
    # stays wide — DM channels have no permission overlay; the client
    # filters by membership.
    elif op == "channel_bump":
        targets = await manager._filter_by_view_channel(
            targets, str(payload.get("channel_id", ""))
        )
    log.info("guild:events broadcast op=%s targets=%d", op, len(targets))
    await manager._fan_out(targets, payload)
