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

**Umbenennen und Entfernen** darf der Besitzer, und ausserdem ``MANAGE_GUILD``:
ein Gerät steht im Raum einer Community, und deren Verwaltung muss es auch dann
räumen können, wenn der Besitzer nicht erreichbar ist.

**Umstellen darf nur der Besitzer.** Der Standplatz ist der Rechteanker — wer
ihn setzt, bestimmt, wer den Rechner übernehmen darf. „Räumen können" trägt das
nicht: mit ``MANAGE_GUILD`` allein liesse sich ein fremder Rechner in einen
Kanal schieben, in dem ``@everyone`` ``REMOTE_CONTROL`` hat.

Was hier NICHT steht
--------------------
Der **Zustand** eines Geräts (bereit / belegt / offline) — der kommt nicht aus
der Datenbank, sondern aus lebenden Verbindungen und steht deshalb in
:mod:`dcc_chat_gateway.device_registry`. Eine Spalte dafür wäre eine Zahl, die
nach jedem Absturz lügt.

Die **Form** eines Geräts nach aussen (``DeviceOut``) und die beiden Meldungen,
die eine Änderung begleiten, stehen in :mod:`dcc_chat_gateway.device_meldungen`
— beides brauchen auch Pfade ohne Route (Rauswurf, Bann).
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.device_grants import rollen_freigaben_loeschen
from dcc_chat_gateway.device_meldungen import (
    DeviceOut,
    device_out,
    manager_von,
    melden,
    sitzung_beenden,
)
from dcc_chat_gateway.guild_limits import LIMITS_BY_KEY, effective
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    DEVICE_NAME_MAX_LEN,
    Channel,
    Device,
    Guild,
)
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import is_guild_member, require_member
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(prefix="/guilds/{guild_id}/devices", tags=["devices"])

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
    #: Zielcommunity. Nur der Besitzer darf sie ändern — der Standplatz ist der
    #: Rechteanker, und ``MANAGE_GUILD`` soll räumen können, nicht umwidmen
    #: (dieselbe Begründung wie beim Kanal). Zusammen mit ``channel_id``
    #: anzugeben: ein Kanal ohne seine Community wäre nicht auflösbar.
    guild_id: SnowflakeId | None = None
    channel_id: SnowflakeId | None = None
    name: str | None = Field(default=None, min_length=1, max_length=DEVICE_NAME_MAX_LEN)


class DevicePatchOut(DeviceOut):
    #: Anzahl geräumter Rollen-Freigaben bei einem Community-Wechsel — 0 bei
    #: reinem Kanalwechsel/Umbenennen. Nicht Teil von ``DeviceOut``: das Feld
    #: entsteht nur hier, in jeder Geräteliste wäre es eine Lüge.
    role_grants_cleared: int = 0


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


async def _standplatz_kanal(
    session, user, guild_id: int, channel_id: int, *, detail: str
) -> Channel:
    """Den künftigen Standplatz laden und prüfen, dass der Rufer dort abstellen
    darf.

    **Die Reihenfolge ist hier Sicherheit, nicht Geschmack** (Bughunt
    2026-08-16): Existenz und Typ standen vor der Rechteprüfung, und die drei
    Antworten 404 / 400 / 403 verrieten damit jedem Mitglied, ob es hinter einer
    beliebigen Kennung einen Kanal gibt und ob er Sprache oder Text trägt —
    auch für Kanäle, die es nicht sehen darf. Ein unsichtbarer Kanal antwortet
    deshalb jetzt wortgleich wie ein nicht vorhandener.
    """
    channel = await session.get(Channel, channel_id)
    wert = await resolve_permissions(session, user, guild_id, channel_id)
    if (
        channel is None
        or channel.guild_id != guild_id
        or not has_permission(wert, Permissions.VIEW_CHANNEL)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    # Der Standplatz muss ein Sprachkanal sein: dort läuft die Übertragung, an
    # der die Fernsteuerung hängt (`routes/streaming.py` verlangt genau das).
    # Ein Gerät in einem Textkanal wäre sichtbar und nicht benutzbar.
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="a device stands in a voice channel"
        )
    if not has_permission(wert, Permissions.STREAM):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=detail)
    return channel


