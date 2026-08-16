"""Die Form eines Geräts nach aussen — und die Meldungen, die es begleiten.

Ausgelagert aus :mod:`routes.devices` (Grössen-Policy §12.1) und aus einem
zweiten Grund: die Zeile eines Geräts verlässt den Server nicht nur über die
Route. Der Rauswurf- und der Bann-Pfad (:mod:`remote_guard`) müssen dasselbe
``device_changed`` schicken, und ein Wach-Modul, das dafür eine Route importiert,
hätte die Abhängigkeitsrichtung auf den Kopf gestellt. Hier steht die Form
einmal, und beide Seiten holen sie sich.

Beide Meldungen sind bewusst **fehlertolerant**: die Datenbank ist die Wahrheit,
die Meldung an die offenen Fenster ist Bequemlichkeit. Ein fehlendes Redis darf
keine Eintragung scheitern lassen — dieselbe Linie wie bei den Plugin-Toggles
(``routes/guild_plugins.py``).
"""

from __future__ import annotations

import logging

from fastapi import Request
from pydantic import BaseModel

from dcc_chat_gateway.models import Device

log = logging.getLogger(__name__)


class DeviceOut(BaseModel):
    id: str
    guild_id: str
    channel_id: str
    owner_user_id: str
    name: str
    #: ``ready`` | ``busy`` | ``offline`` — aus dem Verbindungsregister.
    state: str
    #: Wer es gerade steuert (nur bei ``busy``), sonst ``None``.
    busy_with: str | None = None
    #: Die Bildschirme, die das Gerät beim Anmelden gemeldet hat. Leer, solange
    #: es nie verbunden war — der Steuernde sieht dann nur „ein Bildschirm",
    #: und das ist ehrlicher als eine erfundene Liste.
    monitors: list[dict] = []


def manager_von(request: Request):
    return getattr(request.app.state, "connection_manager", None)


def device_out(device: Device, mgr) -> DeviceOut:
    """Die Zeile in ihrer Aussenform — Antwort einer Route und, als
    ``model_dump()``, Nutzlast eines ``device_changed``-Rahmens.

    Die eine Stelle, an der diese Form entsteht. Auch der Rauswurf-Pfad holt
    sie sich hier, statt sich eine zweite, langsam auseinanderlaufende Kopie
    des Feldsatzes zu bauen.
    """
    # Ohne Manager (Testaufbau ohne WS-Schicht) ist nichts angemeldet — und
    # „offline" ist die richtige Antwort auf „ich weiss es nicht".
    zustand, mit = mgr.device_state(device.id) if mgr is not None else ("offline", None)
    schirme = mgr.device_monitors(device.id) if mgr is not None else []
    return DeviceOut(
        id=str(device.id),
        guild_id=str(device.guild_id),
        channel_id=str(device.channel_id),
        owner_user_id=str(device.owner_user_id),
        name=device.name,
        state=zustand,
        busy_with=mit,
        monitors=schirme,
    )


async def melden(
    request: Request,
    device: Device,
    stand: DeviceOut,
    *,
    entfernt: bool = False,
    kanal: int | None = None,
) -> None:
    """``device_changed`` an die Community schicken.

    ``kanal`` übersteuert den Standplatz — gebraucht beim Umstellen, wo die
    Meldung „weg hier" an den ALTEN Kanal gehen muss.
    """
    mgr = manager_von(request)
    if mgr is None:
        return
    try:
        await mgr.publish_device_change(
            guild_id=device.guild_id,
            channel_id=kanal if kanal is not None else device.channel_id,
            device=stand.model_dump(),
            removed=entfernt,
        )
    except Exception:  # pragma: no cover - Meldung ist nie kritisch
        log.debug("device_changed not published", exc_info=True)


async def sitzung_beenden(request: Request, device: Device) -> None:
    """Eine laufende Fernsteuerung dieses Geräts abbauen."""
    mgr = manager_von(request)
    if mgr is None:
        return
    try:
        await mgr.end_remote_sessions_for_device(device.id)
    except Exception:  # pragma: no cover
        log.debug("device sessions not ended", exc_info=True)
