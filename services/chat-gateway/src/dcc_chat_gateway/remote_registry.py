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
SDP/ICE and input across pods). Exactly **one** session per host at a time.

``host_socket`` at ``remote_create`` time is a *representative* of the host's
sockets (a user may have several tabs open). ``remote_request`` fans the invite
out to every host socket, and ``remote_respond`` overwrites ``host_socket`` with
the socket the host actually accepted from — that is the authoritative peer for
signal forwarding.
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
    state: str = "pending"  # "pending" until the host accepts, then "active"
    created_at: int = field(default_factory=_now_ms)


class _RemoteRegistryMixin:
    """Adds the remote-control session registry to ConnectionManager. Requires
    ``self._lock`` (asyncio.Lock) and ``self._user_conns`` on the host class.
    Call ``_init_remote_registry()`` once in the host ``__init__``."""

    _remote_sessions: dict[str, RemoteSession]
    _remote_timers: dict[str, asyncio.Task[Any]]
    # Provided by ConnectionManager — declared here for type-checkers only.
    _user_conns: dict[int, set[Any]]
    _lock: asyncio.Lock

    def _init_remote_registry(self) -> None:
        self._remote_sessions = {}
        self._remote_timers = {}

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
    ) -> RemoteSession | None:
        """Create a pending session. Returns ``None`` when the host already has
        a pending/active session (v1: exactly one per host)."""
        async with self._lock:
            hid = str(host_user_id)
            for sess in self._remote_sessions.values():
                if sess.host_user_id == hid:
                    return None
            session_id = secrets.token_hex(8)
            sess = RemoteSession(
                session_id=session_id,
                channel_id=str(channel_id),
                host_user_id=hid,
                host_socket=host_socket,
                controller_user_id=str(controller_user_id),
                controller_socket=controller_socket,
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

    def remote_user_has_session(self, user_id: int | str) -> bool:
        """Is ``user_id`` a peer (host or controller) of any current session?
        Gates issuance of session-scoped extras (TURN credentials on the P2P
        branch): only a user actually in a remote-control session — which
        already passed the REMOTE_CONTROL check — may mint them."""
        uid = str(user_id)
        return any(
            sess.host_user_id == uid or sess.controller_user_id == uid
            for sess in self._remote_sessions.values()
        )

    async def remote_end(self, session_id: str) -> RemoteSession | None:
        """Remove the session and return it (or ``None`` if already gone), so
        the caller can notify the other peer."""
        async with self._lock:
            return self._remote_sessions.pop(session_id, None)

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
        try:
            await asyncio.sleep(delay)
            sess = self.remote_get(session_id)
            if sess is None or sess.state != "pending":
                return  # already accepted or ended
            await self.remote_end(session_id)
            await send_to_socket(
                controller_socket,
                {"op": "remote_ended", "session_id": session_id, "reason": "timeout"},
            )
        finally:
            if self._remote_timers.get(session_id) is asyncio.current_task():
                self._remote_timers.pop(session_id, None)
