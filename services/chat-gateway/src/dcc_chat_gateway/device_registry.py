"""Welche Standplatz-Geräte gerade **da** sind — und was sie tun.

Die Datenbankzeile (``models/devices.py``) sagt, dass es ein Gerät gibt, wem es
gehört und wo es steht. Sie kann nicht sagen, ob es gerade läuft. Das steht
hier, und zwar bewusst **nicht** in einer Spalte: ein Zustandsfeld in der
Datenbank lügt nach jedem Absturz, jedem Stromausfall und jedem Deploy, und zwar
in die gefährliche Richtung — es behauptet „bereit", wo niemand mehr
antwortet.

## Woher der Zustand kommt

Ein Gerät **meldet sich an**: der Client, der auf diesem Rechner läuft, schickt
nach dem Verbinden ``device_announce`` mit der Kennung, die er sich beim
Eintragen gemerkt hat (WS-Op in ``routes/ws_device_handlers.py``). Der Gateway
prüft, dass es die Zeile gibt und dass der Anmeldende ihr Besitzer ist, und
merkt sich die Verbindung. Fällt sie, fällt das Gerät heraus.

**Was diese Anmeldung beweist und was nicht.** Sie beweist, dass eine
Verbindung des Besitzers behauptet, dieser Rechner zu sein. Sie beweist nicht,
dass es derselbe physische Rechner ist wie beim Eintragen — dafür bräuchte es
die Unterschrift des Geräteausweises, und die kann in der Cloud heute nicht
geprüft werden (die ehrliche Lücke aus §6 des Entwurfs: das Zugangs-Token trägt
keinen Ausweisbezug). Der Unterschied ist real, aber schmal: wer das Konto hat,
hat ohnehin alles, was das Gerät hat. Notiert statt weggeschwiegen.

## Warum im Prozess und nicht in Redis

Dieselbe Begründung wie bei der Zuschauer-Menge der Watch-Party
(``watch_registry.py``): die Menge hängt an **Sockets**, und Sockets leben in
genau einem Prozess. Ein Redis-Eintrag müsste beim Abriss aufgeräumt werden,
und genau das ist der Fall, in dem der Prozess nicht mehr dazu kommt — ein
verwaister „bereit"-Eintrag wäre wieder die Lüge, die dieses Modul vermeidet.
Fährt der Gateway mehrfach, sieht jeder Prozess seine eigenen Geräte; der
Zustand ist dann unvollständig, aber nie falsch (Geräte fehlen, es erscheint
keines, das es nicht gibt).
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_shared.events import DeviceChangedEvent, DeviceStateEvent

log = logging.getLogger(__name__)

#: ``device_id`` → die Sockets, die dieses Gerät angemeldet haben.
#:
#: Eine MENGE und keine einzelne Verbindung: der Client eines Geräts kann
#: mehrere Fenster offen haben (Haupt- und Player-Fenster teilen sich zwar eine
#: Verbindung, aber ein zweiter Tab im Browser des Geräts hat eine eigene), und
#: eines davon zu schliessen darf das Gerät nicht offline melden.
_sockets: dict[int, set[Any]] = {}

#: ``socket`` → die Geräte, die er angemeldet hat. Der Rückweg für den Abriss:
#: beim Trennen ist nur der Socket bekannt.
_by_socket: dict[Any, set[int]] = {}

#: ``device_id`` → Kennung des Steuernden, solange eine Fernsteuerung läuft.
#: Wird vom Fernsteuer-Weg gesetzt (``ws_remote_handlers``), nicht hier
#: hergeleitet — dieses Modul kennt keine Sitzungen.
_belegt: dict[int, str] = {}

#: ``device_id`` → ``(guild_id, channel_id)``, beim Anmelden mitgegeben.
#:
#: **Warum gemerkt statt nachgeschlagen:** der Zustand ändert sich auch an
#: Stellen, die keine Datenbanksitzung haben und keine haben sollten — im
#: Abbau einer Verbindung und beim Ende einer Fernsteuerung. Eine Abfrage dort
#: hiesse, dass eine Meldung an einer Datenbank hängt, die vielleicht gerade
#: nicht antwortet; der Eintrag hier kostet zwei Zahlen je angemeldetem Gerät.
_meta: dict[int, tuple[int, int]] = {}

#: Die Anwendung, gesetzt beim Start (``app.py``-Lifespan). Nur zum Melden —
#: gefunden wird darüber der ConnectionManager. ``None`` heisst „niemand
#: verbunden, also niemand zu benachrichtigen", und genau so verhalten sich die
#: Melder dann auch.
_app: Any = None


def bind_app(app: Any) -> None:
    """Die Anwendung hinterlegen (einmal beim Start)."""
    global _app
    _app = app


def device_state(device_id: int) -> tuple[str, str | None]:
    """``("ready" | "busy" | "offline", wer_steuert)``.

    Reine Abfrage ohne Nebenwirkung, damit sie aus jeder Route heraus gerufen
    werden kann — auch aus einer, die keinen Zugriff auf die Anwendung hat.
    """
    if device_id not in _sockets or not _sockets[device_id]:
        return "offline", None
    wer = _belegt.get(device_id)
    return ("busy", wer) if wer else ("ready", None)


def online_devices() -> list[int]:
    """Alle gerade angemeldeten Geräte — für die Erstauskunft an einen frisch
    verbundenen Client (``ws_ready``)."""
    return [d for d, socks in _sockets.items() if socks]


def announce(socket: Any, device_id: int, guild_id: int, channel_id: int) -> bool:
    """Ein Gerät meldet sich an. ``True``, wenn es damit NEU online ist (nur
    dann muss gemeldet werden — ein zweites Fenster ändert nichts)."""
    _meta[device_id] = (guild_id, channel_id)
    socks = _sockets.setdefault(device_id, set())
    war_leer = not socks
    socks.add(socket)
    _by_socket.setdefault(socket, set()).add(device_id)
    return war_leer


def withdraw(socket: Any, device_id: int) -> bool:
    """Eine Anmeldung zurücknehmen. ``True``, wenn das Gerät damit offline ist."""
    socks = _sockets.get(device_id)
    if socks is None:
        return False
    socks.discard(socket)
    geraete = _by_socket.get(socket)
    if geraete is not None:
        geraete.discard(device_id)
        if not geraete:
            _by_socket.pop(socket, None)
    if socks:
        return False
    _sockets.pop(device_id, None)
    # Ein Gerät, das geht, ist nicht mehr belegt. Ohne diese Zeile bliebe die
    # Belegung stehen und das Gerät käme beim nächsten Anmelden sofort als
    # „belegt" zurück — für eine Sitzung, die es nicht mehr gibt.
    _belegt.pop(device_id, None)
    return True


def forget_socket(socket: Any) -> list[int]:
    """Alles vergessen, was dieser Socket angemeldet hatte. Liefert die Geräte,
    die damit offline sind. Läuft im Disconnect-Pfad; muss deshalb ohne
    Vorbedingung und ohne Wurf auskommen."""
    geraete = list(_by_socket.get(socket, ()))
    offline: list[int] = []
    for device_id in geraete:
        if withdraw(socket, device_id):
            offline.append(device_id)
    _by_socket.pop(socket, None)
    return offline


def set_busy(device_id: int, controller_user_id: str | None) -> None:
    """Belegung setzen oder aufheben. ``None`` = wieder bereit."""
    if controller_user_id is None:
        _belegt.pop(device_id, None)
    else:
        _belegt[device_id] = str(controller_user_id)


def device_for_socket(socket: Any) -> int | None:
    """Welches Gerät dieser Socket angemeldet hat (das erste, falls mehrere).

    Der Fernsteuer-Weg braucht das, um eine Sitzung dem Gerät zuzuordnen: die
    Anfrage nennt den Host als NUTZER, und erst hier wird daraus ein Gerät.
    """
    geraete = _by_socket.get(socket)
    if not geraete:
        return None
    return next(iter(geraete))


def where(device_id: int) -> tuple[int, int] | None:
    """``(guild_id, channel_id)`` eines angemeldeten Geräts, oder ``None``."""
    return _meta.get(device_id)


def reset() -> None:
    """Alles vergessen — nur für Tests. Der Prozess selbst räumt über
    :func:`forget_socket` auf."""
    _sockets.clear()
    _by_socket.clear()
    _belegt.clear()
    _meta.clear()


async def notify_state(device_id: int) -> None:
    """Den Zustand eines Geräts melden, ohne Anwendung und ohne Datenbank im
    Aufrufer.

    Der Weg für alle Stellen, an denen sich der Zustand ändert, ohne dass dort
    ein Kontext zur Verfügung stünde: Verbindungsabriss, Ende einer
    Fernsteuerung. Still, wenn nichts hinterlegt ist — dann gibt es auch
    niemanden, dem die Auskunft nützt.
    """
    ort = _meta.get(device_id)
    if _app is None or ort is None:
        return
    guild_id, channel_id = ort
    try:
        await publish_device_state(
            _app, guild_id=guild_id, channel_id=channel_id, device_id=device_id
        )
    except Exception:  # pragma: no cover - Meldung ist nie kritisch
        log.debug("device_state not published", exc_info=True)


async def release_for_socket(socket: Any) -> None:
    """Die Belegung aufheben, die an diesem Socket hing — und melden.

    Gerufen aus jedem Ende einer Fernsteuerung. Der Socket ist die einzige
    Zuordnung, die dort sicher vorliegt: die Sitzung kennt ihren Host als
    Verbindung, und erst hier wird daraus ein Gerät.
    """
    device_id = device_for_socket(socket)
    if device_id is None or device_id not in _belegt:
        return
    set_busy(device_id, None)
    await notify_state(device_id)


# ── Meldungen ───────────────────────────────────────────────────────────────


async def publish_device_change(
    app: Any, *, guild_id: int, channel_id: int, device: dict, removed: bool
) -> None:
    """``device_changed`` an die Community (gefiltert auf den Standplatz)."""
    manager = getattr(app.state, "connection_manager", None)
    if manager is None:
        return
    await manager.publish_guild_event(
        DeviceChangedEvent(
            guild_id=str(guild_id),
            channel_id=str(channel_id),
            device=device,
            removed=removed,
        )
    )


async def publish_device_state(
    app: Any, *, guild_id: int, channel_id: int, device_id: int
) -> None:
    """``device_state`` an die Community (gefiltert auf den Standplatz)."""
    manager = getattr(app.state, "connection_manager", None)
    if manager is None:
        return
    zustand, wer = device_state(device_id)
    await manager.publish_guild_event(
        DeviceStateEvent(
            guild_id=str(guild_id),
            channel_id=str(channel_id),
            device_id=str(device_id),
            state=zustand,
            busy_with=wer,
        )
    )


async def end_sessions_for_device(app: Any, device_id: int) -> None:
    """Laufende Fernsteuerungen dieses Geräts abbauen.

    Gerufen, wenn der Standplatz wechselt oder das Gerät entfernt wird: die
    Rechte hingen am alten Kanal beziehungsweise an einer Zeile, die es nicht
    mehr gibt. Derselbe Weg wie bei Rauswurf und Bann
    (``end_remote_sessions_for_member``) — beenden, nicht weiterlaufen lassen.
    """
    manager = getattr(app.state, "connection_manager", None)
    if manager is None:
        return
    socks = _sockets.get(device_id)
    if not socks:
        return
    for sess in manager.remote_sessions_snapshot():
        if sess.host_socket in socks:
            await manager.remote_terminate(sess.session_id, "device_moved")
