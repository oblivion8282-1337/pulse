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
from fastapi import APIRouter, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import channel_membership, require_member
from dcc_chat_gateway.security import CurrentUser

log = logging.getLogger(__name__)

router = APIRouter()

# Highest per-user stream slot — kept in sync with media-svc's _SLOT_MAX. A
# user may run slots 0.._SLOT_MAX concurrently (e.g. two monitors).
_SLOT_MAX = 1
SlotQuery = Annotated[int, Query(ge=0, le=_SLOT_MAX)]


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Only ``rtmp`` is accepted — media-svc rejects everything else (SRT is
    # disabled there because the token would travel in cleartext in the SRT
    # streamid field). Mirror its pattern so a caller passing ``srt`` gets a
    # clean 422 at this layer instead of a confusing forwarded one.
    protocol: Annotated[str, Field(default="rtmp", pattern=r"^rtmp$")] = "rtmp"
    # Which of the caller's stream slots to publish (0 == the default single
    # stream). Forwarded verbatim to media-svc, which owns the path/key shape.
    slot: Annotated[int, Field(default=0, ge=0, le=_SLOT_MAX)] = 0


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
    method: str, path: str, *, bearer: str, json_body: dict | None = None, http: httpx.AsyncClient | None = None
) -> httpx.Response:
    """Call media-svc, forwarding the user's bearer token. Raises on transport
    errors; the route maps those to 502/503."""
    settings = get_settings()
    url = settings.media_svc_url.rstrip("/") + path
    if http is not None:
        return await http.request(
            method, url, headers={"Authorization": f"Bearer {bearer}"}, json=json_body
        )
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
    request: Request = None,
) -> StreamTokenOut:
    channel = await _require_voice_channel_member(session, channel_id, current.id)
    # STREAM gates the publish side — frontend already hides the button
    # without it, but a 403 here closes the loop in case someone calls
    # the endpoint directly (the media-svc token grants real publish
    # rights, so backend enforcement is essential).
    await check_permission(
        session, current, channel.guild_id, Permissions.STREAM,
        channel_id=channel_id,
    )
    bearer = _bearer_from_header(authorization)
    http = getattr(request.app.state, "media_svc_http", None)
    try:
        resp = await _media_svc_request(
            "POST",
            f"/channels/{channel_id}/stream-token",
            bearer=bearer,
            json_body={"protocol": payload.protocol, "slot": payload.slot},
            http=http,
        )
    except httpx.HTTPError as exc:
        raise _media_svc_unavailable(exc) from exc
    if resp.status_code >= 400:
        # Surface media-svc's status (e.g. 401 if the token was somehow
        # rejected there) rather than masking it as a 500.
        raise HTTPException(resp.status_code, detail="media service rejected the request")
    return StreamTokenOut.model_validate(resp.json())


@router.delete("/channels/{channel_id}/stream", status_code=status.HTTP_204_NO_CONTENT)
async def stop_stream(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    authorization: Annotated[str | None, Header()] = None,
    request: Request = None,
    slot: Annotated[int | None, Query(ge=0, le=_SLOT_MAX)] = None,
) -> Response:
    """Explicit stop of the caller's own HQ stream(s) — clears the "live"
    presence immediately instead of waiting for the MediaMTX poll to notice.
    ``slot`` omitted stops all of the caller's streams; ``slot=N`` stops just
    that one. Membership in the channel is enough: media-svc derives the
    streamer from the forwarded bearer, so a caller can only ever stop their
    *own* stream (no STREAM perm needed — they already had it to start).
    Best-effort from the client; the media-svc poller stays the backstop if
    this call never lands."""
    await _require_voice_channel_member(session, channel_id, current.id)
    bearer = _bearer_from_header(authorization)
    http = getattr(request.app.state, "media_svc_http", None)
    path = f"/channels/{channel_id}/stream"
    if slot is not None:
        path += f"?slot={slot}"
    try:
        resp = await _media_svc_request("DELETE", path, bearer=bearer, http=http)
    except httpx.HTTPError as exc:
        raise _media_svc_unavailable(exc) from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, detail="media service rejected the request")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/channels/{channel_id}/whep", response_model=WhepOut)
async def get_whep_url(
    channel_id: int,
    user_id: int,
    session: SessionDep,
    current: CurrentUser,
    authorization: Annotated[str | None, Header()] = None,
    request: Request = None,
    slot: SlotQuery = 0,
) -> WhepOut:
    """WHEP playback URL for `user_id`'s HQ stream in `channel_id` (``slot`` picks
    which of that user's streams, default 0). The caller just has to be a member
    of the channel's guild (they're watching, not the streamer)."""
    channel = await _require_voice_channel_member(session, channel_id, current.id)
    # VIEW_CHANNEL must not be overwrite-denied for this member — a member
    # explicitly excluded from a channel must not be able to watch streams
    # in it.  Mirrors the text-channel subscribe gate in ws_ops_handlers.py.
    await check_permission(
        session, current, channel.guild_id, Permissions.VIEW_CHANNEL,
        channel_id=channel_id,
    )
    bearer = _bearer_from_header(authorization)
    http = getattr(request.app.state, "media_svc_http", None)
    try:
        resp = await _media_svc_request(
            "GET",
            f"/channels/{channel_id}/whep?user_id={user_id}&slot={slot}",
            bearer=bearer,
            http=http,
        )
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
    """Channels in the guild that currently have HQ streamers.

    Returns ``{"stream_states": [{"channel_id": "<id>", "user_ids": ["<id>", ...]},
    ...]}`` — only channels with at least one streamer are listed. Mirrors
    ``GET /guilds/{id}/voice-state``; lets a client re-sync after a reconnect
    without waiting for the next push. Read straight off Redis
    (``stream:channel:*``), the same way voice presence reads ``voice:room:*``.
    """
    await require_member(session, guild_id, current.id)
    stmt = select(Channel.id).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
    )
    raw_ids = list((await session.execute(stmt)).scalars())
    from dcc_chat_gateway.permissions import filter_viewable_channels  # noqa: PLC0415
    visible_ids = await filter_viewable_channels(session, current, guild_id, raw_ids)
    channel_ids = [str(cid) for cid in raw_ids if cid in visible_ids]
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return {"stream_states": []}
    return {"stream_states": await mgr.stream_states_for(channel_ids)}
