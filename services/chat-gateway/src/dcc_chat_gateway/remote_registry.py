"""In-process remote-control signaling registry (ConnectionManager mixin).

Pulse-Fernsteuerung ("remote control"): a member with ``REMOTE_CONTROL`` may
*ask* to drive another member's machine. This mixin holds the tiny amount of
session state the gateway needs: which two sockets belong to a session and
whether the host has consented yet.

The gateway is the **consent gate** plus the relay for the two things that
travel over the app WebSocket: SDP/ICE signalling (kept for the P2P fallback)
and the input frames (``remote_input``, wire format in
``docs/plans/2026-08-12-input-wire-protokoll-v2.md``). Video never touches the
gateway — it rides the existing HQ-stream path.

Single writer (the gateway itself) → no Redis, no TTL: like ``watch_registry``
this state is only ever read/written on the pod both sockets live on. v1 is
**single-pod** — both peers must be connected to the same gateway instance
(guaranteed today; a multi-pod deployment would need a Redis relay to forward
SDP/ICE and input across pods). Exactly **one** session per host *and device*
at a time (``device_id is None`` = der Mensch selbst, also ebenfalls eine).

``host_socket`` at ``remote_create`` time is a *representative* of the host's
sockets (a user may have several tabs open). ``remote_request`` fans the invite
out to every host socket that may see it (``routes.ws_remote_geraet`` sorts die
Geraete-Verbindungen aus, die nicht gemeint sind), and ``remote_respond``
overwrites ``host_socket`` with the socket the host actually accepted from —
that is the authoritative peer for signal forwarding.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

# Pending consent auto-expires: if the host neither accepts nor declines within
# this window the session is dropped and the controller is told ``timeout``.
REMOTE_PENDING_TIMEOUT_S = 30.0

# Sperrfrist, bevor derselbe Steuernde denselben Host erneut anklingeln darf.
# Ausgeloest von Absage UND Zeitablauf: ohne sie kostet ein "Nein" nichts, und
# ein Berechtigter kann dem Host beliebig viele Zustimmungsdialoge vor die Nase
# setzen (der Dialog ist modal — das ist eine Belaestigung, kein Randfall).
# Gleiche Laenge wie die Zustimmungsfrist: ein abgelehnter Anlauf kostet den
# Steuernden genau so viel Wartezeit wie ein unbeantworteter.
REMOTE_DECLINE_COOLDOWN_S = 30.0


def _now_ms() -> int:
    return int(time.time() * 1000)


async def send_to_socket(socket: Any, payload: dict[str, Any]) -> None:
    """Best-effort ``send_json`` to one socket. Swallows any error — a peer that
    just vanished must not abort the caller (the disconnect path cleans it up)."""
    try:
        await socket.send_json(payload)
    except Exception:  # noqa: BLE001
        log.debug("remote: send_to_socket failed (peer gone?)", exc_info=True)


@dataclass
class RemoteSession:
    session_id: str
    channel_id: str
    host_user_id: str
    host_socket: Any
    controller_user_id: str
    controller_socket: Any
    #: Das Standplatz-Geraet, dem diese Sitzung gilt (``None`` = ein Mensch).
    #:
    #: Traegt zwei Dinge: die Eindeutigkeit (s. ``remote_create``) und den
    #: Abbau beim Umstellen/Loeschen des Geraets — der fand eine noch WARTENDE
    #: Sitzung ueber den ``host_socket`` nicht, weil der bis zur Zustimmung nur
    #: ein Stellvertreter ist (Bughunt 2026-08-16).
    device_id: str | None = None
    state: str = "pending"  # "pending" until the host accepts, then "active"
    created_at: int = field(default_factory=_now_ms)

    def age_s(self, *, now_ms: int | None = None) -> float:
        """Seconds since the session was created. Read by the periodic rights
        audit for the absolute session cap — a consent is agreement to *one*
        session, not a standing permission, and a forgotten tab must not stay
        drivable overnight."""
        return ((now_ms if now_ms is not None else _now_ms()) - self.created_at) / 1000.0


class _RemoteRegistryMixin:
    """Adds the remote-control session registry to ConnectionManager. Requires
    ``self._lock`` (asyncio.Lock) and ``self._user_conns`` on the host class.
    Call ``_init_remote_registry()`` once in the host ``__init__``."""

    _remote_sessions: dict[str, RemoteSession]
    _remote_timers: dict[str, asyncio.Task[Any]]
    # (host_user_id, controller_user_id) → monotonic ts of the last refusal.
    _remote_declines: dict[tuple[str, str], float]
    # Provided by ConnectionManager — declared here for type-checkers only.
    _user_conns: dict[int, set[Any]]
    _ws_user: dict[Any, Any]
    _lock: asyncio.Lock

    def _init_remote_registry(self) -> None:
        self._remote_sessions = {}
        self._remote_timers = {}
        self._remote_declines = {}

    def remote_user_sockets(self, user_id: int | str) -> list[Any]:
        """Every open socket of ``user_id`` (empty ⇒ user is offline)."""
        socks = self._user_conns.get(int(user_id))
        return list(socks) if socks else []

    async def remote_create(
        self,
        channel_id: str,
        host_user_id: str,
        host_socket: Any,
        controller_user_id: str,
        controller_socket: Any,
        device_id: str | None = None,
    ) -> RemoteSession | None:
        """Create a pending session. Returns ``None`` when the same host+device
        already has a pending/active session.

        **Eindeutig je (Host, Geraet), nicht je Host** (Bughunt 2026-08-16):
        Standplatz-Geraete haengen alle am Konto ihres Besitzers, und ein
        Besitzer darf zehn davon je Community haben. Mit „genau eine Sitzung je
        Host-KONTO" blockierte die Uebernahme des Werkstatt-PCs jede Uebernahme
        des Lager-PCs desselben Besitzers — mit 4054, waehrend das zweite Geraet
        in der Liste als „bereit" stand. Fuer einen menschlichen Host
        (``device_id is None``) bleibt es bei genau einer Sitzung: dort ist es
        derselbe Bildschirm und dieselbe Tastatur."""
        async with self._lock:
            hid = str(host_user_id)
            did = str(device_id) if device_id else None
            for sess in self._remote_sessions.values():
                if sess.host_user_id == hid and sess.device_id == did:
                    return None
            session_id = secrets.token_hex(8)
            sess = RemoteSession(
                session_id=session_id,
                channel_id=str(channel_id),
                host_user_id=hid,
                host_socket=host_socket,
                controller_user_id=str(controller_user_id),
                controller_socket=controller_socket,
                device_id=did,
            )
            self._remote_sessions[session_id] = sess
            return sess

    async def remote_activate(self, session_id: str) -> bool:
        """Activate a session — but only the FIRST pending→active transition wins.
        Returns ``False`` if the session vanished OR is already active, so a
        second host tab accepting the same invite can't hijack an established
        session (its ``host_socket``/signalling path stays with the tab that
        accepted first)."""
        async with self._lock:
            sess = self._remote_sessions.get(session_id)
            if sess is None or sess.state != "pending":
                return False
            sess.state = "active"
            return True

    def remote_get(self, session_id: str) -> RemoteSession | None:
        return self._remote_sessions.get(session_id)

    def remote_sessions_snapshot(self) -> list[RemoteSession]:
        """Copy of every current session. The periodic rights audit terminates
        sessions *while* walking them — iterating the live dict would raise."""
        return list(self._remote_sessions.values())

    def remote_socket_user(self, socket: Any) -> Any | None:
        """The ``AuthenticatedUser`` behind a peer socket, or ``None`` once the
        socket is gone. The rights audit needs the whole object, not the id: the
        permission resolver reads ``is_admin``/``is_owner`` off it, and the
        bearer token is consumed at connect time — it cannot be re-decoded."""
        return self._ws_user.get(socket)

    def remote_user_has_session(self, user_id: int | str) -> bool:
        """Is ``user_id`` a peer (host or controller) of any current session?

        **Kein Produktivaufrufer im Gateway.** Hier stand, das gate die Ausgabe
        von TURN-Zugangsdaten — das tut es nicht: die TURN-Route liegt auf
        ``feat/remote-control-windows`` (P2P-Zweig) und ist von hier aus nicht
        sichtbar. Behauptung berichtigt statt Methode geloescht, damit der
        P2P-Zweig beim Zusammenfuehren seinen Gate wiederfindet."""
        uid = str(user_id)
        return any(
            sess.host_user_id == uid or sess.controller_user_id == uid
            for sess in self._remote_sessions.values()
        )

    async def remote_end(self, session_id: str) -> RemoteSession | None:
        """Remove the session and return it (or ``None`` if already gone), so
        the caller can notify the other peer.

        **Der eine Trichter**, durch den jede Sitzung verschwindet — deshalb
        haengt hier auch die Freigabe des Standplatz-Geraets: war der Host ein
        eingetragenes Geraet, steht es danach wieder als „bereit" in der Liste.
        Ausserhalb der Sperre, weil die Meldung an fremde Sockets nichts in der
        Registry zu suchen hat; und fehlertolerant, weil ein Ende nie an einer
        Anzeige haengen darf."""
        async with self._lock:
            sess = self._remote_sessions.pop(session_id, None)
        if sess is not None:
            try:
                await self.device_release_for_socket(sess.host_socket)
            except Exception:  # noqa: BLE001  # pragma: no cover
                log.debug("device release failed", exc_info=True)
        return sess

    async def remote_end_if_pending(self, session_id: str) -> RemoteSession | None:
        """Atomically pop a session only if it is still ``pending``. Returns the
        removed session, or ``None`` if it is already active or gone. Lets a
        decline race safely against a concurrent accept — a decline can never
        tear down a session another host tab just activated (mirror of
        ``remote_activate``, which only lets the first pending→active win)."""
        async with self._lock:
            sess = self._remote_sessions.get(session_id)
            if sess is None or sess.state != "pending":
                return None
            return self._remote_sessions.pop(session_id)

    async def remote_dismiss_host_tabs(
        self, sess: RemoteSession, *, answered: Any = None
    ) -> None:
        """Tell every host tab except ``answered`` to drop the pending consent
        prompt for this session.

        **Jeder** Abbauweg einer noch wartenden Sitzung muss hier vorbeikommen.
        Das Frontend verwirft bei ``phase != 'idle'`` jede weitere Einladung
        still — bleibt also ein Dialog stehen, ist der Host danach fuer ALLE
        unerreichbar, und sein spaeteres "Zulassen" laeuft ins Leere (4053, weil
        die Sitzung laengst weg ist). Wohnt in der Registry, nicht im Handler,
        weil auch der Zeitgeber ihn braucht und der keinen Handler kennt."""
        frame = {"op": "remote_canceled", "session_id": sess.session_id}
        for hs in self.remote_user_sockets(sess.host_user_id):
            if hs is not answered:
                await send_to_socket(hs, frame)

    async def _remote_notify_ended(self, sess: RemoteSession, reason: str) -> None:
        """Tell both sides that ``sess`` is over: the controller always gets
        ``remote_ended``; the host gets it only when the session was live. While
        it was still pending the host has a *dialog*, not a session — the frame
        that clears a dialog is ``remote_canceled``, and it has to reach every
        tab, not just the representative socket."""
        frame = {"op": "remote_ended", "session_id": sess.session_id, "reason": reason}
        await send_to_socket(sess.controller_socket, frame)
        if sess.state == "active":
            await send_to_socket(sess.host_socket, frame)
        else:
            await self.remote_dismiss_host_tabs(sess)

    async def remote_terminate(self, session_id: str, reason: str) -> RemoteSession | None:
        """Drop a session from the outside (rights revoked, kick, ban, age) and
        notify both peers. Returns the removed session, or ``None`` if it was
        already gone. One entry point so an externally-forced teardown can never
        forget the timer or a host tab."""
        self.remote_cancel_timeout(session_id)
        removed = await self.remote_end(session_id)
        if removed is None:
            return None
        await self._remote_notify_ended(removed, reason)
        return removed

    def remote_note_refused(self, host_user_id: str, controller_user_id: str) -> None:
        """Start the re-invite cooldown for this (host, controller) pair after a
        decline or an unanswered invite."""
        now = time.monotonic()
        # Abgelaufene Paare beim Schreiben wegraeumen — ohne das waechst die
        # Tabelle mit jedem abgelehnten Paar und wird nie wieder kleiner.
        for key, ts in list(self._remote_declines.items()):
            if now - ts >= REMOTE_DECLINE_COOLDOWN_S:
                del self._remote_declines[key]
        self._remote_declines[(str(host_user_id), str(controller_user_id))] = now

    def remote_refusal_wait_s(self, host_user_id: str, controller_user_id: str) -> float:
        """Seconds left on the cooldown for this pair (0.0 = may ask again)."""
        ts = self._remote_declines.get((str(host_user_id), str(controller_user_id)))
        if ts is None:
            return 0.0
        left = REMOTE_DECLINE_COOLDOWN_S - (time.monotonic() - ts)
        return left if left > 0 else 0.0

    def remote_sessions_for_socket(self, socket: Any) -> list[RemoteSession]:
        """Sessions in which ``socket`` is either peer — for disconnect cleanup."""
        return [
            sess
            for sess in list(self._remote_sessions.values())
            if sess.host_socket is socket or sess.controller_socket is socket
        ]

    def remote_schedule_timeout(
        self, session_id: str, controller_socket: Any, *, delay: float | None = None
    ) -> None:
        """Arm the pending-consent auto-expiry. Idempotent per session."""
        if delay is None:
            delay = REMOTE_PENDING_TIMEOUT_S
        self.remote_cancel_timeout(session_id)
        self._remote_timers[session_id] = asyncio.create_task(
            self._remote_timeout(session_id, controller_socket, delay)
        )

    def remote_cancel_timeout(self, session_id: str) -> None:
        task = self._remote_timers.pop(session_id, None)
        if task is not None:
            task.cancel()

    async def _remote_timeout(
        self, session_id: str, controller_socket: Any, delay: float
    ) -> None:
        """Expire an unanswered invite.

        ``controller_socket`` bleibt in der Signatur (der Aufrufer hat sie beim
        Scharfstellen ohnehin zur Hand); benachrichtigt wird ueber die Sitzung,
        damit der Zeitablauf denselben Abbauweg nimmt wie jeder andere — der
        Steuernde erfaehrt ``timeout``, und die Zustimmungsdialoge des Hosts
        werden abgeraeumt."""
        try:
            await asyncio.sleep(delay)
            # Atomar statt lesen-dann-pruefen: zwischen einem `remote_get` und
            # dem naechsten `await` kann ein Accept gewinnen. Der Zeitgeber haette
            # dann eine LAUFENDE Sitzung entfernt und dem Steuernden "timeout"
            # gemeldet, waehrend der Host sich gesteuert glaubt.
            removed = await self.remote_end_if_pending(session_id)
            if removed is None:
                return  # already accepted or ended
            # Auch das Aussitzen ist eine Absage — ohne Sperrfrist waere der
            # Zeitablauf der billigste Weg, den Dialog erneut aufzuziehen.
            self.remote_note_refused(removed.host_user_id, removed.controller_user_id)
            await self._remote_notify_ended(removed, "timeout")
        finally:
            if self._remote_timers.get(session_id) is asyncio.current_task():
                self._remote_timers.pop(session_id, None)
