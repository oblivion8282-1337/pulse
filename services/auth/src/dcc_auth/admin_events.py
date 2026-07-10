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
# Direct-Delivery an genau einen User. chat-gateway routet über
# ``_target_user_id`` und streift das Feld vor der Zustellung ab.
USER_EVENTS_CHANNEL = "user:events"

ApplicationKind = Literal["app_host", "instance"]
Decision = Literal["approved", "rejected"]


async def _publish(request: Request, channel: str, payload: dict) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    try:
        await redis.publish(channel, json.dumps(payload))
    except Exception:  # noqa: BLE001
        log.warning("publish auf %s fehlgeschlagen: %r", channel, payload, exc_info=True)


async def publish_application_pending(request: Request, kind: ApplicationKind) -> None:
    """Meldet den Admins, dass ein neuer Antrag der Art ``kind`` offen ist."""
    await _publish(
        request,
        ADMIN_EVENTS_CHANNEL,
        {"op": "admin_application_pending", "kind": kind},
    )


async def publish_application_decided(
    request: Request,
    *,
    user_id: int,
    kind: ApplicationKind,
    status: Decision,
    rejection_reason: str | None = None,
) -> None:
    """Meldet dem Antragsteller die Entscheidung — ohne Warten auf seinen Poll."""
    await _publish(
        request,
        USER_EVENTS_CHANNEL,
        {
            "op": "application_decided",
            "data": {
                "kind": kind,
                "status": status,
                "rejection_reason": rejection_reason,
            },
            "_target_user_id": str(user_id),
        },
    )
