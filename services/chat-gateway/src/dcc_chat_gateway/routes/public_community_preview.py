"""Anonyme Vorschau einer öffentlichen Adresse: ``GET /c/{handle}/public-preview``.

Für die Adressseite (``/c/<handle>``): wer abgemeldet einen Link öffnet, soll
vor dem Anmelden Name, Bild und Mitgliederzahl sehen. Eigene Route statt
optionaler Anmeldung an ``GET /c/{handle}`` — nirgends „Nutzer ODER anonym“
an einer Abhängigkeit (wie ``invite_public.py``).

Bewusst knapp: kein ``guild.id``-Feld, kein ``is_public``. Der Bildpfad in
``icon_url`` (``/api/chat/guild-icons/<id>.webp``) trägt die Guild-ID
allerdings; das Bild ist dort ohnehin öffentlich abrufbar.

Datenschutz-Abwägung: wer einen öffentlichen Handle kennt, darf laut
Produktregel beitreten; dieselbe Vorschau bekam bisher schon jedes
(kostenlose) Konto. Die Bremse (Redis, pro IP UND pro Handle —
``ratelimit.py`` zählt pro Nutzer-ID im Prozess und wäre für Anonyme
wirkungslos) verhindert billiges Abtasten des Handle-Raums. Unbekannt,
privat und gesperrt sind dieselbe 404.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Path, Request, status
from pydantic import BaseModel

from dcc_chat_gateway import gaeste
from dcc_chat_gateway.client_ip import bremsen_schluessel, client_ip
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.routes.invites import _member_count
from dcc_chat_gateway.routes.public_community import _NOT_FOUND, _public_guild_or_404

router = APIRouter()

_IP_LIMIT = 30
_HANDLE_LIMIT = 60
_FENSTER_S = 60


class PublicAddressGuildOut(BaseModel):
    name: str
    icon_url: str | None


class PublicAddressPreviewOut(BaseModel):
    guild: PublicAddressGuildOut
    member_count: int


async def _bremsen(redis, request: Request, handle: str) -> None:
    ip = bremsen_schluessel(client_ip(request))
    if ip and not await gaeste.bremse(redis, f"adresse:rate:ip:{ip}", _IP_LIMIT, _FENSTER_S):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen")
    handle_h = gaeste.code_hash(handle)
    if not await gaeste.bremse(redis, f"adresse:rate:handle:{handle_h}", _HANDLE_LIMIT, _FENSTER_S):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="zu viele Anfragen")


@router.get("/c/{handle}/public-preview", response_model=PublicAddressPreviewOut)
async def public_address_preview(
    session: SessionDep,
    request: Request,
    handle: str = Path(min_length=1, max_length=64),
) -> PublicAddressPreviewOut:
    await _bremsen(getattr(request.app.state, "redis", None), request, handle)
    guild = await _public_guild_or_404(session, handle)
    if guild.suspended_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return PublicAddressPreviewOut(
        guild=PublicAddressGuildOut(name=guild.name, icon_url=guild.icon_url),
        member_count=await _member_count(session, guild.id),
    )
