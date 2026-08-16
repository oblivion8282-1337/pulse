"""WS-Ops eines Standplatz-Geräts: anmelden, abmelden, wecken.

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

**Die Anmeldung antwortet nicht.** Eine fehlgeschlagene Anmeldung heisst „das
Gerät erscheint nicht in der Liste", und das sieht der Besitzer in seiner
eigenen Oberfläche. Eine Fehlerantwort verriete einem fremden Konto dagegen, ob
es eine Gerätezeile mit dieser Kennung gibt. Das **Wecken** antwortet sehr wohl:
es ist die ausdrückliche Handlung eines Menschen, und ein toter Knopf ohne
Antwort war im Zwei-Geräte-Test die schlechteste Rückmeldung, die es gab.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import Device
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.remote_registry import send_to_socket
from dcc_chat_gateway.routes.ws_remote_handlers import _err, _int_or_none

log = logging.getLogger(__name__)


def _manager(ctx: Any) -> Any:
    return getattr(ctx.websocket.app.state, "connection_manager", None)


def _sitzungen(mgr: Any):
    """Die Datenbank-Sitzungsfabrik — über den Manager, nicht über das
    Modul-Global.

    Dieselbe Regel wie bei den Plugin-Ops: ``from …db import SessionLocal``
    zeigt in Tests auf eine ungepatchte Speicher-Datenbank, in der es die
    Gerätezeile nicht gibt. Der Weckruf antwortete dort „kein solches Gerät",
    und der Test hätte die Rechteprüfung, die er belegen soll, nie erreicht.
    In der Anwendung ist es dasselbe Objekt (``app.py::set_session_factory``).
    """
    return getattr(mgr, "_session_factory", None) or SessionLocal


#: Wie viele Bildschirme ein Gerät melden darf. Vier 4K-Schirme sind schon eine
#: sehr grosszügige Arbeitsplatz-Annahme; die Grenze ist kein Schutz vor einem
#: Angreifer (der Anmeldende ist der Besitzer), sondern gegen eine kaputte
#: Client-Fassung, die eine endlose Liste schickt.
MAX_MONITORS = 8

#: Mindestpause zwischen zwei Geräte-Ops derselben Verbindung. Dieselbe Grösse
#: und dieselbe Begründung wie bei ``remote_request``
#: (``ws_remote_handlers._REQUEST_MIN_INTERVAL_S``): jede dieser Nachrichten
#: kostet eine Datenbankabfrage, und der legitime Takt ist ein Klick.
#:
#: **Der Weckruf wiegt sogar schwerer als eine Anfrage**: er startet auf einem
#: FREMDEN Rechner einen Encoder. Ohne Deckel liesse sich ein Gerät im Takt der
#: Leitung zwischen Aufwachen und Einschlafen hin- und herwerfen.
_GERAET_MIN_INTERVAL_S = 2.0


def _takt_frei(ctx: Any, feld: str) -> bool:
    """Ist die Mindestpause für ``feld`` auf dieser Verbindung abgelaufen?

    Zwei getrennte Zeitpunkte (Anmelden, Wecken) statt eines gemeinsamen: sonst
    schluckt der Weckruf die Anmeldung, die ein frisch verbundener Client
    Sekundenbruchteile vorher geschickt hat — und ein verworfenes
    ``device_announce`` heisst „Gerät bleibt offline", bis der Client von sich
    aus neu verbindet.
    """
    now = time.monotonic()
    if now - getattr(ctx, feld, 0.0) < _GERAET_MIN_INTERVAL_S:
        return False
    setattr(ctx, feld, now)
    return True


def _monitore(roh: Any) -> list[dict]:
    """Die gemeldete Bildschirmliste auf das Nötige eindampfen.

    Übernommen wird nur, was die Geräteansicht wirklich zeigt — Nummer, Name,
    ob es der Hauptbildschirm ist. Alles andere (Auflösung, Bildwiederholrate)
    stünde hier als Zahl, die niemand liest und die beim nächsten Umstecken
    falsch ist.
    """
    if not isinstance(roh, list):
        return []
    raus: list[dict] = []
    for eintrag in roh[:MAX_MONITORS]:
        if not isinstance(eintrag, dict):
            continue
        index = eintrag.get("index")
        # Die Nummer muss dieselbe Grenze einhalten wie der Weckruf
        # (``handle_wake``), sonst entsteht in der Auswahl ein Punkt, der beim
        # Anklicken stillschweigend auf dem Hauptbildschirm landet: die Liste
        # wird zwar auf ``MAX_MONITORS`` EINTRAEGE gekuerzt, die Nummern darin
        # sind davon aber unberuehrt.
        if not isinstance(index, int) or not 1 <= index <= MAX_MONITORS:
            continue
        raus.append(
            {
                "index": index,
                "name": str(eintrag.get("name") or f"Monitor {index}")[:64],
                "primary": eintrag.get("primary") is True,
            }
        )
    return raus


async def handle_announce(ctx: Any, msg: dict[str, Any]) -> None:
    """``device_announce`` — dieser Rechner ist das Gerät ``device_id``."""
    device_id = _int_or_none(msg.get("device_id"))
    mgr = _manager(ctx)
    if device_id is None or mgr is None:
        return
    # Bremse VOR der Datenbankabfrage — dieselbe Begründung wie bei
    # ``remote_request``: eine Anmeldung kostet einen Zugriff, und ohne Deckel
    # zahlt der Gateway eine Flut mit Leitungsgeschwindigkeit. Still verworfen,
    # wie die Anmeldung überhaupt nicht antwortet. Ein ehrlicher Client meldet
    # sich einmal je Verbindung an; die zwei Sekunden bemerkt er nie.
    if not _takt_frei(ctx, "last_device_announce"):
        return
    async with _sitzungen(mgr)() as session:
        device = await session.get(Device, device_id)
        # Fremde oder verschwundene Zeile: still verwerfen (s. Modulkopf).
        if device is None or device.owner_user_id != ctx.user.id:
            return
        guild_id, channel_id = device.guild_id, device.channel_id
    # Nur melden, wenn das Gerät damit NEU online ist: ein zweites Fenster
    # desselben Rechners ändert am Zustand nichts, und die Meldung ginge an
    # jedes Mitglied des Kanals.
    if mgr.device_announce(
        ctx.websocket, device_id, guild_id, channel_id, _monitore(msg.get("monitors"))
    ):
        await mgr.publish_device_state(device_id)


async def handle_withdraw(ctx: Any, msg: dict[str, Any]) -> None:
    """``device_withdraw`` — dieser Rechner ist kein Gerät mehr (Eintragung
    entfernt).

    Der Regelfall ist der Verbindungsabriss (:func:`on_disconnect`); dieser Op
    ist der ausdrückliche Weg, damit ein Gerät verschwinden kann, ohne die
    Verbindung zu kappen.
    """
    device_id = _int_or_none(msg.get("device_id"))
    mgr = _manager(ctx)
    if device_id is None or mgr is None:
        return
    # **Nur eine Verbindung, die dieses Gerät auch angemeldet hat, meldet es
    # ab** (Bughunt 2026-08-16). Hier stand keine einzige Prüfung — und der
    # Abbau der Fernsteuerung darunter lief VOR allem anderen. Damit konnte
    # jeder eingeloggte Nutzer mit einer geratenen oder aus der Kanalliste
    # gelesenen Kennung jede laufende Fernsteuerung kappen, beliebig oft.
    # Still verworfen wie in ``handle_announce``: eine Fehlerantwort verriete,
    # ob es die Zeile gibt.
    if ctx.websocket not in mgr.device_sockets(device_id):
        return
    # **Zuerst die Fernsteuerung abbauen, dann abmelden** (Bughunt 2026-08-16).
    # „Dieser Rechner ist kein Gerät mehr" und „jemand steuert ihn gerade über
    # eben dieses Gerät" dürfen nicht nebeneinander bestehen bleiben. Und die
    # Reihenfolge ist nicht beliebig: der Abbau findet die Sitzung über die
    # Verbindungen des Geräts, und die sind nach dem Abmelden weg — genau daran
    # scheiterte das Austragen eines Geräts, während es ferngesteuert wurde.
    await mgr.end_remote_sessions_for_device(device_id)
    if mgr.device_withdraw(ctx.websocket, device_id):
        # Über den gemerkten Standplatz statt über die Datenbank: die Zeile
        # kann in genau diesem Moment gelöscht worden sein (das ist einer der
        # Gründe, aus denen sich ein Gerät abmeldet), und dann fiele die
        # Meldung aus, die den Eintrag aus den Listen der anderen nimmt.
        await mgr.publish_device_state(device_id)


async def handle_wake(ctx: Any, msg: dict[str, Any]) -> None:
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
    die Übernahme nötig ist. Wer nicht übernehmen darf, darf auch keinen fremden
    Rechner zum Encodieren bringen; sonst wäre das Wecken ein Weg, einem Gerät
    dauerhaft Last aufzuzwingen.
    """
    device_id = _int_or_none(msg.get("device_id"))
    mgr = _manager(ctx)
    if device_id is None or mgr is None:
        return
    # Bremse VOR der Datenbankabfrage (s. ``_GERAET_MIN_INTERVAL_S``). Antwortet
    # wie ``remote_request`` mit 4056: der Weckruf ist die ausdrückliche
    # Handlung eines Menschen, und ein toter Knopf ohne Antwort war im
    # Zwei-Geräte-Test die schlechteste Rückmeldung, die es gab.
    if not _takt_frei(ctx, "last_device_wake"):
        await _err(ctx.websocket, 4056, "too many device ops, retry in 2s")
        return
    async with _sitzungen(mgr)() as session:
        device = await session.get(Device, device_id)
        if device is None:
            await _err(ctx.websocket, 4060, "no such device")
            return
        wert = await resolve_permissions(session, ctx.user, device.guild_id, device.channel_id)
        if not has_permission(wert, Permissions.REMOTE_CONTROL):
            # Dieselbe Antwort wie „gibt es nicht": wer das Gerät nicht
            # übernehmen darf, soll aus der Antwort nicht schliessen können,
            # dass es existiert.
            await _err(ctx.websocket, 4060, "no such device")
            return
        channel_id = device.channel_id

    ziele = mgr.device_sockets(device_id)
    if not ziele:
        await _err(ctx.websocket, 4061, "device offline", audit=True)
        return
    frame = {
        "op": "device_wake",
        "device_id": str(device_id),
        "channel_id": str(channel_id),
        "from_user_id": str(ctx.user.id),
    }
    # Welcher Bildschirm gemeint ist. Fehlt die Angabe, nimmt das Gerät seinen
    # Hauptbildschirm — so beginnt jede Sitzung, und die weiteren Schirme
    # schaltet der Steuernde in der laufenden Sitzung dazu. Nur die NUMMER
    # reist, nie eine Aufnahmequelle: der Gateway soll nicht entscheiden
    # können, was ein fremder Rechner aufnimmt.
    monitor = msg.get("monitor")
    if isinstance(monitor, int) and 1 <= monitor <= MAX_MONITORS:
        frame["monitor"] = monitor
    for sock in ziele:
        await send_to_socket(sock, frame)


async def on_disconnect(manager: Any, websocket: Any) -> None:
    """Aufräumen, wenn eine Verbindung fällt.

    Läuft im Abbau-Pfad und muss deshalb ohne Vorbedingung auskommen und nie
    werfen: ein Fehler hier hinge im Abbau anderer Register. Ohne Datenbank aus
    demselben Grund — der Standplatz steht im Register.
    """
    if manager is None:
        return
    for device_id in manager.device_forget_socket(websocket):
        try:
            await manager.publish_device_state(device_id)
        except Exception:  # noqa: BLE001  # pragma: no cover
            log.debug("device offline not published", exc_info=True)
