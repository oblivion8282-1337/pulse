"""Standplatz-Geräte — Eintragen, Auflisten, Umstellen, Entfernen.

Ein Gerät ist ein Rechner, der in einem Kanal **steht**, ohne dort Teilnehmer zu
sein (Entwurf: ``docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md``).
Wie ein Werkzeug in einem Raum: wer den Raum betreten darf, sieht es; wer die
Berechtigung hat, benutzt es.

Endpunkte
---------
* ``GET    /guilds/{guild_id}/devices`` — alle Geräte, deren Standplatz der
  Rufer sehen darf.
* ``POST   /guilds/{guild_id}/devices`` — diesen Rechner eintragen.
* ``PATCH  /guilds/{guild_id}/devices/{device_id}`` — umbenennen / umstellen.
* ``DELETE /guilds/{guild_id}/devices/{device_id}`` — entfernen.

Rechte
------
**Sehen** folgt dem Standplatz: ``VIEW_CHANNEL`` auf dem Kanal, in dem das Gerät
steht — dieselbe Regel wie für Kanäle selbst. Wer die Werkstatt nicht sieht,
sieht auch nicht, was dort steht.

**Eintragen** verlangt ``STREAM`` in dem Kanal, sonst nichts. Die Begründung ist
eine Gleichheit: wer dort ohnehin übertragen darf, darf seinen Rechner auch dort
abstellen — ein eingetragenes Gerät kann nichts, was ein Mensch mit demselben
Recht in demselben Kanal nicht auch könnte. ``MANAGE_CHANNELS`` zu verlangen
hiesse, dass ein Nutzer für seinen eigenen Rechner einen Verwalter braucht.

**Ändern und Entfernen** darf der Besitzer, und ausserdem ``MANAGE_GUILD``: ein
Gerät steht im Raum einer Community, und deren Verwaltung muss es auch dann
räumen können, wenn der Besitzer nicht erreichbar ist.

Was hier NICHT steht
--------------------
Der **Zustand** eines Geräts (bereit / belegt / offline) — der kommt nicht aus
der Datenbank, sondern aus lebenden Verbindungen und steht deshalb in
:mod:`dcc_chat_gateway.device_registry`. Eine Spalte dafür wäre eine Zahl, die
nach jedem Absturz lügt.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    DEVICE_NAME_MAX_LEN,
    Channel,
    Device,
)
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter(prefix="/guilds/{guild_id}/devices", tags=["devices"])

#: Wie viele Geräte eine Person je Community eintragen darf.
#:
#: Nicht als Schutz vor einem Angreifer gedacht — wer eintragen darf, darf auch
#: übertragen, und das ist die teurere Handlung. Es ist ein Riegel gegen den
#: Unfall: ein Client, der die Eintragung bei jedem Start wiederholt, füllte
#: sonst die Kanalliste, und der Fehler fiele erst jemand anderem auf.
MAX_DEVICES_PER_OWNER = 10

#: Erlaubte Gerätenamen: Buchstaben, Ziffern, Bindestrich, Unterstrich, Punkt.
#:
#: Bewusst enger als bei Kanalnamen. Der Name steht im Entwurf in Monospace
#: neben runden Menschen-Avataren und soll auf den ersten Blick als Maschine
#: lesbar sein; Leerzeichen und Sonderzeichen laden dazu ein, einen Menschen
#: nachzubauen ("Michael (Admin)"), und genau diese Verwechslung soll die
#: Oberfläche verhindern.
_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")


class DeviceCreate(BaseModel):
    channel_id: SnowflakeId
    name: str = Field(min_length=1, max_length=DEVICE_NAME_MAX_LEN)
    #: Kennung des Geräteausweises, mit dem sich dieser Rechner meldet. Optional,
    #: solange der Ausweisbezug in der Cloud nicht im Zugangs-Token steht (§6
    #: des Entwurfs, „ehrliche Lücke").
    cert_id: str | None = Field(default=None, max_length=64)


class DevicePatch(BaseModel):
    channel_id: SnowflakeId | None = None
    name: str | None = Field(default=None, min_length=1, max_length=DEVICE_NAME_MAX_LEN)


class DeviceOut(BaseModel):
    id: str
    guild_id: str
    channel_id: str
    owner_user_id: str
    name: str
    #: ``ready`` | ``busy`` | ``offline`` — aus dem Verbindungsregister.
    state: str
    #: Wer es gerade steuert (nur bei ``busy``), sonst ``None``.
    busy_with: str | None = None
    #: Die Bildschirme, die das Gerät beim Anmelden gemeldet hat. Leer, solange
    #: es nie verbunden war — der Steuernde sieht dann nur „ein Bildschirm",
    #: und das ist ehrlicher als eine erfundene Liste.
    monitors: list[dict] = []


def _normalise_name(name: str) -> str:
    """Gerätenamen vereinheitlichen und prüfen.

    Kleinschreibung erzwungen statt nur geprüft: ``Werkstatt-PC`` und
    ``werkstatt-pc`` wären zwei Zeilen, die in jeder Liste gleich aussehen —
    und die Eindeutigkeit je Community soll eine über den NAMEN sein, nicht
    über die Schreibweise.
    """
    kandidat = name.strip().lower()
    if not _NAME_RE.match(kandidat):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="device name must be lowercase letters, digits, '.', '-' or '_'",
        )
    return kandidat


async def _channel_in_guild(session, guild_id: int, channel_id: int) -> Channel:
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.guild_id != guild_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    # Der Standplatz muss ein Sprachkanal sein: dort läuft die Übertragung, an
    # der die Fernsteuerung hängt (`routes/streaming.py` verlangt genau das).
    # Ein Gerät in einem Textkanal wäre sichtbar und nicht benutzbar.
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="a device stands in a voice channel"
        )
    return channel


async def _load_device(session, guild_id: int, device_id: int) -> Device:
    device = await session.get(Device, device_id)
    if device is None or device.guild_id != guild_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="device not found")
    return device


async def _require_owner_or_manager(session, user, device: Device) -> None:
    if device.owner_user_id == user.id:
        return
    await check_permission(
        session,
        user,
        device.guild_id,
        Permissions.MANAGE_GUILD,
        detail="only the device owner or a community manager can do this",
    )


def _manager(request: Request):
    return getattr(request.app.state, "connection_manager", None)


def _to_out(device: Device, mgr) -> DeviceOut:
    # Ohne Manager (Testaufbau ohne WS-Schicht) ist nichts angemeldet — und
    # „offline" ist die richtige Antwort auf „ich weiss es nicht".
    zustand, mit = mgr.device_state(device.id) if mgr is not None else ("offline", None)
    schirme = mgr.device_monitors(device.id) if mgr is not None else []
    return DeviceOut(
        id=str(device.id),
        guild_id=str(device.guild_id),
        channel_id=str(device.channel_id),
        owner_user_id=str(device.owner_user_id),
        name=device.name,
        state=zustand,
        busy_with=mit,
        monitors=schirme,
    )


@router.get("", response_model=list[DeviceOut])
async def list_devices(
    guild_id: SnowflakeId, user: CurrentUser, session: SessionDep, request: Request
) -> list[DeviceOut]:
    await require_member(session, guild_id, user.id)
    rows = (
        (
            await session.execute(
                select(Device).where(Device.guild_id == guild_id).order_by(Device.name)
            )
        )
        .scalars()
        .all()
    )
    # Je Standplatz EINMAL auflösen, nicht je Gerät: mehrere Geräte in derselben
    # Werkstatt sind der Regelfall, und `resolve_permissions` ist der teuerste
    # Teil dieser Route.
    sichtbar: dict[int, bool] = {}
    ergebnis: list[DeviceOut] = []
    for device in rows:
        if device.channel_id not in sichtbar:
            wert = await resolve_permissions(session, user, guild_id, device.channel_id)
            sichtbar[device.channel_id] = has_permission(wert, Permissions.VIEW_CHANNEL)
        if sichtbar[device.channel_id]:
            ergebnis.append(_to_out(device, _manager(request)))
    return ergebnis


@router.post("", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
async def create_device(
    guild_id: SnowflakeId,
    body: DeviceCreate,
    user: CurrentUser,
    session: SessionDep,
    request: Request,
) -> DeviceOut:
    await require_member(session, guild_id, user.id)
    await _channel_in_guild(session, guild_id, body.channel_id)
    await check_permission(
        session,
        user,
        guild_id,
        Permissions.STREAM,
        channel_id=body.channel_id,
        detail="you need permission to stream in that channel to park a device there",
    )
    name = _normalise_name(body.name)

    eigene = (
        await session.execute(
            select(func.count())
            .select_from(Device)
            .where(Device.guild_id == guild_id, Device.owner_user_id == user.id)
        )
    ).scalar_one()
    if eigene >= MAX_DEVICES_PER_OWNER:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"at most {MAX_DEVICES_PER_OWNER} devices per community",
        )

    device = Device(
        id=next_id(),
        guild_id=guild_id,
        channel_id=body.channel_id,
        owner_user_id=user.id,
        name=name,
        cert_id=body.cert_id or None,
    )
    session.add(device)
    try:
        await session.commit()
    except IntegrityError:
        # Beide Eindeutigkeiten landen hier (Name je Community, Ausweis je
        # Community). Ein zweiter Versuch desselben Rechners ist der häufigere
        # Fall und ausdrücklich kein Fehler des Nutzers — deshalb 409 mit einer
        # Meldung, die sagt, was zu tun ist.
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="a device with that name (or this same machine) is already parked here",
        ) from None
    stand = _to_out(device, _manager(request))
    await _melden(request, device, stand)
    return stand


@router.patch("/{device_id}", response_model=DeviceOut)
async def patch_device(
    guild_id: SnowflakeId,
    device_id: SnowflakeId,
    body: DevicePatch,
    user: CurrentUser,
    session: SessionDep,
    request: Request,
) -> DeviceOut:
    await require_member(session, guild_id, user.id)
    device = await _load_device(session, guild_id, device_id)
    await _require_owner_or_manager(session, user, device)

    if body.name is not None:
        device.name = _normalise_name(body.name)
    alter_kanal: int | None = None
    if body.channel_id is not None and body.channel_id != device.channel_id:
        await _channel_in_guild(session, guild_id, body.channel_id)
        await check_permission(
            session,
            user,
            guild_id,
            Permissions.STREAM,
            channel_id=body.channel_id,
            detail="you need permission to stream in the new channel",
        )
        alter_kanal = device.channel_id
        device.channel_id = body.channel_id

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="a device with that name already exists here"
        ) from None
    if alter_kanal is not None:
        # **Der Standplatzwechsel beendet eine laufende Sitzung.** Die Rechte
        # hingen am alten Kanal; ein stiller Übergang wäre die falsche Art von
        # bequem (Entwurf §3). NACH dem Commit (Bughunt 2026-08-16): davor
        # starb die Sitzung auch dann, wenn die Änderung gleich darauf an einem
        # Namenskonflikt scheiterte — abgebrochen und trotzdem getrennt.
        await _sitzung_beenden(request, device)
        # **Den alten Standplatz mitziehen** (Bughunt 2026-08-16): das Register
        # merkt sich den Ort, an den es Zustandsmeldungen schickt. Ohne diese
        # Zeile meldete ein umgestelltes Gerät weiter an den alten Kanal — die
        # Falschen sähen seinen Zustand, die Berechtigten nie einen.
        mgr = _manager(request)
        if mgr is not None:
            mgr.device_move(device.id, guild_id, device.channel_id)
        # Und aus der Liste des alten Kanals muss es verschwinden. Wer den
        # neuen nicht sehen darf, behielte sonst einen Eintrag, den es dort
        # nicht mehr gibt — und könnte ihn wecken wollen.
        await _melden(request, device, _to_out(device, mgr), entfernt=True, kanal=alter_kanal)
    stand = _to_out(device, _manager(request))
    await _melden(request, device, stand)
    return stand


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    guild_id: SnowflakeId,
    device_id: SnowflakeId,
    user: CurrentUser,
    session: SessionDep,
    request: Request,
) -> None:
    await require_member(session, guild_id, user.id)
    device = await _load_device(session, guild_id, device_id)
    await _require_owner_or_manager(session, user, device)
    await _sitzung_beenden(request, device)
    # Der letzte Stand VOR dem Löschen: der Client braucht die Kennung zum
    # Austragen, und der Name macht eine Meldung lesbar.
    stand = _to_out(device, _manager(request))
    await session.delete(device)
    await session.commit()
    await _melden(request, device, stand, entfernt=True)


# ── Nebenwirkungen ──────────────────────────────────────────────────────────
#
# Beide bewusst nach dem Commit und beide fehlertolerant: die Datenbank ist die
# Wahrheit, die Meldung an die offenen Fenster ist Bequemlichkeit. Ein fehlendes
# Redis darf keine Eintragung scheitern lassen — dieselbe Linie wie bei den
# Plugin-Toggles (`guild_plugins.py`).


async def _melden(
    request: Request,
    device: Device,
    stand: DeviceOut,
    *,
    entfernt: bool = False,
    kanal: int | None = None,
) -> None:
    """``device_changed`` an die Community schicken.

    ``kanal`` übersteuert den Standplatz — gebraucht beim Umstellen, wo die
    Meldung „weg hier" an den ALTEN Kanal gehen muss.
    """
    mgr = _manager(request)
    if mgr is None:
        return
    try:
        await mgr.publish_device_change(
            guild_id=device.guild_id,
            channel_id=kanal if kanal is not None else device.channel_id,
            device=stand.model_dump(),
            removed=entfernt,
        )
    except Exception:  # pragma: no cover - Meldung ist nie kritisch
        log.debug("device_changed not published", exc_info=True)


async def _sitzung_beenden(request: Request, device: Device) -> None:
    """Eine laufende Fernsteuerung dieses Geräts abbauen."""
    mgr = _manager(request)
    if mgr is None:
        return
    try:
        await mgr.end_remote_sessions_for_device(device.id)
    except Exception:  # pragma: no cover
        log.debug("device sessions not ended", exc_info=True)
