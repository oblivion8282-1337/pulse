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

**Die Frist haengt am Paar (Sitzung, Rolle), nicht an der Sitzung allein**
(Bughunt 2026-08-19, zweite Runde — unabhaengig von zwei Pruefe gefunden). Bei
``uvicorn --reload`` reissen IMMER beide Rollen gleichzeitig, nicht nur eine.
Eine einzige Frist je Sitzung hiess: der zweite Abriss ueberschrieb die Frist
des ersten, der Reclaim der ueberschriebenen Rolle scheiterte mit "no grace
window for this role", und der Client behandelte das als endgueltig — die
Sitzung starb SCHNELLER als vor der Gnadenfrist. Deshalb ist der Schluessel
unten ``tuple[session_id, role]``: beide Rollen koennen gleichzeitig und
unabhaengig voneinander in Gnadenfrist stehen.

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

# Schluessel eines Zeitgebers: (Sitzung, die abgerissene Rolle). ZWEI Rollen
# koennen gleichzeitig eigene Fristen halten (s. Moduldoc).
_GraceKey = tuple[str, str]


class _RemoteReconnectMixin:
    """Ergaenzt die Gnadenfrist-Buchfuehrung um ``ConnectionManager``. Braucht
    ``self._remote_sessions``, ``self._lock`` (beide aus
    :class:`~dcc_chat_gateway.remote_registry._RemoteRegistryMixin`). Einmal
    ``_init_remote_reconnect()`` im ``__init__`` rufen."""

    # Von `_RemoteRegistryMixin` bereitgestellt — nur fuer Type-Checker.
    _remote_sessions: dict[str, Any]
    _lock: asyncio.Lock

    _remote_disconnect_timers: dict[_GraceKey, asyncio.Task[Any]]

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

        **Wirkt nur auf die Frist DIESER Rolle** — reisst kurz danach die
        ANDERE Rolle ebenfalls ab (der Regelfall bei `uvicorn --reload`, das
        beide Sockets gleichzeitig trennt), bleibt deren eigene Frist
        unberuehrt stehen. Vor 2026-08-19 (zweite Runde) loeschte ein
        rollenloser Abbruch hier die Frist der ANDEREN Rolle mit — das genaue
        Gegenteil der Absicht.

        **Wiederholt sich derselbe Abriss DERSELBEN Rolle, bevor ihre alte
        Frist ablief, faengt sie NEU an** (idempotent je (Sitzung, Rolle)) —
        eine flatternde Verbindung bekommt so bei jedem Versuch die volle
        Frist, nicht eine schrumpfende."""
        if delay is None:
            delay = REMOTE_DISCONNECT_GRACE_S
        self.remote_cancel_disconnect_grace(session_id, role=role)
        key = (session_id, role)
        task = asyncio.create_task(
            self._disconnect_grace_expired(session_id, role, on_expired, delay)
        )
        self._remote_disconnect_timers[key] = task

    def remote_cancel_disconnect_grace(
        self, session_id: str, *, role: str | None = None
    ) -> None:
        """Eine laufende Frist abbrechen.

        Mit ``role`` nur die Frist DIESER Rolle (erfolgreicher Reclaim, oder
        ein neuer Abriss derselben Rolle ersetzt seine eigene alte Frist).
        Ohne ``role`` BEIDE — der Aufruf, den `remote_end` fuer JEDEN
        Abbauweg macht (Sitzung weg heisst: keine Frist mehr sinnvoll, gleich
        welcher Rolle).

        **Storniert NIE den eigenen, gerade laufenden Task** (CI-Befund
        2026-08-20, deterministischer Haenger in `test_remote_disconnect_
        notifies_peer`): laeuft die Gnadenfrist ab, ruft `_disconnect_grace_
        expired` ueber `on_expired` irgendwann `remote_end` — und `remote_end`
        raeumt seinerseits JEDE Frist der Sitzung auf, auch die eigene, gerade
        noch laufende. Ohne diese Ausnahme storniert sich der Task selbst,
        WAEHREND er noch die `remote_ended`-Meldung verschickt — `cancel()`
        wirkt beim naechsten `await` (dem Versand selbst), eine `Cancelled
        Error` dort ist keine `Exception` und wird vom umschliessenden
        `except Exception` nicht gefangen, die Meldung geht nie hinaus. Der
        Task raeumt sich in seinem eigenen `finally` ohnehin ab, sobald er
        fertig ist — das Popmen hier reicht, das Stornieren waere nur fuer
        einen FREMDEN, noch wartenden Task noetig."""
        current = asyncio.current_task()
        if role is not None:
            task = self._remote_disconnect_timers.pop((session_id, role), None)
            if task is not None and task is not current:
                task.cancel()
            return
        for key in [k for k in self._remote_disconnect_timers if k[0] == session_id]:
            task = self._remote_disconnect_timers.pop(key)
            if task is not current:
                task.cancel()

    def remote_disconnect_grace_active(self, session_id: str, role: str) -> bool:
        """Laeuft gerade eine Frist fuer GENAU diese Rolle dieser Sitzung?

        Zwei Aufrufer: `remote_reclaim` (darf nur reklamieren, wessen Rolle
        wirklich in Frist steht) und die periodische Rechte-Wache
        (`remote_guard.py::_end_reason` — ein waehrend der Frist fehlender
        Sockel-Nutzer ist der ERWARTETE Zustand, kein Grund zum Sofort-Ende)."""
        return (session_id, role) in self._remote_disconnect_timers

    async def _disconnect_grace_expired(
        self,
        session_id: str,
        role: str,
        on_expired: Callable[[str, str], Awaitable[None]],
        delay: float,
    ) -> None:
        key = (session_id, role)
        try:
            await asyncio.sleep(delay)
            # Zwischenzeitlich reklamiert (oder ein NEUERER Abriss DERSELBEN
            # Rolle hat die Uhr neu gestellt, s. `remote_schedule_disconnect_
            # grace`)? Dann ist DIESER Task nicht mehr der aktuelle Zeitgeber
            # fuer (Sitzung, Rolle) — pruefen VOR dem Abbau, sonst reisst ein
            # spaet auslösender Timer eine laengst wiederhergestellte Sitzung
            # doch noch ab. Gleiches Muster wie
            # `remote_registry._remote_timeout`/`watch_registry.
            # _host_end_after_grace`.
            if self._remote_disconnect_timers.get(key) is not asyncio.current_task():
                return
            await on_expired(session_id, role)
        finally:
            if self._remote_disconnect_timers.get(key) is asyncio.current_task():
                self._remote_disconnect_timers.pop(key, None)

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
            if not self.remote_disconnect_grace_active(session_id, role):
                return None
            if role == "host":
                sess.host_socket = new_socket
            else:
                sess.controller_socket = new_socket
        self.remote_cancel_disconnect_grace(session_id, role=role)
        return sess
