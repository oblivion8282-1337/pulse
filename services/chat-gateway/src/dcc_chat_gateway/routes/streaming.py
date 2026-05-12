"""HQ-streaming proxy + re-sync endpoints (T5b).

chat-gateway is the membership-gated front door for media-svc:
  * ``POST /channels/{channel_id}/stream-token`` — checks the caller is a
    member of the channel's guild (and that it is a voice channel), then
    forwards the caller's Pulse access token to media-svc, which mints the
    short-lived publish token. The response is returned to the client mostly
    verbatim.
  * ``GET /channels/{channel_id}/whep`` — same membership check, proxies
    media-svc's WHEP playback URL.
  * ``GET /guilds/{guild_id}/stream-state`` — re-sync endpoint, mirrors
    ``GET /guilds/{guild_id}/voice-state``: the channels in the guild that
    currently have an active HQ stream, read straight off Redis
    (``stream:channel:*``).

The actual token logic lives in media-svc — this module never invents tokens.
"""

from __future__ import annotations

import logging
from typing import Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.routes._deps import channel_membership, require_member
from dcc_chat_gateway.security import CurrentUser

log = logging.getLogger(__name__)

router = APIRouter()


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol: Annotated[str, Field(default="rtmp", pattern=r"^(rtmp|srt)$")] = "rtmp"


class StreamTokenOut(BaseModel):
    token: str
    mediamtx_path: str
    push_protocol: str
    push_url: str
    expires_in_s: int


class WhepOut(BaseModel):
    whep_url: str


# --- media-svc client (thin; tests monkeypatch these two) -------------------


async def _media_svc_request(
    method: str, path: str, *, bearer: str, json_body: dict | None = None
) -> httpx.Response:
    """Call media-svc, forwarding the user's bearer token. Raises on transport
    errors; the route maps those to 502/503."""
    settings = get_settings()
    url = settings.media_svc_url.rstrip("/") + path
    async with httpx.AsyncClient(timeout=settings.media_svc_timeout_s) as http:
        return await http.request(
            method, url, headers={"Authorization": f"Bearer {bearer}"}, json=json_body
        )


def _bearer_from_header(authorization: str | None) -> str:
    # `CurrentUser` already validated the header; this is just to recover the
    # raw token so we can forward it to media-svc.
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    return authorization.split(" ", 1)[1].strip()


async def _require_voice_channel_member(
    session: SessionDep, channel_id: int, user_id: int
) -> Channel:
    channel = await channel_membership(session, channel_id, user_id)
    if channel is None:
        # Either the channel doesn't exist or the user isn't a member of its
        # guild. Distinguish so the client gets a meaningful status.
        if await session.get(Channel, channel_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this channel")
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="HQ streaming is only available in voice channels"
        )
    return channel


def _media_svc_unavailable(exc: Exception) -> HTTPException:
    log.warning("media-svc request failed: %s", exc)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, detail="media service unavailable")


@router.post("/channels/{channel_id}/stream-token", response_model=StreamTokenOut)
async def issue_stream_token(
    channel_id: int,
    payload: StreamTokenIn,
    session: SessionDep,
    current: CurrentUser,
    authorization: Annotated[str | None, Header()] = None,
) -> StreamTokenOut:
    await _require_voice_channel_member(session, channel_id, current.id)
    bearer = _bearer_from_header(authorization)
    try:
        resp = await _media_svc_request(
            "POST",
            f"/channels/{channel_id}/stream-token",
            bearer=bearer,
            json_body={"protocol": payload.protocol},
        )
    except httpx.HTTPError as exc:
        raise _media_svc_unavailable(exc) from exc
    if resp.status_code >= 400:
        # Surface media-svc's status (e.g. 401 if the token was somehow
        # rejected there) rather than masking it as a 500.
        raise HTTPException(resp.status_code, detail="media service rejected the request")
    return StreamTokenOut.model_validate(resp.json())


@router.get("/channels/{channel_id}/whep", response_model=WhepOut)
async def get_whep_url(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    authorization: Annotated[str | None, Header()] = None,
) -> WhepOut:
    await _require_voice_channel_member(session, channel_id, current.id)
    bearer = _bearer_from_header(authorization)
    try:
        resp = await _media_svc_request("GET", f"/channels/{channel_id}/whep", bearer=bearer)
    except httpx.HTTPError as exc:
        raise _media_svc_unavailable(exc) from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, detail="media service rejected the request")
    return WhepOut.model_validate(resp.json())


@router.get("/guilds/{guild_id}/stream-state")
async def guild_stream_state(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> dict[str, list[dict[str, object]]]:
    """Channels in the guild that currently have an active HQ stream.

    Returns ``{"stream_states": [{"channel_id": "<id>", "user_id": "<id>"|null},
    ...]}`` — only active streams are listed. Mirrors ``GET /guilds/{id}/voice-state``;
    lets a client re-sync after a reconnect without waiting for the next push.
    Read straight off Redis (``stream:channel:*``), the same way voice presence
    is read off ``voice:room:*``.
    """
    await require_member(session, guild_id, current.id)
    stmt = select(Channel.id).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
    )
    channel_ids = [str(cid) for cid in (await session.execute(stmt)).scalars()]
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return {"stream_states": []}
    return {"stream_states": await mgr.stream_states_for(channel_ids)}
