"""Community-Laufwerk: Freigabe-Adresse setzen + Weiterreich-Route (Etappe E8).

Design ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`` §7.
Das Community-Laufwerk gehoert dem Besitzer der Community (``Guild.owner_id``)
persoenlich — nicht ``MANAGE_GUILD``, die Rechte einer Community reichen nicht
bis in fremde Cloud-Konten (Plan-Auftrag E8, Aufgabe 1). Drei Routen, parallel
zu ``ablage_kanal.py``:

* ``PUT .../ablage/laufwerk`` — nur der AKTUELLE Besitzer darf die Adresse
  setzen/ersetzen (geprueft gegen ``Guild.owner_id`` bei JEDEM Aufruf, s.
  ``models/ablage_laufwerk.py::AblageGuildLaufwerk`` fuer die Begruendung,
  warum kein eigenes ``ersteller_id`` gefuehrt wird).
* ``GET .../ablage/laufwerk/status`` — fuer JEDES Mitglied: ist ueberhaupt
  ein Laufwerk verbunden? Nie die Adresse selbst — nur der Ja/Nein-Zustand,
  den die Ansicht (Aufgabe 4) braucht, um dem Besitzer die Aufforderung und
  Mitgliedern nichts zu zeigen.
* ``GET .../ablage/abruf`` — wie beim Kanal: Chiffrat vom Laufwerk
  durchreichen, wenn der direkte Weg (CORS) scheitert.

**Die Adresse verlaesst diesen Server nie wieder** — dieselbe Zusicherung wie
beim Kanal-Pendant (Modulkopf ``ablage_kanal.py``).
"""

from __future__ import annotations

import urllib.parse
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler, hole
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import AblageGuildLaufwerk, Guild, GuildMember
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()

# Dieselbe Uebersetzungstabelle wie ``ablage_kanal.py`` — der Fehlercode ist
# unschaedlich (verraet nur, WELCHE Regel griff, nie die Adresse), die Adresse
# selbst nie Teil der Antwort.
_STATUS_JE_CODE: dict[str, int] = {
    "pfad_leer": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_kodierung": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_ungueltig": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_schema_wechsel": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_absolut": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "pfad_traversal": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ziel_schema": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ziel_ungueltig": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ziel_unaufloesbar": status.HTTP_502_BAD_GATEWAY,
    "ziel_privat": status.HTTP_403_FORBIDDEN,
    "umleitung_ohne_ziel": status.HTTP_502_BAD_GATEWAY,
    "zu_viele_umleitungen": status.HTTP_502_BAD_GATEWAY,
    "upstream_fehler": status.HTTP_502_BAD_GATEWAY,
    "upstream_nicht_erreichbar": status.HTTP_502_BAD_GATEWAY,
    "antwort_zu_gross": status.HTTP_413_CONTENT_TOO_LARGE,
    "zeit_ueberschritten": status.HTTP_504_GATEWAY_TIMEOUT,
}


class FreigabeAdresseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    freigabe_adresse: Annotated[str, Field(min_length=1, max_length=8192)]


class LaufwerkStatusOut(BaseModel):
    verbunden: bool


async def _guild_oder_404(session: SessionDep, guild_id: int) -> Guild:
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="guild not found")
    return guild


async def _mitglied_oder_403(session: SessionDep, guild_id: int, user_id: int) -> None:
    if await session.get(GuildMember, (guild_id, user_id)) is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this guild")


@router.put(
    "/guilds/{guild_id}/ablage/laufwerk",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def setze_guild_freigabe_adresse(
    guild_id: int,
    payload: FreigabeAdresseIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Nur der AKTUELLE Besitzer darf die Adresse hinterlegen/ersetzen."""
    guild = await _guild_oder_404(session, guild_id)
    if guild.owner_id != current.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="only the guild owner may connect its drive",
        )
    if not ratelimit.check("ablage_guild_laufwerk_setzen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    geteilt = urllib.parse.urlsplit(payload.freigabe_adresse)
    if geteilt.scheme not in ("http", "https") or not geteilt.hostname:
        raise HTTPException(422, detail="freigabe_adresse must be an http(s) URL")

    bestehend = await session.get(AblageGuildLaufwerk, guild.id)
    if bestehend is None:
        session.add(
            AblageGuildLaufwerk(guild_id=guild.id, freigabe_adresse=payload.freigabe_adresse)
        )
    else:
        bestehend.freigabe_adresse = payload.freigabe_adresse
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/guilds/{guild_id}/ablage/laufwerk/status", response_model=LaufwerkStatusOut)
async def guild_laufwerk_status(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> LaufwerkStatusOut:
    """Nur Ja/Nein — nie die Adresse. Jedes Mitglied darf fragen (Aufgabe 4:
    der Besitzer sieht bei ``verbunden=false`` die Aufforderung, Mitglieder
    sehen bei ``false`` nichts — beide brauchen dafuer denselben Zustand)."""
    await _guild_oder_404(session, guild_id)
    await _mitglied_oder_403(session, guild_id, current.id)
    laufwerk = await session.get(AblageGuildLaufwerk, guild_id)
    return LaufwerkStatusOut(verbunden=laufwerk is not None)


@router.get("/guilds/{guild_id}/ablage/abruf")
async def guild_ablage_abruf(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    pfad: Annotated[str, Query(min_length=1, max_length=2048)],
) -> Response:
    """Reicht Chiffrat vom Community-Laufwerk durch — dieselben Regeln wie
    ``ablage_kanal.py::ablage_abruf``, s. dort fuer die volle Begruendung."""
    await _guild_oder_404(session, guild_id)
    await _mitglied_oder_403(session, guild_id, current.id)
    if not ratelimit.check("ablage_guild_abruf", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    laufwerk = await session.get(AblageGuildLaufwerk, guild_id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no drive connected")

    settings = chat_config.get_settings()
    try:
        ergebnis = await hole(
            basis=laufwerk.freigabe_adresse,
            pfad=pfad,
            max_bytes=settings.ablage_abruf_max_bytes,
            timeout_s=settings.ablage_abruf_timeout_s,
        )
    except AblageAbrufFehler as exc:
        raise HTTPException(
            _STATUS_JE_CODE.get(exc.code, status.HTTP_502_BAD_GATEWAY), detail=exc.code
        ) from exc

    return Response(
        content=ergebnis.inhalt,
        media_type=ergebnis.content_type or "application/octet-stream",
    )
