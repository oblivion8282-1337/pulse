"""Signal-Hub des Direktpfads: reicht WebRTC-Offer/Answer zwischen Client und
Server-App durch (Plan ``2026-07-09-direct-path-webrtc``, Phase 3).

Die Server-App hält einen WS zur Cloud („Klingeldraht"); ein Client-POST legt
einen Offer hinein und wartet auf die Answer. Die Cloud sieht nur SDP-Blobs
(~2 KB Verbindungsaufbau-Metadaten) — kein Inhalt, und nach dem Handschlag
läuft alles direkt.

Bewusst **in-process** (dict + Futures): auth-svc läuft als EIN uvicorn-Prozess
(Dockerfile.service, kein ``--workers``). Sollte das je skaliert werden, muss
dieser Hub auf Redis-Pub/Sub umziehen — Assert im Startup gibt es nicht, die
Grenze ist hier dokumentiert.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Protocol


class _WsLike(Protocol):
    async def send_json(self, data: dict) -> None: ...


class OfferTimeout(Exception):
    """Server-App hat innerhalb des Timeouts nicht geantwortet."""


class InstanceOffline(Exception):
    """Kein Klingeldraht — die Server-App ist nicht verbunden."""


class SignalHub:
    def __init__(self) -> None:
        self._instances: dict[int, _WsLike] = {}
        self._pending: dict[str, asyncio.Future[str]] = {}

    def register(self, instance_id: int, ws: _WsLike) -> None:
        """Neuer Klingeldraht ersetzt einen alten (Reconnect gewinnt)."""
        self._instances[instance_id] = ws

    def unregister(self, instance_id: int, ws: _WsLike) -> None:
        # Nur entfernen, wenn nicht längst ein neuer WS registriert wurde —
        # sonst reißt der Disconnect-Handler des ALTEN Sockets den neuen mit.
        if self._instances.get(instance_id) is ws:
            del self._instances[instance_id]

    def is_connected(self, instance_id: int) -> bool:
        return instance_id in self._instances

    async def relay_offer(self, instance_id: int, sdp: str, timeout_s: float) -> str:
        """Offer an die Server-App schicken, auf die Answer warten."""
        ws = self._instances.get(instance_id)
        if ws is None:
            raise InstanceOffline
        connection_id = secrets.token_hex(8)
        fut: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[connection_id] = fut
        try:
            await ws.send_json({"t": "offer", "connection_id": connection_id, "sdp": sdp})
            return await asyncio.wait_for(fut, timeout_s)
        except TimeoutError:
            raise OfferTimeout from None
        finally:
            self._pending.pop(connection_id, None)

    def resolve_answer(self, connection_id: str, sdp: str) -> bool:
        """Answer der Server-App dem wartenden Client-Request zustellen."""
        fut = self._pending.get(connection_id)
        if fut is None or fut.done():
            return False
        fut.set_result(sdp)
        return True


# Modul-Singleton — geteilt zwischen WS-Route und Offer-Endpoint.
hub = SignalHub()
