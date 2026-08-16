"""WS-Ops eines Standplatz-Geräts: sich anmelden und wieder abmelden.

Ein Gerät ist ein Rechner, der in einem Sprachkanal steht, ohne dort Teilnehmer
zu sein (``docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md``).
Die Datenbankzeile sagt, DASS es ihn gibt; dieser Weg sagt, dass er **gerade
da** ist.

## Warum das Gerät sich meldet und nicht der Server es erkennt

Der Server sieht Verbindungen von NUTZERN. Welcher Rechner dahintersteht, weiss
nur der Rechner selbst — er hat sich die Kennung beim Eintragen gemerkt. Ein
Erraten (etwa „der erste Socket dieses Nutzers ist das Gerät") wäre in dem
Moment falsch, in dem der Besitzer nebenher am Laptop sitzt, und es wäre falsch
auf die gefährliche Art: der Laptop stünde als übernehmbares Gerät im Kanal.

## Was geprüft wird

Zeile vorhanden, und der Anmeldende ist ihr Besitzer. Mehr kann hier heute nicht
geprüft werden — der Ausweisbezug fehlt in der Cloud im Zugangs-Token (§6 des
Entwurfs, „ehrliche Lücke"). Der Unterschied ist schmal: wer das Konto hat, hat
ohnehin alles, was das Gerät hat. Er ist trotzdem notiert, damit niemand die
Anmeldung später für einen Geräte-Nachweis hält.

Fehler antworten **nicht**. Eine fehlgeschlagene Anmeldung heisst „das Gerät
erscheint nicht in der Liste", und das sieht der Besitzer in seiner eigenen
Oberfläche. Eine Fehlerantwort verriete einem fremden Konto dagegen, ob es eine
Gerätezeile mit dieser Kennung gibt.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.device_registry import (
    announce,
    forget_socket,
    notify_state,
    publish_device_state,
    sockets_of as _sockets_of,
    withdraw,
)
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.models import Device

log = logging.getLogger(__name__)


async def _fehler(ctx: Any, code: int, msg: str) -> None:
    """Eine Ablehnung, die der Rufer sieht.

    Anders als bei der Anmeldung wird hier geantwortet: das Wecken ist eine
    ausdrückliche Handlung eines Menschen, und ein toter Knopf ohne Antwort war
    im Zwei-Geräte-Test die schlechteste Rückmeldung, die es gab. Die Codes
    sagen absichtlich wenig — „gibt es nicht" deckt auch „darfst du nicht".
    """
    try:
        await ctx.websocket.send_json({"op": "error", "code": code, "msg": msg})
    except Exception:  # noqa: BLE001  # pragma: no cover
        log.debug("device error not sent", exc_info=True)


def _device_id(msg: dict[str, Any]) -> int | None:
    """``device_id`` aus der Nachricht — Snowflakes reisen als Zeichenkette."""
    roh = str(msg.get("device_id") or "").strip()
    if not roh:
        return None
    try:
        return int(roh)
    except ValueError:
        return None


async def handle_announce(ctx: Any, msg: dict[str, Any], *, session_factory=None) -> None:
    """``device_announce`` — dieser Rechner ist das Gerät ``device_id``."""
    device_id = _device_id(msg)
    if device_id is None:
        return
    factory = session_factory or SessionLocal
    async with factory() as session:
        device = await session.get(Device, device_id)
        # Fremde oder verschwundene Zeile: still verwerfen (s. Modulkopf).
        if device is None or device.owner_user_id != ctx.user.id:
            return
        guild_id, channel_id = device.guild_id, device.channel_id
    # Nur melden, wenn das Gerät damit NEU online ist: ein zweites Fenster
    # desselben Rechners ändert am Zustand nichts, und die Meldung ginge an
    # jedes Mitglied des Kanals.
    if announce(ctx.websocket, device_id, guild_id, channel_id):
        await publish_device_state(
            ctx.websocket.app, guild_id=guild_id, channel_id=channel_id, device_id=device_id
        )


async def handle_withdraw(ctx: Any, msg: dict[str, Any], *, session_factory=None) -> None:
    """``device_withdraw`` — dieser Rechner ist kein Gerät mehr (Freigabe
    zurückgenommen, Gerät entfernt).

    Der Regelfall ist der Verbindungsabriss (:func:`on_disconnect`); dieser Op
    ist der ausdrückliche Weg, damit ein Gerät verschwinden kann, ohne die
    Verbindung zu kappen.
    """
    device_id = _device_id(msg)
    if device_id is None:
        return
    if not withdraw(ctx.websocket, device_id):
        return
    # Über den gemerkten Standplatz statt über die Datenbank: die Zeile kann in
    # genau diesem Moment gelöscht worden sein (das ist einer der Gründe, aus
    # denen sich ein Gerät abmeldet), und dann fiele die Meldung aus, die den
    # Eintrag aus den Listen der anderen nimmt.
    await notify_state(device_id)


async def handle_wake(ctx: Any, msg: dict[str, Any], *, session_factory=None) -> None:
    """``device_wake`` — „fang bitte an zu übertragen".

    **Warum das getrennt von ``remote_request`` ist** (Entwurf §8): naheliegend
    wäre, die Anfrage selbst als Weckruf zu nehmen. Dagegen spricht ein
    konkreter Fehlerfall — dann hinge eine Sitzungszusage an einer
    Encoder-Initialisierung. Scheitert die (kein Monitor angeschlossen, Encoder
    belegt, Startverweigerung wegen HDR oder Intra-Refresh), stünde eine aktive
    Fernsteuer-Sitzung ohne Bild da, und der Fehler wäre nicht lesbar. Also:
    wecken → übertragen → **dann** die unveränderte ``remote_request``. In der
    Oberfläche darf das ein Klick sein; hier bleiben es zwei Vorgänge.

    Geprüft wird ``REMOTE_CONTROL`` am **Standplatz** — dasselbe Recht, das für
    die Übernahme nötig ist. Wer nicht übernehmen darf, darf auch keinen
    fremden Rechner zum Encodieren bringen; sonst wäre das Wecken ein Weg,
    einem Gerät dauerhaft Last aufzuzwingen.
    """
    device_id = _device_id(msg)
    if device_id is None:
        return
    factory = session_factory or SessionLocal
    async with factory() as session:
        device = await session.get(Device, device_id)
        if device is None:
            await _fehler(ctx, 4060, "no such device")
            return
        wert = await resolve_permissions(session, ctx.user, device.guild_id, device.channel_id)
        if not has_permission(wert, Permissions.REMOTE_CONTROL):
            # Dieselbe Antwort wie „gibt es nicht": wer das Gerät nicht
            # übernehmen darf, soll aus der Antwort nicht schliessen können,
            # dass es existiert.
            await _fehler(ctx, 4060, "no such device")
            return
        channel_id = device.channel_id

    ziele = list(_sockets_of(device_id))
    if not ziele:
        await _fehler(ctx, 4061, "device offline")
        return
    frame = {
        "op": "device_wake",
        "device_id": str(device_id),
        "channel_id": str(channel_id),
        "from_user_id": str(ctx.user.id),
    }
    for sock in ziele:
        await send_to_socket(sock, frame)


async def on_disconnect(app: Any, websocket: Any, *, session_factory=None) -> None:
    """Aufräumen, wenn eine Verbindung fällt.

    Läuft im Abbau-Pfad und muss deshalb ohne Vorbedingung auskommen und nie
    werfen: ein Fehler hier hinge im Abbau anderer Register. Ohne Datenbank aus
    demselben Grund — der Standplatz steht im Register (``device_registry``).
    """
    for device_id in forget_socket(websocket):
        try:
            await notify_state(device_id)
        except Exception:  # pragma: no cover - Abbau haengt nie an der Meldung
            log.debug("device offline not published", exc_info=True)
