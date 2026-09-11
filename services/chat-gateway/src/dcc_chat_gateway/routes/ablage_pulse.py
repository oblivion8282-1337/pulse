"""Das Pulse-Laufwerk — Speicher-Weitergabe je Community (Etappe P1).

Spezifikation ``docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md``.
Ersetzt fuer Communitys den E8-Weg (fremdes Laufwerk + Zwischenlager +
Festigung): Es gibt keinen fremden Anbieter mehr, also keinen CORS-Weiterreicher,
keine geheimzuhaltende Adresse und keinen Besitzer-Geraetepfad — der Klient
verschluesselt (PADF, ``ablage/dateiablage.ts``) und legt den Klumpen per
presigned PUT direkt ab. Fuenf Routen:

* ``GET  .../ablage/pulse/status`` — verbunden? genutzt/kontingent? Fuer JEDES
  Mitglied; die Ansicht braucht beides (Bereich zeigen, Füllstand zeigen).
* ``PUT  .../ablage/pulse/laufwerk`` — nur der AKTUELLE Besitzer verbindet
  (dieselbe Regel wie ``ablage_guild_laufwerk.py``, dort steht die Begruendung).
* ``DELETE .../ablage/pulse/laufwerk`` — nur der Besitzer raeumt das ganze
  Laufwerk ab (Zeilen zuerst, Bytes danach — Konvention aus ``user_purge.py``).
* ``POST .../ablage/pulse/dateien`` + ``.../gelungen`` + ``GET lese-url`` +
  ``GET Liste`` + ``DELETE`` — der Klumpen-Weg. Der Server sieht nur den
  klientszeitigen Zufallsnamen, die Groesse und den Uploader; der Inhalt ist
  Chiffrat, und genau darum wird hier nicht gefragt (``ablage_schreiben.py``:
  „Was hier NICHT geprueft wird: der Inhalt").

**Kein Zwischenlager, keine Quittung:** das PUT selbst ist die Ablage. Der
Zustand ``angekündigt`` existiert nur, damit eine nie hochgeladene
Ankündigung nicht als genutzter Platz im Kontingent steht — hochgezählt wird
nur, was der Klient als gelungen meldete.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import AblagePulseLaufwerk, AblagePulseObjekt
from dcc_chat_gateway.routes._deps import guild_oder_404, mitglied_oder_403
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()

# Klient-Zufallsnamen (``a-<hex>.puls``) plus das feste Verzeichnis — der
# Muster-Check ist keine Metadaten-Hygiene (der Name traegt eh keine
# Information), sondern Pfad-Hygiene: er bleibt Teil des storage_key.
_NAME_MUSTER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.puls$")
VERZEICHNIS_NAME = "verzeichnis.puls"


def _storage_key(guild_id: int, name: str) -> str:
    return f"pulse-laufwerk/guild-{guild_id}/{name}"


class LaufwerkStatusOut(BaseModel):
    verbunden: bool
    genutzt_bytes: int = 0
    kontingent_bytes: int = 0


class AnkuendigungIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=5, max_length=128)]
    groesse: Annotated[int, Field(ge=1)]


class GelungenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=5, max_length=128)]


async def _laufwerk_oder_404(session: AsyncSession, guild_id: int) -> AblagePulseLaufwerk:
    laufwerk = await session.get(AblagePulseLaufwerk, guild_id)
    if laufwerk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no drive connected")
    return laufwerk


async def _genutzte_bytes(session: AsyncSession, guild_id: int) -> int:
    summe = await session.execute(
        select(func.coalesce(func.sum(AblagePulseObjekt.groesse), 0)).where(
            AblagePulseObjekt.guild_id == guild_id,
            AblagePulseObjekt.zustand == 1,
        )
    )
    return int(summe.scalar_one())


@router.get("/guilds/{guild_id}/ablage/pulse/status", response_model=LaufwerkStatusOut)
async def pulse_status(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> LaufwerkStatusOut:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    laufwerk = await session.get(AblagePulseLaufwerk, guild_id)
    einstellungen = chat_config.get_settings()
    return LaufwerkStatusOut(
        verbunden=laufwerk is not None,
        genutzt_bytes=await _genutzte_bytes(session, guild_id),
        kontingent_bytes=einstellungen.pulse_laufwerk_max_gesamt_bytes,
    )


@router.put(
    "/guilds/{guild_id}/ablage/pulse/laufwerk",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def verbinde_pulse_laufwerk(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Nur der AKTUELLE Besitzer verbindet; idempotent."""
    guild = await guild_oder_404(session, guild_id)
    if guild.owner_id != current.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="only the guild owner may connect its drive",
        )
    if not ratelimit.check("ablage_pulse_verbinden", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    if await session.get(AblagePulseLaufwerk, guild.id) is None:
        session.add(AblagePulseLaufwerk(guild_id=guild.id, erstellt_von=current.id))
        await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/guilds/{guild_id}/ablage/pulse/laufwerk",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def trenne_pulse_laufwerk(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Räumt das Laufwerk KOMPLETT ab — Zeilen zuerst, Bytes danach."""
    guild = await guild_oder_404(session, guild_id)
    if guild.owner_id != current.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="only the guild owner may remove its drive",
        )
    if not ratelimit.check("ablage_pulse_trennen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    schluessel = list(
        (
            await session.execute(
                select(AblagePulseObjekt.storage_key).where(
                    AblagePulseObjekt.guild_id == guild.id
                )
            )
        ).scalars()
    )
    await session.execute(
        sa_delete(AblagePulseObjekt).where(AblagePulseObjekt.guild_id == guild.id)
    )
    await session.execute(
        sa_delete(AblagePulseLaufwerk).where(AblagePulseLaufwerk.guild_id == guild.id)
    )
    await session.commit()
    for key in schluessel:
        await s3.delete_object(key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _objekt_oder_404(session: AsyncSession, guild_id: int, name: str) -> AblagePulseObjekt:
    objekt = (
        await session.execute(
            select(AblagePulseObjekt).where(
                AblagePulseObjekt.guild_id == guild_id,
                AblagePulseObjekt.storage_key == _storage_key(guild_id, name),
            )
        )
    ).scalar_one_or_none()
    if objekt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no such object")
    return objekt


@router.post("/guilds/{guild_id}/ablage/pulse/dateien", status_code=status.HTTP_201_CREATED)
async def kuendige_datei_an(
    guild_id: int,
    payload: AnkuendigungIn,
    session: SessionDep,
    current: CurrentUser,
) -> dict[str, str]:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    if not ratelimit.check("ablage_pulse_ankuendigen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")
    await _laufwerk_oder_404(session, guild_id)

    if _NAME_MUSTER.match(payload.name) is None:
        raise HTTPException(422, detail="name must be a plain *.puls name")
    einstellungen = chat_config.get_settings()
    grenze = (
        einstellungen.pulse_laufwerk_verzeichnis_max_bytes
        if payload.name == VERZEICHNIS_NAME
        else einstellungen.pulse_laufwerk_max_datei_bytes
    )
    if payload.groesse > grenze:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="file too large")
    if await _genutzte_bytes(session, guild_id) + payload.groesse > einstellungen.pulse_laufwerk_max_gesamt_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="drive quota exceeded")

    key = _storage_key(guild_id, payload.name)
    objekt = (
        await session.execute(
            select(AblagePulseObjekt).where(AblagePulseObjekt.storage_key == key)
        )
    ).scalar_one_or_none()
    if objekt is None:
        objekt = AblagePulseObjekt(
            id=next_id(),
            guild_id=guild_id,
            hochgeladen_von=current.id,
            storage_key=key,
            groesse=payload.groesse,
            zustand=0,
        )
        session.add(objekt)
    else:
        # Neuankündigung (das Verzeichnis wird je Schreibvorgang neu
        # geschrieben) — Groesse/Uploader mitnehmen, Zustand zurueck auf 0.
        objekt.groesse = payload.groesse
        objekt.hochgeladen_von = current.id
        objekt.zustand = 0
    await session.commit()

    url = await s3.presigned_put_url(
        key,
        content_type="application/octet-stream",
        content_length=payload.groesse,
    )
    return {"upload_url": url}


