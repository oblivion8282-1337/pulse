"""In-process Standplatz-Geräte-Register (ConnectionManager-Mixin).

Die Datenbankzeile (``models/devices.py``) sagt, dass es ein Gerät gibt, wem es
gehört und wo es steht. Sie kann nicht sagen, ob es gerade läuft. Das steht
hier, und zwar bewusst **nicht** in einer Spalte: ein Zustandsfeld in der
Datenbank lügt nach jedem Absturz, jedem Stromausfall und jedem Deploy, und zwar
in die gefährliche Richtung — es behauptet „bereit", wo niemand mehr antwortet.

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

## Warum am ConnectionManager und nicht in Redis

Dieselbe Begründung wie bei der Zuschauer-Menge der Watch-Party
(:mod:`watch_registry`), an der sich dieses Modul auch in der Form orientiert:
die Menge hängt an **Sockets**, und Sockets leben in genau einem Prozess. Ein
Redis-Eintrag müsste beim Abriss aufgeräumt werden, und genau das ist der Fall,
in dem der Prozess nicht mehr dazu kommt — ein verwaister „bereit"-Eintrag wäre
wieder die Lüge, die dieses Modul vermeidet. Fährt der Gateway mehrfach, sieht
jeder Prozess seine eigenen Geräte; der Zustand ist dann unvollständig, aber nie
falsch (Geräte fehlen, es erscheint keines, das es nicht gibt).

**Als Mixin und nicht als Modul-Zustand** (Aufräumen 2026-08-16), weil jeder
Rufer den Manager ohnehin in der Hand hält: Routen über
``request.app.state.connection_manager``, WS-Ops über ``ctx``. Modul-Globals
brauchten einen zweiten Weg zur Anwendung, nur um am Ende denselben Manager
wiederzufinden — samt einer Bindung im Lifespan, einem ``reset()`` für Tests
und funktionslokalen Importen aus der Sitzungsverwaltung, um deren Zyklus zu
umgehen. All das entfällt hier.
"""

from __future__ import annotations

from typing import Any

from dcc_shared.events import DeviceChangedEvent, DeviceStateEvent