async def _ziel_standplatz(
    session, user, guild_id: int, channel_id: int, *, detail: str
) -> Channel:
    """Wie ``_standplatz_kanal``, aber für eine möglicherweise ANDERE Community.

    Die Mitgliedschaft wird hier geprüft und nicht über ``require_member``:
    dessen 403 verriete, dass es die Community gibt. Ein Nicht-Mitglied bekommt
    dieselbe Antwort wie für einen Kanal, den es nicht sehen darf — 404.
    """
    if not await is_guild_member(session, guild_id, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    return await _standplatz_kanal(session, user, guild_id, channel_id, detail=detail)


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


@router.get("", response_model=list[DeviceOut])
async def list_devices(
    guild_id: SnowflakeId, user: CurrentUser, session: SessionDep, request: Request
) -> list[DeviceOut]:
    await require_member(session, guild_id, user.id)
    treffer = await session.execute(
        select(Device).where(Device.guild_id == guild_id).order_by(Device.name)
    )
    # Je Standplatz EINMAL auflösen, nicht je Gerät: mehrere Geräte in derselben
    # Werkstatt sind der Regelfall, und `resolve_permissions` ist der teuerste
    # Teil dieser Route.
    mgr = manager_von(request)
    sichtbar: dict[int, bool] = {}
    ergebnis: list[DeviceOut] = []
    for device in treffer.scalars():
        if device.channel_id not in sichtbar:
            wert = await resolve_permissions(session, user, guild_id, device.channel_id)
            sichtbar[device.channel_id] = has_permission(wert, Permissions.VIEW_CHANNEL)
        if sichtbar[device.channel_id]:
            ergebnis.append(device_out(device, mgr))
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
    await _standplatz_kanal(
        session,
        user,
        guild_id,
        body.channel_id,
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
    guild = await session.get(Guild, guild_id)
    deckel = effective(guild, LIMITS_BY_KEY["max_devices_per_owner"]) if guild else None
    if deckel is not None and eigene >= deckel:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"at most {deckel} devices per community",
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
    stand = device_out(device, manager_von(request))
    await melden(request, device, stand)
    return stand


@router.patch("/{device_id}", response_model=DevicePatchOut)
async def patch_device(
    guild_id: SnowflakeId,
    device_id: SnowflakeId,
    body: DevicePatch,
    user: CurrentUser,
    session: SessionDep,
    request: Request,
) -> DevicePatchOut:
    await require_member(session, guild_id, user.id)
    device = await _load_device(session, guild_id, device_id)
    await _require_owner_or_manager(session, user, device)

    if body.name is not None:
        device.name = _normalise_name(body.name)
    alter_kanal: int | None = None
    alte_guild: int | None = None
    ziel_guild = body.guild_id if body.guild_id is not None else device.guild_id
    if body.channel_id is not None and (
        body.channel_id != device.channel_id or ziel_guild != device.guild_id
    ):
        # **Umstellen darf nur der Besitzer** (Bughunt 2026-08-16). Der
        # Standplatz ist der Rechteanker des Geräts: wer ihn setzt, bestimmt,
        # wer den Rechner übernehmen darf. Mit ``MANAGE_GUILD`` allein liesse
        # sich ein fremder Rechner in einen Kanal schieben, in dem ``@everyone``
        # ``REMOTE_CONTROL`` hat — die Verwaltung soll räumen können, nicht
        # umwidmen. Löschen und Umbenennen bleiben deshalb bei ihr. Gilt
        # unverändert für den Community-Wechsel: er ist nur eine weitere Form
        # des Umstellens.
        if device.owner_user_id != user.id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="only the device owner can move it to another channel",
            )
        await _ziel_standplatz(
            session,
            user,
            ziel_guild,
            body.channel_id,
            detail="you need permission to stream in the new channel",
        )
        alter_kanal = device.channel_id
        alte_guild = device.guild_id
        device.channel_id = body.channel_id
        device.guild_id = ziel_guild

    geraeumt = 0
    try:
        if alte_guild is not None and alte_guild != device.guild_id:
            # Rollen gehören ihrer Community. Nach dem Wechsel zeigen diese
            # Zeilen ins Leere — schlimmer noch, dieselbe Kennung kann in der
            # Zielcommunity eine andere Rolle sein. VOR dem Commit (dieselbe
            # Lehre wie beim Sitzungsabbau weiter unten, Bughunt 2026-08-16):
            # ein Wechsel, der gleich darauf an einem Namenskonflikt
            # scheitert, darf die Freigaben nicht mitnehmen. Der
            # ``UniqueConstraint``-Verstoss kann schon hier auffliegen
            # (Autoflush vor dem ``DELETE``), nicht erst beim Commit —
            # deshalb liegt die Räumung selbst im ``try``.
            geraeumt = await rollen_freigaben_loeschen(session, device.id)
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="a device with that name already exists here"
        ) from None
    mgr = manager_von(request)
    if alter_kanal is not None:
        # **Der Standplatzwechsel beendet eine laufende Sitzung.** Die Rechte
        # hingen am alten Kanal; ein stiller Übergang wäre die falsche Art von
        # bequem (Entwurf §3). NACH dem Commit (Bughunt 2026-08-16): davor
        # starb die Sitzung auch dann, wenn die Änderung gleich darauf an einem
        # Namenskonflikt scheiterte — abgebrochen und trotzdem getrennt.
        await sitzung_beenden(request, device)
        # **Den alten Standplatz mitziehen** (Bughunt 2026-08-16): das Register
        # merkt sich den Ort, an den es Zustandsmeldungen schickt. Ohne diese
        # Zeile meldete ein umgestelltes Gerät weiter an den alten Kanal — die
        # Falschen sähen seinen Zustand, die Berechtigten nie einen. Seit dem
        # Community-Wechsel muss das die NEUE Community sein, nicht die aus dem
        # Pfad (die bleibt bei einem Wechsel die alte).
        if mgr is not None:
            mgr.device_move(device.id, device.guild_id, device.channel_id)
        # Und aus der Liste des alten Kanals muss es verschwinden. Wer den
        # neuen nicht sehen darf, behielte sonst einen Eintrag, den es dort
        # nicht mehr gibt — und könnte ihn wecken wollen.
        #
        # **Mit dem ALTEN Standplatz in der Nutzlast** (Bughunt 2026-08-16):
        # die Meldung geht an den alten Kanal, das eingebettete Gerät trug aber
        # schon den neuen — das verriet dort eine Kanalkennung, die die
        # Empfänger unter Umständen gar nicht sehen dürfen. Für sie ist die
        # richtige Auskunft „das Gerät, das hier stand, ist weg". Dieselbe
        # Begründung gilt jetzt für die Community: die Meldung geht an die
        # ALTE, nicht an die, in der das Gerät inzwischen steht.
        alt = device_out(device, mgr)
        alt.channel_id = str(alter_kanal)
        alt.guild_id = str(alte_guild)
        await melden(request, device, alt, entfernt=True, kanal=alter_kanal, guild=alte_guild)
    stand = device_out(device, mgr)
    await melden(request, device, stand)
    return DevicePatchOut(**stand.model_dump(), role_grants_cleared=geraeumt)


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
    await sitzung_beenden(request, device)
    # Der letzte Stand VOR dem Löschen: der Client braucht die Kennung zum
    # Austragen, und der Name macht eine Meldung lesbar.
    mgr = manager_von(request)
    stand = device_out(device, mgr)
    await session.delete(device)
    await session.commit()
    await melden(request, device, stand, entfernt=True)
    # Und das Register vergisst es — NACH der Meldung, die den gemerkten
    # Standplatz noch braucht. Ohne das blieben Standplatz und Bildschirmliste
    # für eine gelöschte Kennung über die ganze Prozesslaufzeit stehen
    # (``device_registry.device_forget``).
    if mgr is not None:
        mgr.device_forget(device.id)
