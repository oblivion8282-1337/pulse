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

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.presence_status import (
    VALID_SET_STATUSES,
    broadcast_presence_status_changed,
    persist_durable_status,
    set_presence_status,
)
from dcc_chat_gateway.security import decode_token

router = APIRouter()


class PresenceStatusBody(BaseModel):
    status: Literal["online", "idle", "dnd", "invisible"]


@router.put("/me/presence-status", status_code=204)
async def set_my_presence_status(
    body: PresenceStatusBody,
    request: Request,
    session: SessionDep,
) -> None:
    """Set the caller's presence status.

    Persists to Redis and broadcasts ``presence_status_changed`` to:
    * the caller's own sockets (real status)
    * everyone else via guild:events (masked: invisible → offline)
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = auth_header.removeprefix("Bearer ")
    try:
        payload = await decode_token(token)
        user_id = int(payload["sub"])
    except (HTTPException, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="unauthorized")

    status = body.status
    if status not in VALID_SET_STATUSES:
        raise HTTPException(status_code=422, detail="invalid status")

    redis = request.app.state.redis
    manager = request.app.state.connection_manager

    await set_presence_status(redis, user_id, status)
    # Mirror the explicit choice durably so it outlives the 24 h Redis TTL
    # and is restored on the next login (see ws_ready's own-status fallback).
    await persist_durable_status(session, user_id, status)
    await broadcast_presence_status_changed(manager, redis, user_id, status)
