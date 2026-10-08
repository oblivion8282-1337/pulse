"""Der Server-Name eines Self-Hosts — setzen, verteilen, der Cloud melden.

Der Name liegt in ``chat_settings.instance_name`` (Migration 0040) und erreicht
verbundene Mitglieder über ``PermissionsUpdatedEvent`` und den ready-Frame.
Die Server-Leiste der Clients wird aber aus der CLOUD gebaut
(``/me/instances``) — ohne Meldung dorthin zeigte sie jedem, der den Server
noch nie geöffnet hatte, die Relay-Adresse (2026-10-08). Deshalb meldet der
Server seinen Namen an die Cloud: bei jeder Änderung, beim Start und alle
6 Stunden (eine verlorene Meldung heilt sich so selbst).

Zwei Wege setzen den Namen: ``PATCH /admin/permissions`` (Pulse, /app/admin)
und ``PUT /internal/instance-name`` (die Server-App über das interne
Geheimnis). Beide laufen durch :func:`setze_und_verteile`.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import Request

from dcc_chat_gateway import config as chat_cfg
from dcc_chat_gateway.models.admin import ChatSettings

log = logging.getLogger(__name__)

#: Abstand der Selbstheilungs-Meldung. Der Name ändert sich selten; die
#: Meldung kostet die Cloud eine Argon2-Prüfung — öfter wäre Verschwendung.
ABGLEICH_TAKT_S = 6 * 3600
#: Erste Meldung nach dem Start — Zeit für Netz und Relay-Tunnel.
START_VERZOEGERUNG_S = 20


def normalisiere(name: str | None) -> str | None:
    """Leerstring → NULL (zurücksetzen), Ränder weg."""
    return (name or "").strip() or None


async def melde_an_cloud(name: str | None) -> bool:
    """Den Namen an die Cloud melden (best effort). Nur Self-Hosts mit
    Instanz-Zugangsdaten — die Cloud selbst hat niemanden, dem sie melden
    könnte. ``True`` bei 204."""
    s = chat_cfg.get_settings()
    if s.pulse_instance_mode != "self-host" or not s.pulse_instance_id:
        return False
    if not s.pulse_cloud_client_id or not s.pulse_cloud_client_secret:
        return False
    url = s.pulse_cloud_origin.rstrip("/") + "/api/auth/selfhost/anzeigename"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(url, json={
                "instance_id": str(s.pulse_instance_id),
                "client_id": s.pulse_cloud_client_id,
                # Wie der direct-adapter im Heartbeat: das Secret als ``token``.
                "token": s.pulse_cloud_client_secret,
                "anzeigename": name,
            })
    except httpx.HTTPError as exc:
        log.warning("anzeigename_cloud_meldung_fehlgeschlagen: %s", type(exc).__name__)
        return False
    if r.status_code != 204:
        log.warning("anzeigename_cloud_meldung_abgelehnt: HTTP %s", r.status_code)
        return False
    return True


def melde_im_hintergrund(name: str | None) -> None:
    """Meldung anstoßen, ohne die Antwort an den Nutzer aufzuhalten."""
    asyncio.get_running_loop().create_task(melde_an_cloud(name), name="dcc-anzeigename-melden")


def permissions_event(row: ChatSettings, name_geaendert: bool):
    """Das ``PermissionsUpdatedEvent`` aus der aktuellen Zeile — eine Stelle für
    beide Setz-Wege (vorher stand die Feldliste nur in routes/admin.py)."""
    from dcc_shared.events import PermissionsUpdatedEvent

    return PermissionsUpdatedEvent(
        allow_guild_creation=row.allow_guild_creation,
        allow_member_invites=row.allow_member_invites,
        # Nur mitschicken, wenn der Name sich änderte: "" = zurückgesetzt
        # (Adresse zeigen), None = Feld unverändert. So aktualisieren
        # verbundene Mitglieder den Server-Namen sofort, ohne Reload.
        instance_name=(row.instance_name or "") if name_geaendert else None,
        guild_sound_max_size_bytes=row.guild_sound_max_size_bytes,
        hq_bitrate_min_kbps=row.hq_bitrate_min_kbps,
        hq_bitrate_max_kbps=row.hq_bitrate_max_kbps,
        hq_fps_min=row.hq_fps_min,
        hq_fps_max=row.hq_fps_max,
        hq_resolution_max=row.hq_resolution_max,
        ns_bitrate_min_kbps=row.ns_bitrate_min_kbps,
        ns_bitrate_max_kbps=row.ns_bitrate_max_kbps,
        ns_fps_min=row.ns_fps_min,
        ns_fps_max=row.ns_fps_max,
        ns_resolution_max=row.ns_resolution_max,
        cam_resolution_max=row.cam_resolution_max,
        cam_fps_max=row.cam_fps_max,
        voice_bitrate_max_kbps=row.voice_bitrate_max_kbps,
    )


async def verteile(request: Request, row: ChatSettings) -> None:
    """Verbundene Clients sofort informieren (best effort, wirft nie)."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    try:
        await mgr.publish_guild_event(permissions_event(row, name_geaendert=True))
    except Exception:  # noqa: BLE001
        log.exception("instance_name_broadcast_failed")


async def abgleich_loop(session_factory) -> None:
    """Beim Start und danach alle 6 h den gespeicherten Namen melden."""
    await asyncio.sleep(START_VERZOEGERUNG_S)
    while True:
        try:
            async with session_factory() as session:
                row = await session.get(ChatSettings, 1)
                name = row.instance_name if row else None
            await melde_an_cloud(name)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("anzeigename_abgleich_fehler")
        await asyncio.sleep(ABGLEICH_TAKT_S)