class _DeviceRegistryMixin:
    """Ergänzt den ConnectionManager um das Geräte-Register. Nicht allein
    verwendbar; ``_init_device_registry()`` einmal im ``__init__`` rufen."""

    #: ``device_id`` → die Sockets, die dieses Gerät angemeldet haben.
    #:
    #: Eine MENGE und keine einzelne Verbindung: der Client eines Geräts kann
    #: mehrere Fenster offen haben, und eines davon zu schliessen darf das
    #: Gerät nicht offline melden.
    _device_sockets: dict[int, set[Any]]
    #: ``socket`` → die Geräte, die er angemeldet hat. Der Rückweg für den
    #: Abriss: beim Trennen ist nur der Socket bekannt.
    _device_by_socket: dict[Any, set[int]]
    #: ``device_id`` → Kennung des Steuernden, solange eine Fernsteuerung läuft.
    _device_busy: dict[int, str]
    #: ``device_id`` → ``(guild_id, channel_id)``, beim Anmelden mitgegeben.
    #:
    #: **Gemerkt statt nachgeschlagen:** der Zustand ändert sich auch an
    #: Stellen, die keine Datenbanksitzung haben und keine haben sollten — im
    #: Abbau einer Verbindung und beim Ende einer Fernsteuerung. Eine Abfrage
    #: dort hiesse, dass eine Meldung an einer Datenbank hängt, die vielleicht
    #: gerade nicht antwortet; der Eintrag hier kostet zwei Zahlen je Gerät.
    _device_where: dict[int, tuple[int, int]]
    #: ``device_id`` → die Bildschirme, die das Gerät beim Anmelden gemeldet hat.
    #:
    #: **Warum nicht in der Datenbank:** Bildschirme werden umgesteckt,
    #: abgeschaltet und dazugehängt. Eine Spalte wäre nach dem ersten
    #: Umstecken falsch, und zwar ohne dass es jemand merkt — dieselbe
    #: Begründung wie beim Zustand. Der Steuernde braucht die Liste, um „Monitor
    #: 2 dazuschalten" überhaupt anbieten zu können.
    _device_monitors: dict[int, list[dict]]

    def _init_device_registry(self) -> None:
        self._device_sockets = {}
        self._device_by_socket = {}
        self._device_busy = {}
        self._device_where = {}
        self._device_monitors = {}

    # ── Abfragen ────────────────────────────────────────────────────────────

    def device_monitors(self, device_id: int) -> list[dict]:
        """Die gemeldeten Bildschirme eines Geräts (leer, wenn es keine
        gemeldet hat — ältere Client-Fassung oder nie angemeldet)."""
        return self._device_monitors.get(device_id, [])

    def device_state(self, device_id: int) -> tuple[str, str | None]:
        """``("ready" | "busy" | "offline", wer_steuert)``.

        Reine Abfrage ohne Nebenwirkung, damit sie aus jeder Route heraus
        gerufen werden kann.
        """
        if not self._device_sockets.get(device_id):
            return "offline", None
        wer = self._device_busy.get(device_id)
        return ("busy", wer) if wer else ("ready", None)

    def device_sockets(self, device_id: int) -> set[Any]:
        """Die Verbindungen eines angemeldeten Geräts — der Weg, auf dem ein
        Weckruf hinkommt. Eine Kopie, damit der Aufrufer über sie laufen kann,
        während sich das Register unter ihm ändert (ein Fenster geht zu)."""
        return set(self._device_sockets.get(device_id, ()))

    def device_for_socket(self, socket: Any) -> int | None:
        """Welches Gerät dieser Socket angemeldet hat (das erste, falls
        mehrere).

        Der Fernsteuer-Weg braucht das, um eine Sitzung dem Gerät zuzuordnen:
        die Anfrage nennt den Host als NUTZER, und erst hier wird daraus ein
        Gerät.
        """
        geraete = self._device_by_socket.get(socket)
        return next(iter(geraete)) if geraete else None

    # ── Anmelden und abmelden ───────────────────────────────────────────────

    def device_announce(
        self,
        socket: Any,
        device_id: int,
        guild_id: int,
        channel_id: int,
        monitors: list[dict] | None = None,
    ) -> bool:
        """Ein Gerät meldet sich an. ``True``, wenn es damit NEU online ist (nur
        dann muss gemeldet werden — ein zweites Fenster ändert nichts)."""
        self._device_where[device_id] = (guild_id, channel_id)
        # Eine leere Liste NICHT übernehmen: eine ältere Client-Fassung meldet
        # gar keine Bildschirme, und die zuletzt bekannten sind dann die
        # bessere Auskunft als „hat keine".
        if monitors:
            self._device_monitors[device_id] = monitors
        socks = self._device_sockets.setdefault(device_id, set())
        war_leer = not socks
        socks.add(socket)
        self._device_by_socket.setdefault(socket, set()).add(device_id)
        return war_leer

    def device_withdraw(self, socket: Any, device_id: int) -> bool:
        """Eine Anmeldung zurücknehmen. ``True``, wenn das Gerät offline ist."""
        socks = self._device_sockets.get(device_id)
        if socks is None:
            return False
        socks.discard(socket)
        geraete = self._device_by_socket.get(socket)
        if geraete is not None:
            geraete.discard(device_id)
            if not geraete:
                self._device_by_socket.pop(socket, None)
        if socks:
            return False
        self._device_sockets.pop(device_id, None)
        # Ein Gerät, das geht, ist nicht mehr belegt. Ohne diese Zeile bliebe
        # die Belegung stehen und das Gerät käme beim nächsten Anmelden sofort
        # als „belegt" zurück — für eine Sitzung, die es nicht mehr gibt.
        self._device_busy.pop(device_id, None)
        # Die Bildschirme bleiben stehen: sie sind die letzte bekannte Auskunft
        # über ein Gerät, das gerade offline ist, und beim nächsten Anmelden
        # ohnehin überschrieben. Die Liste zu leeren hiesse, dass die
        # Geräteansicht nach jedem Aus- und Einschalten kurz „ein Bildschirm"
        # behauptet.
        return True

    def device_forget_socket(self, socket: Any) -> list[int]:
        """Alles vergessen, was dieser Socket angemeldet hatte. Liefert die
        Geräte, die damit offline sind. Läuft im Disconnect-Pfad; muss deshalb
        ohne Vorbedingung auskommen und nie werfen."""
        return [
            device_id
            for device_id in list(self._device_by_socket.get(socket, ()))
            if self.device_withdraw(socket, device_id)
        ]

    def device_set_busy(self, device_id: int, controller_user_id: str | None) -> None:
        """Belegung setzen oder aufheben. ``None`` = wieder bereit."""
        if controller_user_id is None:
            self._device_busy.pop(device_id, None)
        else:
            self._device_busy[device_id] = str(controller_user_id)

    # ── Meldungen ───────────────────────────────────────────────────────────

    async def publish_device_change(
        self, *, guild_id: int, channel_id: int, device: dict, removed: bool
    ) -> None:
        """``device_changed`` an die Community (gefiltert auf den Standplatz)."""
        await self.publish_guild_event(
            DeviceChangedEvent(
                guild_id=str(guild_id),
                channel_id=str(channel_id),
                device=device,
                removed=removed,
            )
        )

    async def publish_device_state(self, device_id: int) -> None:
        """``device_state`` an die Community (gefiltert auf den Standplatz).

        Still, wenn der Standplatz nicht bekannt ist — dann war das Gerät nie
        angemeldet, und es gibt niemanden, dem die Auskunft nützt.
        """
        ort = self._device_where.get(device_id)
        if ort is None:
            return
        guild_id, channel_id = ort
        zustand, wer = self.device_state(device_id)
        await self.publish_guild_event(
            DeviceStateEvent(
                guild_id=str(guild_id),
                channel_id=str(channel_id),
                device_id=str(device_id),
                state=zustand,
                busy_with=wer,
                monitors=self.device_monitors(device_id),
            )
        )

    async def device_release_for_socket(self, socket: Any) -> None:
        """Die Belegung aufheben, die an diesem Socket hing.

        Gerufen aus jedem Ende einer Fernsteuerung. Der Socket ist die einzige
        Zuordnung, die dort sicher vorliegt: die Sitzung kennt ihren Host als
        Verbindung, und erst hier wird daraus ein Gerät.

        Im Abbau einer Verbindung läuft das ins Leere, und zwar mit Absicht:
        dort wird das Gerät zuerst vergessen (``ws_ops``), sodass hier kein
        Gerät mehr zu diesem Socket gehört. Sonst ginge ein „wieder bereit"
        hinaus, dem eine Millisekunde später „offline" folgt — und dazwischen
        stünde das Gerät als frei übernehmbar in der Liste.
        """
        device_id = self.device_for_socket(socket)
        if device_id is None or device_id not in self._device_busy:
            return
        self.device_set_busy(device_id, None)
        await self.publish_device_state(device_id)

    async def end_remote_sessions_for_device(self, device_id: int) -> None:
        """Laufende Fernsteuerungen dieses Geräts abbauen.

        Gerufen, wenn der Standplatz wechselt oder das Gerät entfernt wird: die
        Rechte hingen am alten Kanal beziehungsweise an einer Zeile, die es
        nicht mehr gibt. Derselbe Weg wie bei Rauswurf und Bann — beenden,
        nicht weiterlaufen lassen.
        """
        socks = self._device_sockets.get(device_id)
        if not socks:
            return
        for sess in self.remote_sessions_snapshot():
            if sess.host_socket in socks:
                await self.remote_terminate(sess.session_id, "device_moved")
