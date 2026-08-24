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
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel, Guild
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import channel_membership, require_member
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.guild_limits import LIMITS_BY_KEY, effective
from dcc_shared.streaming import SLOT_MAX

log = logging.getLogger(__name__)

router = APIRouter()

# Highest per-user stream slot — a user may run slots 0.._SLOT_MAX concurrently
# (e.g. one per monitor). Shared with media-svc via ``dcc_shared.streaming``
# rather than copied: a lower value here would 422 a slot the other half is
# perfectly willing to mint. The reasoning for the number lives there.
_SLOT_MAX = SLOT_MAX
SlotQuery = Annotated[int, Query(ge=0, le=_SLOT_MAX)]

# Eigene Obergrenze fuer die Bildschirm-NUMMER — bewusst NICHT ``_SLOT_MAX``
# wiederverwendet: der begrenzt, wie viele STREAM-PLAETZE ein Nutzer
# gleichzeitig belegen darf, nicht wie viele Monitore seine Maschine hat.
# Beide Zahlen landen zufaellig bei derselben grosszuegigen Schranke (niemand
# hat 99 Bildschirme — dieselbe Begruendung wie fuer ``MAX_SLOTS`` in
# ``dcc_shared.streaming``), aber das ist Zufall, kein gemeinsamer
# Sachverhalt, und verdient eine eigene Konstante statt einer stillschweigend
# uebernommenen.
_MONITOR_INDEX_MAX = 99


class StreamTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # ``rtmp`` oder ``whip``. SRT bleibt draussen: dort reiste das Token im
    # ``streamid``-Feld im Klartext. Das Muster spiegelt media-svc, damit ein
    # Aufrufer mit ``srt`` hier ein sauberes 422 bekommt statt eines
    # weitergereichten.
    #
    # ``whip`` ist seit 2026-08-02 erlaubt (vorher hart auf ``rtmp``): der
    # WHIP-Weg ist der einzige mit RTCP-Rueckkanal, und ohne den wartet ein
    # beitretender Zuschauer bis zum naechsten regulaeren Vollbild auf sein
    # erstes Bild — bei der Vorgabe von 60 s also bis zu eine Minute. media-svc entscheidet weiterhin, was daraus wird — hier steht
    # nur, was ueberhaupt gefragt werden darf.
    protocol: Annotated[str, Field(default="rtmp", pattern=r"^(rtmp|whip)$")] = "rtmp"
    # Which of the caller's stream slots to publish (0 == the default single
    # stream). Forwarded verbatim to media-svc, which owns the path/key shape.
    slot: Annotated[int, Field(default=0, ge=0, le=_SLOT_MAX)] = 0
    # Optional human-readable label (e.g. "Monitor 1") for the viewer picker.
    # Forwarded verbatim to media-svc, which bounds/strips + threads it through
    # the token → active → poller → stream_state path.
    label: Annotated[str | None, Field(default=None, max_length=80)] = None
    # Welchen Bildschirm des Hosts dieser Strom zeigt (1-basiert). Wird wie
    # ``label`` nur weitergereicht; media-sve faedelt es ueber Token-Record →
    # auth-hook → ``stream:active`` → Poller bis zum Zuschauer. Dort macht es
    # die Zuordnung Strom → Monitor eindeutig, die der Name bei baugleichen
    # Geraeten nicht leisten kann.
    monitor_index: Annotated[int | None, Field(default=None, ge=0, le=_MONITOR_INDEX_MAX)] = None
    # Streamt der Client mit 10 bit Farbtiefe? Wird nur weitergereicht;
    # media-svc fädelt es über Token-Record → auth-hook → ``stream:active``
    # bis in die WHEP-Antwort, aus der der Zuschauer seinen Wiedergabeweg
    # ableitet (nur der native Player kann mehr als 8 bit ausgeben).
    ten_bit: bool = False
    # Kann der Sidecar dieses Streamers Eingaben einspielen? Ebenfalls nur
    # durchgereicht. Daran haengt beim Zuschauer, ob „Fernsteuerung anfragen"
    # ueberhaupt erscheint — nur der Windows-Sidecar kann Eingaben einspielen,
    # und ein Knopf, der beim Gegenueber nichts bewirken kann, gehoert nicht
    # angeboten.
    remote_input: bool = False


class StreamTokenOut(BaseModel):
    token: str
    mediamtx_path: str
    push_protocol: str
    push_url: str
    expires_in_s: int


class WhepOut(BaseModel):
    whep_url: str
    # Von media-svc durchgereicht: sendet dieser Stream mit 10 bit?
    ten_bit: bool = False
    # Ebenso: kann dieser Streamer ferngesteuert werden?
    remote_input: bool = False


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


async def _enforce_concurrent_stream_cap(session, guild_id: int, mgr) -> None:
    """Best-effort per-community cap on concurrent live HQ streams. NULL cap =
    unlimited. Counts live streamers across the guild's voice channels from the
    poller-maintained ``stream:channel:*`` Redis state. This state lags a
    just-authorized stream (poller interval), so a rapid burst can briefly
    exceed the cap — this catches the steady-state over-limit case, matching the
    honor-system enforcement of the other quality caps. A truly atomic hard cap
    would have to live in media-svc/auth-hook (documented)."""
    guild = await session.get(Guild, guild_id)  # identity-mapped; no extra query
    cap = (
        effective(guild, LIMITS_BY_KEY["max_concurrent_streams"]) if guild else None
    )
    if cap is None or mgr is None:
        return
    result = await session.execute(
        select(Channel.id).where(
            Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
        )
    )
    channel_ids = [str(cid) for cid in result.scalars()]
    states = await mgr.stream_states_for(channel_ids)
    live = sum(len(s.get("user_ids") or []) for s in states)
    if live >= cap:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=f"community concurrent-stream limit reached ({live}/{cap})",
        )


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
    mgr = getattr(request.app.state, "connection_manager", None)
    await _enforce_concurrent_stream_cap(session, channel.guild_id, mgr)
    bearer = _bearer_from_header(authorization)
    http = getattr(request.app.state, "media_svc_http", None)
    # `label` is optional; only forward when the caller actually set one so the
    # body matches what chat-gateway tests expect (no stray ``label: null``
    # leaking into media-svc when the streamer didn't provide one).
    token_body: dict[str, object] = {"protocol": payload.protocol, "slot": payload.slot}
    if payload.label is not None:
        token_body["label"] = payload.label
    if payload.monitor_index is not None:
        token_body["monitor_index"] = payload.monitor_index
    # Wie ``label`` nur bei Bedarf mitschicken, damit der Body im Normalfall
    # unverändert bleibt.
    if payload.ten_bit:
        token_body["ten_bit"] = True
    if payload.remote_input:
        token_body["remote_input"] = True
    try:
        resp = await _media_svc_request(
            "POST",
            f"/channels/{channel_id}/stream-token",
            bearer=bearer,
            json_body=token_body,
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
