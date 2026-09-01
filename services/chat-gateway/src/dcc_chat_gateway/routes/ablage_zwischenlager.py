"""Das Zwischenlager der Community-Dateiablage (Etappe E8, Design §7).

Vier Routen:

* ``POST .../ablage/zwischenlager`` — ein Mitglied kuendigt einen Klumpen an
  (nur die Groesse, NIE Name/MIME — die stecken verschluesselt im PADF-Kopf,
  ``ablage/dateiablage.ts``) und bekommt eine presigned PUT-URL, ueber die es
  direkt zu MinIO hochlaedt (dasselbe Muster wie ``routes/attachments.py``).
* ``GET .../ablage/zwischenlager`` — die Liste des noch nicht Gefestigten,
  fuer jedes Mitglied (die Ansicht zeigt sie als ,,noch nicht gesichert").
* ``GET .../ablage/zwischenlager/{id}/download-url`` — presigned GET, damit
  ein zweites Mitglied eine noch nicht gefestigte Datei schon lesen kann
  (Design §7: ,,Bis dahin ist die Datei aus dem Zwischenlager lesbar").
* ``DELETE .../ablage/zwischenlager/{id}`` — die Quittung. NUR der aktuelle
  Community-Besitzer darf quittieren: nur sein Geraet festigt, und die
  Reihenfolge dort ist erst schreiben, dann quittieren (Auftrag E8) — eine
  Quittung von irgendwem anders koennte einen Klumpen loeschen, bevor er je
  gefestigt wurde.

Kontingente (``config.py::ablage_zwischenlager_max_*``) und der Alters-Sweep
(``ablage_zwischenlager_pflege.py``) verhindern, dass das Zwischenlager zum
dauerhaften Speicher wird — Design §7: ,,Ein Zwischenlager ohne Obergrenze
ist eine Einladung, Pulse als Speicher zu benutzen."
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_serializer
from sqlalchemy import func, select

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway import ratelimit, s3
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import AblageZwischenlagerDatei
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.routes._deps import guild_oder_404, mitglied_oder_403
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


def _id_str(v: int) -> str:
    return str(v)


class ZwischenlagerAnkuendigungIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    groesse: Annotated[int, Field(ge=1)]


class ZwischenlagerAnkuendigungOut(BaseModel):
    id: int
    upload_url: str

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class ZwischenlagerEintragOut(BaseModel):
    id: int
    groesse: int
    hochgeladen_von: int
    erstellt_am: str

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)

    @field_serializer("hochgeladen_von")
    def _ser_uploader(self, v: int) -> str:
        return _id_str(v)


def _storage_key(guild_id: int, eintrag_id: int) -> str:
    return f"ablage-zwischenlager/{guild_id}/{eintrag_id}"


async def _belegte_bytes(session: SessionDep, guild_id: int) -> int:
    return (
        await session.execute(
            select(func.coalesce(func.sum(AblageZwischenlagerDatei.groesse), 0)).where(
                AblageZwischenlagerDatei.guild_id == guild_id
            )
        )
    ).scalar_one()


async def _eintrag_oder_404(
    session: SessionDep, guild_id: int, eintrag_id: int
) -> AblageZwischenlagerDatei:
    """Holt den Eintrag und besteht darauf, dass er zu DIESER Community gehoert.

    Ein Eintrag einer fremden Community wird bewusst als 404 abgewiesen, nicht
    als 403: ein 403 wuerde bestaetigen, dass es die Kennung gibt, und damit
    ueber Community-Grenzen hinweg die Existenz fremder Dateien verraten. Die
    Kennungen sind Snowflakes und nicht zu erraten — aber genau das ist eine
    Annahme ueber den Angreifer, keine Zusicherung des Codes.
    """
    zeile = await session.get(AblageZwischenlagerDatei, eintrag_id)
    if zeile is None or zeile.guild_id != guild_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    return zeile


@router.post(
    "/guilds/{guild_id}/ablage/zwischenlager",
    response_model=ZwischenlagerAnkuendigungOut,
    status_code=status.HTTP_201_CREATED,
)
async def zwischenlager_ankuendigen(
    guild_id: int,
    payload: ZwischenlagerAnkuendigungIn,
    session: SessionDep,
    current: CurrentUser,
) -> ZwischenlagerAnkuendigungOut:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    await check_permission(session, current, guild_id, Permissions.ATTACH_FILES)
    if not ratelimit.check("ablage_zwischenlager_ankuendigen", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limited")

    settings = chat_config.get_settings()
    if payload.groesse > settings.ablage_zwischenlager_max_datei_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"file too large ({payload.groesse} > "
                f"{settings.ablage_zwischenlager_max_datei_bytes} bytes)"
            ),
        )
    belegt = await _belegte_bytes(session, guild_id)
    if belegt + payload.groesse > settings.ablage_zwischenlager_max_gesamt_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"community staging quota exceeded ({belegt} + {payload.groesse} > "
                f"{settings.ablage_zwischenlager_max_gesamt_bytes} bytes)"
            ),
        )

    eintrag_id = next_id()
    storage_key = _storage_key(guild_id, eintrag_id)
    session.add(
        AblageZwischenlagerDatei(
            id=eintrag_id,
            guild_id=guild_id,
            hochgeladen_von=current.id,
            groesse=payload.groesse,
            storage_key=storage_key,
        )
    )
    await session.commit()

    # Fester Content-Type, unabhaengig vom tatsaechlichen Inhalt — der Server
    # darf den MIME-Typ nie sehen (er steckt verschluesselt im PADF-Kopf).
    upload_url = await s3.presigned_put_url(
        storage_key,
        content_type="application/octet-stream",
        content_length=payload.groesse,
    )
    return ZwischenlagerAnkuendigungOut(id=eintrag_id, upload_url=upload_url)


@router.get(
    "/guilds/{guild_id}/ablage/zwischenlager",
    response_model=list[ZwischenlagerEintragOut],
)
async def zwischenlager_liste(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[ZwischenlagerEintragOut]:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    zeilen = (
        await session.execute(
            select(AblageZwischenlagerDatei)
            .where(AblageZwischenlagerDatei.guild_id == guild_id)
            .order_by(AblageZwischenlagerDatei.id)
        )
    ).scalars()
    return [
        ZwischenlagerEintragOut(
            id=z.id,
            groesse=z.groesse,
            hochgeladen_von=z.hochgeladen_von,
            erstellt_am=z.created_at.isoformat(),
        )
        for z in zeilen
    ]


@router.get("/guilds/{guild_id}/ablage/zwischenlager/{eintrag_id}/download-url")
async def zwischenlager_download_url(
    guild_id: int,
    eintrag_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> dict[str, str]:
    await guild_oder_404(session, guild_id)
    await mitglied_oder_403(session, guild_id, current.id)
    zeile = await _eintrag_oder_404(session, guild_id, eintrag_id)
    url = await s3.presigned_get_url(zeile.storage_key)
    return {"url": url}


@router.delete(
    "/guilds/{guild_id}/ablage/zwischenlager/{eintrag_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def zwischenlager_quittieren(
    guild_id: int,
    eintrag_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> None:
    """Die Quittung — nur der AKTUELLE Besitzer, s. Modulkopf."""
    guild = await guild_oder_404(session, guild_id)
    if guild.owner_id != current.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="only the guild owner may acknowledge a staged file",
        )
    zeile = await _eintrag_oder_404(session, guild_id, eintrag_id)
    storage_key = zeile.storage_key
    await session.delete(zeile)
    await session.commit()
    # Erst nach dem Commit — ein Rollback darf die Bytes nicht loeschen,
    # waehrend die Zeile noch auf sie zeigt (dasselbe Muster wie
    # ``postfach_pflege.py::sweep_verwaiste_anhaenge``).
    await s3.delete_object(storage_key)
