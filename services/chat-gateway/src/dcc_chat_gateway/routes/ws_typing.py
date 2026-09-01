"""WS ``typing`` op — ephemeral "user is typing" signal.

Extracted out of ``ws_ops_handlers.py`` (Groessen-Policy, PLAN.md §12.1),
same pattern as ``ws_device_handlers.py`` / ``ws_remote_handlers.py``: a thin
``@register_ws_op`` wrapper stays in ``ws_ops_handlers.py``, the actual logic
lives here.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.friend_helpers import block_exists_either_way
from dcc_chat_gateway.models import DirectMessageChannel
from dcc_chat_gateway.routes._deps import parse_snowflake_int as _channel_id

if TYPE_CHECKING:
    from dcc_chat_gateway.routes.ws_ops_registry import WSOpContext

log = logging.getLogger(__name__)

# Server-side backstop throttle for the typing indicator. The frontend already
# debounces to ~once/3s; this guards against a misbehaving/malicious client
# flooding the channel fan-out. Per-connection state (``ctx.last_typing``) so
# it's freed on disconnect.
_TYPING_THROTTLE_S = 2.0


def _session_factory(mgr: object):
    """Die Sitzungsquelle des ConnectionManagers, nicht das Modul-``SessionLocal``.

    Steht so in CLAUDE.md und ist kein Stilgeschmack: die ws_app-Tests patchen
    die Speicher-Datenbank am Manager. Wer ``SessionLocal`` direkt importiert,
    sieht dort die ungepatchte Datenbank — im Testlauf als "no such table",
    in Produktion gar nicht, weil beide dasselbe Objekt sind. Gleiches Muster
    wie ``ws_device_handlers.py``.
    """
    return getattr(mgr, "_session_factory", None) or SessionLocal


async def handle_typing(ctx: "WSOpContext", msg: dict[str, Any]) -> None:
    """Ephemeral "user is typing" signal for a text channel / DM.

    Broadcasts ``{op: "typing", channel_id, user_id}`` to the channel's
    subscribers and returns — no persistence, no reply, no web-push. Only fires
    for channels this socket is *subscribed* to: ``subscribe`` already enforced
    VIEW_CHANNEL for guild text channels (and DM membership), and
    ``manager.publish`` re-applies the view-channel filter at delivery, so no
    extra permission lookup is needed for guild channels. DMs are unfiltered
    by ``manager.publish`` (by design — see ``_filter_by_view_channel``), so
    the block-gate has to sit here: without it a blocked user's live typing
    activity stayed visible even though a sent message would have been
    rejected outright (mirrors the block-gate on the ``send`` op / REST
    ``POST /channels/{id}/messages``). The sender receives its own echo
    (cheap) and the client ignores its own ``user_id``.
    """
    cid_int = _channel_id(msg.get("channel_id"))
    if cid_int is None:
        return
    cid = str(cid_int)
    if cid not in ctx.subscribed:
        return  # not viewing this channel — nothing to announce
    now = time.monotonic()
    if now - ctx.last_typing.get(cid, 0.0) < _TYPING_THROTTLE_S:
        return
    # Set the throttle stamp before the (possibly early-returning) block
    # check below, so a blocked sender's repeated typing events stay
    # throttled to the same cadence instead of hitting the DB every time.
    ctx.last_typing[cid] = now
    if ctx.subscribed[cid] is None:
        # ``subscribed`` maps DM channels to ``None`` — see WSOpContext.
        # Resolve the other party and skip silently if either side blocked.
        async with _session_factory(ctx.manager)() as session:
            dm = await session.get(DirectMessageChannel, cid_int)
            if dm is None:
                return
            other = dm.user_b_id if dm.user_a_id == ctx.user.id else dm.user_a_id
            if await block_exists_either_way(session, ctx.user.id, other):
                return
    try:
        await ctx.manager.publish(
            cid,
            {"op": "typing", "channel_id": cid, "user_id": str(ctx.user.id)},
        )
    except Exception:  # noqa: BLE001
        log.exception("typing publish failed for channel %s", cid)
