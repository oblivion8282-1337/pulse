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
    async with manager._lock:
        targets = list(manager._connections)
    # Per-guild events (bans, member adds/removes/updates, channel_bump)
    # are scoped to actual guild members rather than blasted to every
    # connected socket. Other ops keep the wide broadcast pattern they
    # were built on.
    #
    # The guild-member filter MUST run BEFORE _apply_guild_membership_update:
    # on ``guild_member_removed`` the update drops the kicked user's guild
    # from their ``_ws_guilds`` set, so filtering afterwards would exclude
    # the kicked user from their own removal event (they'd keep seeing the
    # guild until reconnect). Computing targets first keeps them in scope so
    # the client can run its drop-guild cleanup; the prune + cache
    # invalidation then run below, before fan-out.
    targets = manager._filter_targets_by_guild(payload, targets)
    manager._apply_guild_membership_update(payload)
    manager._maybe_invalidate(payload)
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
    # private channel isn't pinged for it.
    elif op == "channel_bump":
        targets = await manager._filter_by_view_channel(
            targets, str(payload.get("channel_id", ""))
        )
    # **Die Kanal-Ereignisse selbst — dieselbe Sicht-Schranke.** Sie waren bis
    # 2026-08-13 nur nach Guild-Mitgliedschaft gefiltert, gingen also auch an
    # Mitglieder, denen der Kanal ausdruecklich verborgen ist. Bei
    # ``channel_permissions_updated`` wiegt das am schwersten: das Ereignis
    # traegt die VOLLSTAENDIGE Ausnahmeliste, also genau, wer den privaten
    # Kanal sehen darf. An anderer Stelle versteckt das Programm dessen blosse
    # Existenz ausdruecklich (ein verbotener Kanal antwortet 404 statt 403) —
    # ueber diesen Nebenkanal war das ausgehebelt.
    #
    # ``channel_deleted`` bleibt BEWUSST ungefiltert: den Kanal gibt es dann
    # nicht mehr, ``_resolve_channel_perms`` loest ihn auf 0 auf, und der
    # Filter wuerde JEDEN Empfaenger verwerfen — auch die, die ihn sehen
    # durften und ihn jetzt aus ihrer Liste nehmen muessen. Das Ereignis traegt
    # ohnehin nur die Kennung, keine Inhalte.
    elif op in ("channel_created", "channel_updated"):
        cid = str((payload.get("channel") or {}).get("id", ""))
        if cid:
            targets = await manager._filter_by_view_channel(targets, cid)
    # ``channel_permissions_updated`` bleibt bewusst UNGEFILTERT, obwohl es die
    # vollstaendige Ausnahmeliste traegt — s.
    # `docs/plans/2026-08-13-kanal-ereignisse-sichtschranke.md`. Kurz: der
    # Client leitet AUS DIESER LISTE ab, dass er den Zugriff gerade verloren
    # hat (`channels.ts::channel_permissions_updated` → `channelPermissions
    # .apply`). Wer sie ihm vorenthaelt, schliesst das Leck und laesst ihm
    # denselben Kanal in der Seitenleiste stehen. Die saubere Loesung ist ein
    # eigenes „du siehst ihn nicht mehr"-Ereignis (`ChannelHiddenEvent` gibt es
    # bereits fuer den Sprachkanal-Fall) — ein groesserer Eingriff, der die
    # Seitenleiste aller Nutzer beruehrt.
    # Dropbox events carry entry payloads (incl. presigned GET URLs
    # for files) — same VIEW_CHANNEL gate as ``channel_bump`` so a
    # member without ``@everyone`` access to the dropbox channel
    # can't sniff the URL out of their WS stream. The dropbox
    # channel id lives inside the ``entry`` sub-dict for entry
    # events and on the top-level event for the quota event.
    elif op in (
        "dropbox_entry_created",
        "dropbox_entry_updated",
        "dropbox_entry_deleted",
        "dropbox_entry_restored",
        "dropbox_entry_purged",
        "dropbox_quota_updated",
    ):
        cid = (
            str(payload.get("entry", {}).get("channel_id", ""))
            if op != "dropbox_quota_updated"
            else str(payload.get("channel_id", ""))
        )
        if cid:
            targets = await manager._filter_by_view_channel(targets, cid)
    # ``dm_bump`` must only reach the two DM participants — broadcasting it to
    # all connected sockets would leak DM relationship metadata to unrelated
    # users (finding 25).  DMs have no guild-member scoping (the fan-out above
    # keeps all sockets at this point), so we do the narrowing here.
    elif op == "dm_bump":
        try:
            a_id = int(payload.get("user_a_id", "0"))
            b_id = int(payload.get("user_b_id", "0"))
        except (TypeError, ValueError):
            a_id = b_id = 0
        if not (a_id and b_id):
            # Malformed or missing IDs — drop rather than broadcast to all
            return
        targets = [
            ws for ws in targets
            if (u := manager._ws_user.get(ws)) is not None
            and u.id in (a_id, b_id)
        ]
    # ``report_new`` was pre-narrowed to guild members by
    # _filter_targets_by_guild above; narrow further to the guild's
    # moderators so a plain member can't learn a report exists.
    elif op == "report_new":
        targets = await manager._filter_by_moderator(
            targets, str(payload.get("guild_id", ""))
        )
    log.info("guild:events broadcast op=%s targets=%d", op, len(targets))
    await manager._fan_out(targets, payload)
