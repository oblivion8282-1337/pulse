"""REST route: PUT /me/presence-status

Lets a client explicitly set their own presence status to one of:
  online | idle | dnd | invisible

The status is written to Redis (live, TTL 24 h), mirrored durably into
``user_preferences`` (so it survives the TTL / a restart and is restored
at next login), and broadcast to the appropriate audiences via
``broadcast_presence_status_changed``.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.presence_status import (
    broadcast_presence_status_changed,
    persist_durable_status,
    set_presence_status,
)
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()


class PresenceStatusBody(BaseModel):
    status: Literal["online", "idle", "dnd", "invisible"]


@router.put("/me/presence-status", status_code=204)
async def set_my_presence_status(
    body: PresenceStatusBody,
    request: Request,
    session: SessionDep,
    current: CurrentUser,
) -> None:
    """Set the caller's presence status.

    Persists to Redis and broadcasts ``presence_status_changed`` to:
    * the caller's own sockets (real status)
    * everyone else via guild:events (masked: invisible → offline)
    """
    redis = request.app.state.redis
    manager = request.app.state.connection_manager

    await set_presence_status(redis, current.id, body.status)
    # Mirror the explicit choice durably so it outlives the 24 h Redis TTL
    # and is restored on the next login (see ws_ready's own-status fallback).
    await persist_durable_status(session, current.id, body.status)
    await broadcast_presence_status_changed(manager, redis, current.id, body.status)
