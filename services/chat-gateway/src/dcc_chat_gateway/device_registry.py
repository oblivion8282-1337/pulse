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

import logging
from typing import Any

from dcc_shared.events import DeviceChangedEvent, DeviceStateEvent

log = logging.getLogger(__name__)


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
    #: ``device_id`` → der Socket, über den die laufende Fernsteuerung geht.
    #:
    #: **Warum das gemerkt wird** (Bughunt 2026-08-16): die Freigabe der
    #: Belegung suchte das Gerät bisher über ``device_for_socket``. Fällt eine
    #: von MEHREREN Verbindungen des Geräts, ist der Socket beim Aufräumen schon
    #: vergessen — die Suche lief ins Leere, und das Gerät stand für alle
    #: dauerhaft auf „belegt". Bei „belegt" blendet die Oberfläche den
    #: Übernahme-Knopf aus, das Gerät war also unbenutzbar, bis seine App neu
    #: startete. Über diesen Eintrag findet die Freigabe ihr Gerät unabhängig
    #: davon, ob der Socket noch im Register steht — und damit auch unabhängig
    #: von der Reihenfolge der Aufräum-Schritte.
    _device_busy_socket: dict[int, Any]
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
    #: ``device_id`` → die Stream-Plätze, auf denen dieses Gerät gerade sendet.
    #:
    #: **Warum das Gerät es sagen muss und wir es nicht ableiten können:** der
    #: Strom eines Standplatz-Geräts läuft unter dem Konto seines Besitzers, und
    #: im Streaming-Weg gibt es keine Geräte-Kennung (`stream/starten.ts`). Für
    #: jeden anderen Client sieht die Übertragung des Rechners deshalb genauso
    #: aus wie die des Menschen davor.
    #:
    #: Bis 2026-08-16 hat die Oberfläche daraus geraten — *steht ein Gerät
    #: dieses Besitzers im Kanal, gehört ein Strom dieses Kontos dorthin*. Die
    #: Vermutung prüfte nur, OB ein Gerät dort steht, nicht ob es sendet: klickte
    #: der Besitzer an seinem eigenen Rechner auf „Live", wanderte das
    #: LIVE-Abzeichen an den Standplatz, der gar nichts tat, und verschwand bei
    #: dem, der wirklich sendete.
    #:
    #: Wie Zustand und Bildschirme gehört das in lebende Verbindungen und nicht
    #: in eine Spalte: nach einem Absturz löge sie, und zwar Richtung „sendet".
    _device_streams: dict[int, set[int]]

    def _init_device_registry(self) -> None:
        self._device_sockets = {}
        self._device_by_socket = {}
        self._device_busy = {}
        self._device_busy_socket = {}
        self._device_where = {}
        self._device_monitors = {}
        self._device_streams = {}

    # ── Abfragen ────────────────────────────────────────────────────────────

    def device_move(self, device_id: int, guild_id: int, channel_id: int) -> None:
        """Den gemerkten Standplatz eines Geräts nachziehen.

        **Ohne das meldet ein umgestelltes Gerät weiter an den ALTEN Kanal**
        (Bughunt 2026-08-16): Zustand, Steuernder und Bildschirmnamen gingen an
        Leute, die den neuen Standplatz nicht sehen dürfen, und die dort
        Berechtigten bekamen nie eine Meldung — deren Liste behauptete „bereit",
        während der Rechner längst aus war. Geheilt hätte das erst der nächste
        Verbindungsabriss.

        Nur für ein angemeldetes Gerät: von einem, das nie verbunden war, gibt
        es auch nichts zu melden.
        """
        if device_id in self._device_where:
            self._device_where[device_id] = (guild_id, channel_id)

    def device_monitors(self, device_id: int) -> list[dict]:
        """Die gemeldeten Bildschirme eines Geräts (leer, wenn es keine
        gemeldet hat — ältere Client-Fassung oder nie angemeldet)."""
        return self._device_monitors.get(device_id, [])

    def device_streams(self, device_id: int) -> list[int]:
        """Die Plätze, auf denen dieses Gerät gerade sendet (aufsteigend).

        Leer heisst „sendet nicht" — und ebenso „meldet es nicht", also eine
        ältere Client-Fassung. Beides führt zur alten Anzeige (Abzeichen beim
        Menschen), was der harmlosere von zwei Fehlern ist: lieber am Menschen
        als am falschen Rechner.
        """
        return sorted(self._device_streams.get(device_id, ()))

    def device_streams_set(self, device_id: int, slots: set[int]) -> bool:
        """Die sendenden Plätze eines Geräts setzen. ``True`` = geändert.

        Nur für ein angemeldetes Gerät: von einem, das nicht verbunden ist, kann
        auch kein Strom kommen — und ein Eintrag ohne Verbindung bliebe stehen,
        bis jemand ihn zufällig überschreibt.

        Der Rückgabewert entscheidet, ob eine Meldung hinausgeht; ohne ihn
        schickte jeder Neustart eines Streams dieselbe Nachricht erneut.
        """
        if device_id not in self._device_where:
            return False
        alt = self._device_streams.get(device_id, set())
        if alt == slots:
            return False
        if slots:
            self._device_streams[device_id] = slots
        else:
            self._device_streams.pop(device_id, None)
        return True

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

    def device_ids_for_socket(self, socket: Any) -> set[int]:
        """Alle Geräte, die dieser Socket angemeldet hat (leer = kein Gerät).

        Der Unterschied zu :meth:`device_for_socket` ist nicht kosmetisch: die
        Fernsteuerung muss wissen, ob eine Verbindung **überhaupt** ein Gerät
        ist und ob sie das GEMEINTE ist. „Das erste, falls mehrere" beantwortet
        beides falsch, sobald es ein zweites gibt.
        """
        return set(self._device_by_socket.get(socket, ()))

    def device_channel(self, device_id: int) -> int | None:
        """Der Standplatz-Kanal, den dieses Gerät bei der Anmeldung genannt hat
        (``None``, wenn es nie angemeldet war).

        Die Fernsteuerung misst die Kanalwahl des Rufers daran: der Standplatz
        ist der Rechteanker des Geräts, nicht der Kanal, den jemand in seine
        Anfrage schreibt.
        """
        ort = self._device_where.get(device_id)
        return ort[1] if ort is not None else None

    # ── Anmelden und abmelden ───────────────────────────────────────────────

    def _socket_entkoppeln(self, socket: Any, device_id: int) -> None:
        """Den Rückweg ``socket → Geräte`` um dieses Gerät erleichtern.

        Bleibt dabei nichts übrig, fällt der Eintrag ganz weg — sonst wüchse
        die Tabelle mit jeder Verbindung, die je ein Gerät angemeldet hat.
        """
        geraete = self._device_by_socket.get(socket)
        if geraete is None:
            return
        geraete.discard(device_id)
        if not geraete:
            self._device_by_socket.pop(socket, None)

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
        self._socket_entkoppeln(socket, device_id)
        if socks:
            return False
        self._device_sockets.pop(device_id, None)
        # Ein Gerät, das geht, ist nicht mehr belegt. Ohne diese Zeile bliebe
        # die Belegung stehen und das Gerät käme beim nächsten Anmelden sofort
        # als „belegt" zurück — für eine Sitzung, die es nicht mehr gibt.
        self.device_set_busy(device_id, None)
        # Und nicht mehr sendend (Bughunt 2026-08-17): ohne das bleibt
        # `_device_streams` stehen, obwohl der Zustand gerade auf "offline"
        # geht — genau die Luege, die dieses Modul laut seinem eigenen
        # Kommentar an `_device_streams` oben vermeiden soll. Meldet der
        # Besitzer spaeter an seinem EIGENEN Rechner einen Strom auf demselben
        # Platz in diesem Kanal, wandert das LIVE-Abzeichen sonst an das
        # laengst offline gegangene Geraet statt an ihn.
        self._device_streams.pop(device_id, None)
        # Die Bildschirme bleiben stehen: sie sind die letzte bekannte Auskunft
        # über ein Gerät, das gerade offline ist, und beim nächsten Anmelden
        # ohnehin überschrieben. Die Liste zu leeren hiesse, dass die
        # Geräteansicht nach jedem Aus- und Einschalten kurz „ein Bildschirm"
        # behauptet.
        return True

    def device_forget(self, device_id: int) -> None:
        """Alles über ein Gerät vergessen, dessen ZEILE es nicht mehr gibt.

        **Warum das eigens nötig ist** (Bughunt 2026-08-16): ``device_withdraw``
        lässt Standplatz und Bildschirmliste absichtlich stehen — sie sind die
        letzte bekannte Auskunft über ein Gerät, das gerade nur ausgeschaltet
        ist. Für ein GELÖSCHTES Gerät ist genau das falsch: die beiden Einträge
        blieben über die ganze Prozesslaufzeit stehen (ein Leck, das mit jedem
        entfernten Gerät wächst), und jede spätere Zustandsmeldung ginge an
        einen Kanal für eine Kennung, die es nicht mehr gibt.

        Nach dem Melden rufen, nicht davor: ``publish_device_state`` findet
        seinen Kanal über den gemerkten Standplatz.
        """
        for socket in self._device_sockets.pop(device_id, set()):
            self._socket_entkoppeln(socket, device_id)
        self.device_set_busy(device_id, None)
        self._device_where.pop(device_id, None)
        self._device_monitors.pop(device_id, None)
        self._device_streams.pop(device_id, None)

    def device_forget_socket(self, socket: Any) -> list[int]:
        """Alles vergessen, was dieser Socket angemeldet hatte. Liefert die
        Geräte, die damit offline sind. Läuft im Disconnect-Pfad; muss deshalb
        ohne Vorbedingung auskommen und nie werfen."""
        return [
            device_id
            for device_id in list(self._device_by_socket.get(socket, ()))
            if self.device_withdraw(socket, device_id)
        ]

    def device_set_busy(
        self, device_id: int, controller_user_id: str | None, socket: Any = None
    ) -> None:
        """Belegung setzen oder aufheben. ``None`` = wieder bereit.

        ``socket`` ist die Verbindung, über die die Sitzung läuft — an ihr
        findet die Freigabe später ihr Gerät wieder (s. ``_device_busy_socket``).
        """
        if controller_user_id is None:
            self._device_busy.pop(device_id, None)
            self._device_busy_socket.pop(device_id, None)
        else:
            self._device_busy[device_id] = str(controller_user_id)
            if socket is not None:
                self._device_busy_socket[device_id] = socket

    async def device_mark_busy_and_publish(
        self, device_id: int, controller_user_id: str, socket: Any
    ) -> None:
        """``device_set_busy`` + Meldung, fehlertolerant — der eine Weg, über
        den ein angenommener ODER wiederhergestellter Host-Socket seine
        Belegung setzt (Prüferbefund 2026-08-20: stand vorher wortgleich in
        ``ws_remote_handlers.py`` UND ``ws_remote_reconnect.py``).

        Fehlertolerant, weil eine Zustimmung/ein Reclaim nie an einer Anzeige
        hängen darf — der Aufrufer entscheidet selbst, WELCHEN Socket und
        WELCHE ``device_id`` er hier einsetzt (beim Accept über
        ``device_for_socket``, beim Reclaim über die gemerkte
        ``RemoteSession.device_id`` — die beiden Quellen unterscheiden sich
        bewusst, s. Aufrufer)."""
        try:
            self.device_set_busy(device_id, controller_user_id, socket)
            await self.publish_device_state(device_id)
            print(
                f"BUSY-DEBUG: mark Gerät {device_id} durch Nutzer {controller_user_id}",
                flush=True,
            )
        except Exception:  # noqa: BLE001  # pragma: no cover
            log.debug("device busy state not published", exc_info=True)

    # ── Meldungen ───────────────────────────────────────────────────────────

    async def publish_device_change(
        self,
        *,
        guild_id: int,
        channel_id: int,
        device: dict,
        removed: bool,
        moved: bool = False,
    ) -> None:
        """``device_changed`` an die Community (gefiltert auf den Standplatz).

        ``moved`` markiert die Abmeldung an den ALTEN Standplatz beim
        Umstellen — sonst von einem echten Löschen nicht unterscheidbar
        (Prüfbefund K-1, 2026-08-20)."""
        await self.publish_guild_event(
            DeviceChangedEvent(
                guild_id=str(guild_id),
                channel_id=str(channel_id),
                device=device,
                removed=removed,
                moved=moved,
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
                stream_slots=self.device_streams(device_id),
            )
        )

    async def device_release_for_socket(self, socket: Any) -> None:
        """Die Belegung aufheben, die an diesem Socket hing.

        Gerufen aus jedem Ende einer Fernsteuerung. Gesucht wird über
        ``_device_busy_socket`` und **nicht** über das Anmelde-Register: im
        Abbau einer Verbindung ist der Socket dort schon vergessen, und die
        Freigabe liefe genau dann ins Leere, wenn sie am nötigsten ist
        (Bughunt 2026-08-16, Begründung an ``_device_busy_socket``).

        Ist das Gerät mit diesem Socket ganz gegangen, hat ``device_withdraw``
        die Belegung bereits geräumt — dann findet sich hier nichts mehr, und
        das ist richtig so: die „offline"-Meldung ist schon unterwegs.
        """
        device_id = next(
            (d for d, s in self._device_busy_socket.items() if s is socket), None
        )
        # **Der eine Punkt, an dem „wird gesteuert" stehen bleiben kann** — hier
        # findet oder löst sich die Belegung. Beide Ausgänge je eine INFO-Zeile:
        # ein stecken gebliebener „Wird gesteuert"-Text ist ohne diese Spur von
        # außen nicht von einer laufenden Sitzung zu unterscheiden (beobachtet
        # 2026-09-06, P2P-Selbsttest).
        if device_id is None:
            print(
                f"BUSY-DEBUG: release ohne Treffer — offene Belegungen: {list(self._device_busy_socket.keys())}",
                flush=True,
            )
            return
        print(f"BUSY-DEBUG: release Gerät {device_id}", flush=True)
        self.device_set_busy(device_id, None)
        await self.publish_device_state(device_id)

    async def end_remote_sessions_for_device(self, device_id: int) -> None:
        """Laufende Fernsteuerungen dieses Geräts abbauen.

        Gerufen, wenn der Standplatz wechselt oder das Gerät entfernt wird: die
        Rechte hingen am alten Kanal beziehungsweise an einer Zeile, die es
        nicht mehr gibt. Derselbe Weg wie bei Rauswurf und Bann — beenden,
        nicht weiterlaufen lassen.

        **Gesucht wird über die Kennung an der Sitzung, nicht nur über die
        Sockets** (Bughunt 2026-08-16): solange eine Sitzung noch auf die
        Zustimmung wartet, ist ihr ``host_socket`` nur ein Stellvertreter. Eine
        wartende Einladung blieb damit stehen und wurde gleich darauf mit den
        Rechten des ALTEN Standplatzes aktiv. Der Socket-Vergleich bleibt
        daneben stehen: er fängt Sitzungen, die vor dieser Fassung entstanden
        sind oder deren Host sich erst nachträglich als Gerät gemeldet hat.
        """
        socks = self._device_sockets.get(device_id) or set()
        kennung = str(device_id)
        for sess in self.remote_sessions_snapshot():
            if sess.device_id == kennung or sess.host_socket in socks:
                await self.remote_terminate(sess.session_id, "device_moved")
