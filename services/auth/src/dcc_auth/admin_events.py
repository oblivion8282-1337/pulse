"""Admin-Benachrichtigungen von auth-svc an die Cloud-Admins (Redis Pub/Sub).

Warum überhaupt: Ein neuer Self-Host- oder App-Hosting-Antrag landete bisher
nur in der DB. Der Admin-Client pollt seine Antragslisten im 60-Sekunden-Takt,
also erfuhr ein Admin bis zu eine Minute später davon — und gar nicht, wenn
kein Admin-Fenster offen war. auth-svc publiziert deshalb ein Ereignis, das
chat-gateway an alle Admin-Sockets weiterreicht (``admin:events``).

Bewusst inhaltsleer: Der Payload sagt nur „für dich gibt es einen neuen
Antrag dieser Art". Die Daten holt der Client danach über seinen regulären,
cookie-authentifizierten Admin-Endpoint. Ein Payload mit Antragsdaten wäre
eine zweite Stelle, an der Berechtigungen stimmen müssten.

Best-effort: Redis weg oder Publish fehlgeschlagen → der Antrag ist trotzdem
gespeichert, der Client sieht ihn beim nächsten Poll. Eine Benachrichtigung
darf niemals das Einreichen scheitern lassen.
"""

from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import Request

log = logging.getLogger(__name__)

ADMIN_EVENTS_CHANNEL = "admin:events"

ApplicationKind = Literal["app_host", "instance"]


async def publish_application_pending(request: Request, kind: ApplicationKind) -> None:
    """Meldet den Admins, dass ein neuer Antrag der Art ``kind`` offen ist."""
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    try:
        await redis.publish(
            ADMIN_EVENTS_CHANNEL,
            json.dumps({"op": "admin_application_pending", "kind": kind}),
        )
    except Exception:  # noqa: BLE001
        log.warning("admin:events publish failed (kind=%s)", kind, exc_info=True)
