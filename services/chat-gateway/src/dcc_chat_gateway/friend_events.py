"""WS-Event-Helpers für das Voll-Discord-Freundschaftssystem (Etappe 2).

Die Friend/Block/Privacy-Routes publishen Lifecycle-Events über den
``USER_EVENTS_CHANNEL`` (siehe ``pubsub.py``) — direct-delivery an einen
oder beide betroffenen User. Dieses Modul kapselt:

  * den Fan-out-Helper ``publish_friend_event`` (kennt Manager-Lookup über
    Request + Best-Effort-Logging),
  * Hydration-Queries für die per-Socket-Caches in ``ConnectionManager``
    (``load_blocks_out``, ``load_blocks_in``, ``load_friends``),
  * eine kompakte ``check_blocks`` Query, die zwei User-IDs in einem
    Round-Trip auf jede Block-Richtung prüft (für den Mention-Fan-out
    Block-Filter, ohne den Per-Socket-Cache zu erzwingen — er greift nur
    wenn der Empfänger online ist).

Lebt außerhalb von ``friend_helpers.py``, weil das ein REST-Datei-Helper
ist (keine Manager-Awareness) — Trennung der Belange.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from dcc_chat_gateway.models import Friendship, UserBlock

log = logging.getLogger(__name__)


# ---- Event publishers ------------------------------------------------------


async def publish_friend_event(
    conn_or_manager: Any,
    *,
    target_user_id: int | str,
    op: str,
    data: dict[str, Any] | None = None,
) -> None:
    """Direct-deliver ``{op, ...data}`` to ``target_user_id``'s sockets.

    ``conn_or_manager`` may be either a Starlette ``Request``/``HTTPConnection``
    or a ConnectionManager instance — the routes pass the request, tests can
    pass the manager directly. Best-effort: failures are logged but never
    raised so a dead Redis can't break the REST contract (the DB write has
    already committed by the time we get here).

    Wire shape mirrors ``mention_added``: ``{"op": "...", "data": {...}}``.
    """
    mgr = _resolve_manager(conn_or_manager)
    if mgr is None:
        return
    envelope: dict[str, Any] = {"op": op}
    if data is not None:
        envelope["data"] = data
    try:
        await mgr.publish_user_event(target_user_id, envelope)
    except Exception:  # noqa: BLE001 — best-effort fan-out
        log.exception("publish_friend_event(%s) failed for user=%s", op, target_user_id)


def _resolve_manager(thing: Any) -> Any | None:
    """Accept either a ``Request``/``HTTPConnection`` or a manager directly."""
    if thing is None:
        return None
    # Manager has publish_user_event; Request exposes app.state.connection_manager.
    if hasattr(thing, "publish_user_event"):
        return thing
    app = getattr(thing, "app", None)
    if app is None:
        return None
    return getattr(app.state, "connection_manager", None)


# ---- Cache-hydration queries ----------------------------------------------


async def load_blocks_out(session: AsyncSession, user_id: int) -> set[int]:
    """User-ids that ``user_id`` has blocked (outgoing)."""
    rows = await session.execute(
        select(UserBlock.blocked_id).where(UserBlock.blocker_id == user_id)
    )
    return {r[0] for r in rows.all()}


async def load_blocks_in(session: AsyncSession, user_id: int) -> set[int]:
    """User-ids that have blocked ``user_id`` (incoming — who blocked me)."""
    rows = await session.execute(
        select(UserBlock.blocker_id).where(UserBlock.blocked_id == user_id)
    )
    return {r[0] for r in rows.all()}


async def load_friends(session: AsyncSession, user_id: int) -> set[int]:
    """User-ids of ``user_id``'s confirmed friends. Returns the *other*
    party for every sorted-pair friendship row."""
    rows = await session.execute(
        select(Friendship.user_a_id, Friendship.user_b_id).where(
            or_(
                Friendship.user_a_id == user_id,
                Friendship.user_b_id == user_id,
            )
        )
    )
    out: set[int] = set()
    for a, b in rows.all():
        out.add(b if a == user_id else a)
    return out


async def is_blocked_between(
    session: AsyncSession, a: int, b: int
) -> bool:
    """True if either user has blocked the other. Same semantics as
    ``friend_helpers.block_exists_either_way``, kept here so callers can
    avoid the routes/helpers import cycle when chaining a fan-out check."""
    row = await session.execute(
        select(UserBlock.blocker_id).where(
            or_(
                and_(UserBlock.blocker_id == a, UserBlock.blocked_id == b),
                and_(UserBlock.blocker_id == b, UserBlock.blocked_id == a),
            )
        )
    )
    return row.first() is not None


__all__ = [
    "is_blocked_between",
    "load_blocks_in",
    "load_blocks_out",
    "load_friends",
    "publish_friend_event",
]
