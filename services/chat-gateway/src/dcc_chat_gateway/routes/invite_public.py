"""Anonyme Einladungs-Vorschau: ``GET /invites/{code}/public-preview``.

Für die Einladungsseite (``web/src/routes/invite/[code]``): wer abgemeldet
einen Link öffnet, soll vor dem Anmelden sehen, wohin er führt. Eigene Route
statt optionaler Anmeldung an ``GET /invites/{code}`` — dieselbe Regel wie
bei den Gast-Links: nirgends „Nutzer ODER anonym“ an einer Abhängigkeit.

Bewusst knapp: Name, Bild, Mitgliederzahl — keine ``guild.id``, kein
``channel_id``. Jedes „nein“ (unbekannt, zurückgezogen, abgelaufen,
aufgebraucht, gesperrte Community) ist dieselbe 404, und die Bremse zählt in
Redis pro IP UND pro Code (``ratelimit.py`` zählt pro Nutzer-ID im Prozess und
wäre für Anonyme wirkungslos). Spec 2026-10-10, Abschnitt „Server“.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Path, Request, status
from pydantic import BaseModel

from dcc_chat_gateway import gaeste
from dcc_chat_gateway.client_ip import client_ip
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Guild, GuildInvite
from dcc_chat_gateway.routes._deps import is_guild_suspended
from dcc_chat_gateway.routes.invites import _INVITE_INVALID, _is_active, _member_count

router = APIRouter()

# Wie die Gast-Routen (gaeste.bremse_pruefen): 30 Codes pro IP und Minute
# reichen jedem Menschen; 60 Abrufe pro Code bremsen ein Skript auf einen Link.
_IP_LIMIT = 30
_CODE_LIMIT = 60
_FENSTER_S = 60


class PublicInviteGuildOut(BaseModel):
    name: str
    icon_url: str | None


class PublicInvitePreviewOut(BaseModel):
    guild: PublicInviteGuildOut
    member_count: int


async def _bremsen(redis, request: Request, code: str) -> None:
    ip = client_ip(request)
    if ip and not await gaeste.bremse(redis, f"einladung:rate:ip:{ip}", _IP_LIMIT, _FENSTER_S):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen")
    code_h = gaeste.code_hash(code)
    if not await gaeste.bremse(redis, f"einladung:rate:code:{code_h}", _CODE_LIMIT, _FENSTER_S):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen")


@router.get("/invites/{code}/public-preview", response_model=PublicInvitePreviewOut)
async def public_invite_preview(
    session: SessionDep,
    request: Request,
    code: str = Path(min_length=1, max_length=64),
) -> PublicInvitePreviewOut:
    await _bremsen(getattr(request.app.state, "redis", None), request, code)
    invite = await session.get(GuildInvite, code)
    if invite is None or not _is_active(invite, datetime.now(tz=UTC)):
        raise HTTPException(404, detail=_INVITE_INVALID)
    guild = await session.get(Guild, invite.guild_id)
    if guild is None or await is_guild_suspended(session, guild.id):
        raise HTTPException(404, detail=_INVITE_INVALID)
    return PublicInvitePreviewOut(
        guild=PublicInviteGuildOut(name=guild.name, icon_url=guild.icon_url),
        member_count=await _member_count(session, guild.id),
    )
