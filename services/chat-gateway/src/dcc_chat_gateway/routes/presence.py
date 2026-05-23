"""REST route: PUT /me/presence-status

Lets a client explicitly set their own presence status to one of:
  online | idle | dnd | invisible

The status is persisted in Redis (TTL 24 h) and broadcast to the
appropriate audiences via ``broadcast_presence_status_changed``.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from dcc_chat_gateway.presence_status import (
    VALID_SET_STATUSES,
    broadcast_presence_status_changed,
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
    await broadcast_presence_status_changed(manager, redis, user_id, status)