@router.post(
    "/guilds/{guild_id}/ablage/pulse/dateien/gelungen",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def melde_gelungen(
    guild_id: int,
    payload: GelungenIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    if not ratelimit.check("ablage_pulse_gelungen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    objekt = await _objekt_oder_404(session, guild_id, payload.name)
    if objekt.hochgeladen_von == current.id:
        objekt.zustand = 1
        await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/guilds/{guild_id}/ablage/pulse/dateien")
async def liste_namen(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[str]:
    """Nur die Klumpen-Namen — das Verzeichnis mit den KLARTEXT-Namen liegt
    verschluesselt IN einem dieser Klumpen und wird vom Klienten gelesen."""
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    await _laufwerk_oder_404(session, guild_id)

    zeilen = await session.execute(
        select(AblagePulseObjekt.storage_key).where(
            AblagePulseObjekt.guild_id == guild_id,
            AblagePulseObjekt.zustand == 1,
        )
    )
    praefix = f"pulse-laufwerk/guild-{guild_id}/"
    return sorted(
        key.removeprefix(praefix) for key in zeilen.scalars() if key.startswith(praefix)
    )


@router.get("/guilds/{guild_id}/ablage/pulse/dateien/lese-url")
async def lese_url(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    name: Annotated[str, Query(min_length=5, max_length=128)],
) -> dict[str, str]:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    if not ratelimit.check("ablage_pulse_lese_url", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")
    await _objekt_oder_404(session, guild_id, name)
    return {"url": await s3.presigned_get_url(_storage_key(guild_id, name))}


@router.delete(
    "/guilds/{guild_id}/ablage/pulse/dateien",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def loesche_datei(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    name: Annotated[str, Query(min_length=5, max_length=128)],
) -> Response:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    if not ratelimit.check("ablage_pulse_loeschen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    objekt = await _objekt_oder_404(session, guild_id, name)
    guild = await guild_oder_404(session, guild_id)
    if objekt.hochgeladen_von != current.id and guild.owner_id != current.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="only the uploader or the guild owner may delete",
        )
    await session.delete(objekt)
    await session.commit()
    await s3.delete_object(objekt.storage_key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
