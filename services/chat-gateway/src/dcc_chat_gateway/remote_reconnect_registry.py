"""Fernsteuerung — Gnadenfrist nach einem Verbindungsabriss (ConnectionManager
mixin).

**Warum es das gibt** (Bughunt 2026-08-19). ``cleanup_remote_on_disconnect``
beendete bis dahin jede laufende Sitzung, sobald der Socket EINER Seite
abriss — sofort, ohne Ausnahme, dokumentiert als bewusster Unterschied zur
Watch-Party ("no grace window (unlike watch parties)"). Auf dem gemeinsamen
Remote-Dev-Stack (Electron -> lokales Vite als Umweg -> Internet -> Hetzner)
reisst ein Socket alle paar Minuten ab, unabhaengig vom eigentlichen
Fehlerbild: jeder Backend-Sync auf dem Stack laedt ``uvicorn --reload`` neu und
trennt dabei JEDEN angeschlossenen Socket, gemessen bis zu 8 s bei zwei
Reload-Laeufen kurz hintereinander. Eine echte, funktionierende Sitzung starb
an genau so einem Wackler nach 37 Sekunden.

**Die Gnadenfrist gilt nur fuer eine bereits ANGENOMMENE Sitzung**
(``state == "active"``). Eine noch wartende hat auf der Gegenseite nur einen
Zustimmungsdialog, keine Uebertragung, die es zu retten gaebe — die stirbt wie
bisher sofort mit dem Socket, der sie trug (``ws_remote_teardown.py``
entscheidet das).

Getrennt von :mod:`remote_registry`, weil das schon an der Groessen-Grenze lag
(338 von 350 Zeilen, PLAN.md §12.1) — dieselbe Begruendung wie die Aufteilung
in ``ws_remote_handlers``/``ws_remote_teardown``/``ws_remote_input``.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger(__name__)

# Wie lange eine Sitzung nach einem Abriss noch auf ein `remote_reclaim` der
# betroffenen Seite wartet, bevor sie wie bisher beendet wird.
#
# **Muss unter der Client-Frist bleiben**
# (`web/src/lib/remote/gnadenfrist.ts::CLIENT_GRACE_MS`, Vorgabe 12 s) — ein
# Test dort haelt die Beziehung fest. Gaebe der Server zuerst auf, koennte ein
# `remote_reclaim` ins Leere laufen, obwohl der Client seinerseits noch
# gewartet haette.
#
# **10 s statt der 30 s der Watch-Party**: eine vom Steuernden gehaltene Taste
# bleibt am Host bis zum Ablauf der Frist woertlich gedrueckt, wenn ausgerechnet
# er die Verbindung verliert und nicht wiederkommt — das ist der Preis jeder
# Gnadenfrist hier, nicht nur dieser. 10 s decken den am 2026-08-19 gemessenen
# schlimmsten Fall (zwei `uvicorn --reload`-Laeufe kurz hintereinander, 8 s bis
# zum Reconnect) mit Rand, ohne die Taste unnoetig lang haengen zu lassen.
REMOTE_DISCONNECT_GRACE_S = float(os.environ.get("REMOTE_DISCONNECT_GRACE_S", "10"))


class _RemoteReconnectMixin:
    """Ergaenzt die Gnadenfrist-Buchfuehrung um ``ConnectionManager``. Braucht
    ``self._remote_sessions``, ``self._lock`` (beide aus
    :class:`~dcc_chat_gateway.remote_registry._RemoteRegistryMixin`). Einmal
    ``_init_remote_reconnect()`` im ``__init__`` rufen."""

    # Von `_RemoteRegistryMixin` bereitgestellt — nur fuer Type-Checker.
    _remote_sessions: dict[str, Any]
    _lock: asyncio.Lock

    # session_id -> (Rolle, die abgerissen ist, Ablauf-Task).
    _remote_disconnect_timers: dict[str, tuple[str, asyncio.Task[Any]]]

    def _init_remote_reconnect(self) -> None:
        self._remote_disconnect_timers = {}

    def remote_schedule_disconnect_grace(
        self,
        session_id: str,
        role: str,
        on_expired: Callable[[str, str], Awaitable[None]],
        *,
        delay: float | None = None,
    ) -> None:
        """Gnadenfrist scharfstellen, nachdem der Socket von ``role`` ("host"
        oder "controller") in dieser Sitzung abgerissen ist.

        **Wiederholt sich derselbe Abriss, bevor die alte Frist ablief, faengt
        sie NEU an** (idempotent je Sitzung, wie
        ``remote_registry.remote_schedule_timeout``) — eine flatternde
        Verbindung bekommt so bei jedem Versuch die volle Frist, nicht eine
        schrumpfende. Genau das im Log vom 2026-08-19 beobachtete Muster
        (mehrere Abrisse binnen Sekunden)."""
        if delay is None:
            delay = REMOTE_DISCONNECT_GRACE_S
        self.remote_cancel_disconnect_grace(session_id)
        task = asyncio.create_task(
            self._disconnect_grace_expired(session_id, role, on_expired, delay)
        )
        self._remote_disconnect_timers[session_id] = (role, task)

    def remote_cancel_disconnect_grace(
        self, session_id: str, *, role: str | None = None
    ) -> None:
        """Eine laufende Frist abbrechen (erfolgreicher Reclaim, oder die
        Sitzung endet aus einem anderen Grund). Mit ``role`` nur abbrechen,
        wenn die Frist wirklich fuer DIESE Rolle laeuft — sonst koennte ein
        Reclaim der falschen Seite die Frist der anderen wegnehmen."""
        entry = self._remote_disconnect_timers.get(session_id)
        if entry is None:
            return
        if role is not None and entry[0] != role:
            return
        entry[1].cancel()
        self._remote_disconnect_timers.pop(session_id, None)

    def remote_disconnect_grace_role(self, session_id: str) -> str | None:
        """Welche Rolle gerade innerhalb ihrer Gnadenfrist fehlt, oder
        ``None`` (keine laufende Frist — die Sitzung ist entweder vollstaendig
        verbunden oder laengst beendet). ``remote_reclaim`` prueft daran, dass
        ein Steuernder nicht die Gnadenfrist des Hosts fuer sich beanspruchen
        kann und umgekehrt."""
        entry = self._remote_disconnect_timers.get(session_id)
        return entry[0] if entry is not None else None

    async def _disconnect_grace_expired(
        self,
        session_id: str,
        role: str,
        on_expired: Callable[[str, str], Awaitable[None]],
        delay: float,
    ) -> None:
        try:
            await asyncio.sleep(delay)
            # Zwischenzeitlich reklamiert (oder ein NEUERER Abriss derselben
            # Rolle hat die Uhr neu gestellt, s. `remote_schedule_disconnect_
            # grace`)? Dann ist DIESER Task nicht mehr der aktuelle Zeitgeber
            # der Sitzung — pruefen VOR dem Abbau, sonst reisst ein spaet
            # auslösender Timer eine laengst wiederhergestellte Sitzung doch
            # noch ab. Gleiches Muster wie
            # `remote_registry._remote_timeout`/`watch_registry.
            # _host_end_after_grace`.
            entry = self._remote_disconnect_timers.get(session_id)
            if entry is None or entry[1] is not asyncio.current_task():
                return
            await on_expired(session_id, role)
        finally:
            entry = self._remote_disconnect_timers.get(session_id)
            if entry is not None and entry[1] is asyncio.current_task():
                self._remote_disconnect_timers.pop(session_id, None)

    async def remote_reclaim(
        self, session_id: str, role: str, user_id: str, new_socket: Any
    ) -> Any | None:
        """Der Socket von ``role`` ist zurueck — der Sitzung den neuen Socket
        geben, WENN sie noch innerhalb ihrer Gnadenfrist fuer genau diese
        Rolle und genau diesen Nutzer ist.

        Liefert die (jetzt wieder vollstaendige) ``RemoteSession`` bei Erfolg,
        sonst ``None`` — Sitzung weg, falsche Rolle/falscher Nutzer, oder die
        Frist ist schon abgelaufen. Der Aufrufer behandelt jeden dieser Faelle
        gleich: Reclaim gescheitert, der normale Abbau uebernimmt (der laeuft
        ohnehin schon als Zeitgeber, s. oben)."""
        async with self._lock:
            sess = self._remote_sessions.get(session_id)
            if sess is None:
                return None
            erwarteter_nutzer = (
                sess.host_user_id if role == "host" else sess.controller_user_id
            )
            if erwarteter_nutzer != str(user_id):
                return None
            if self.remote_disconnect_grace_role(session_id) != role:
                return None
            if role == "host":
                sess.host_socket = new_socket
            else:
                sess.controller_socket = new_socket
        self.remote_cancel_disconnect_grace(session_id, role=role)
        return sess
