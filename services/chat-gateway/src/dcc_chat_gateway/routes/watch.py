"""Watch-Party re-sync endpoint.

Watch parties are otherwise WS-driven (start/stop/control/heartbeat ops in
``ws_watch.py``); this REST endpoint is the equivalent of
``GET /guilds/{id}/stream-state`` and ``/voice-state`` — a way for a client
to catch up on every active party in a guild after a reconnect without
waiting for the next push.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


@router.get("/guilds/{guild_id}/watch-state")
async def guild_watch_state(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> dict[str, list[dict[str, Any]]]:
    """Channels in the guild that currently have an active watch party.

    Returns ``{"watch_states": [{"channel_id": "<id>", "state": {...}}, ...]}``
    — only channels with an active party are listed. Read straight off Redis
    (``watch:channel-*``), same shape as the WS ``ready`` payload.
    """
    await require_member(session, guild_id, current.id)
    stmt = select(Channel.id).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
    )
    channel_ids = [str(cid) for cid in (await session.execute(stmt)).scalars()]
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return {"watch_states": []}
    return {"watch_states": await mgr.watch_states_for(channel_ids)}
