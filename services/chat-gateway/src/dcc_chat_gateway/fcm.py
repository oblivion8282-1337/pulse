"""FCM-Push (Firebase Cloud Messaging) für die Android-App (Übergabe P0.1).

Ein inhaltsfreier Benachrichtigungskanal neben dem Web-Push aus
:mod:`dcc_chat_gateway.push`: eine neue DM an einen Empfänger OHNE offene
WebSocket-Verbindung wird als Systemmeldung auf dem Android-Gerät sichtbar.
Die Nutzlast trägt deshalb nur Absendername und Kanalkennung — niemals
Nachrichtentext (derselbe Riegel wie ``fan_out_dm_push_encrypted``).

**Einrichtung des Service-Account-Keys** (einmalig, Betreiber):

1. Firebase Console → Projekt "Pulse" (pulse-8cad0) → Projekteinstellungen
   → Dienstkonten → „Neuen privaten Schlüssel generieren" (JSON).
2. Datei auf dem Server ablegen (z. B. ``/data/fcm-service-account.json``,
   Modus 0600) und den Pfad als ``FIREBASE_SERVICE_ACCOUNT_KEY``-Umgebungs-
   variable setzen. Neustart. Ohne die Variable (oder mit unlesbarer Datei)
   bleibt FCM aus — kein Crash, kein Ambulanz-Log je Nachricht: nur ein
   einzelner WARNING beim ersten missglückten Initialisieren.

``firebase_admin`` wird erst beim ersten Senden importiert (Muster wie
``pywebpush`` in ``push.py``): Boot und Tests brauchen die Bibliothek nicht.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import delete, select

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import FcmToken

log = logging.getLogger(__name__)

#: Android-Benachrichtigungskanal für Push-Meldungen. Der Klient legt ihn
#: beim App-Start an (``FirebaseMessaging.createChannel``); FCM ordnet die
#: Meldung über ``AndroidNotification.channel_id`` dort ein.
ANDROID_CHANNEL_ID = "messages"

#: Inhaltsfreier Benachrichtigungstext — der Server kann (bei verschlüsselten
#: DMs: soll) den Klartext nicht kennen, also steht hier nie mehr als die
#: Kategorie.
DM_BODY = "Neue Nachricht"

#: Initialisierte ``firebase_admin.App`` — Prozess-Singleton, erster Aufruf
#: gewinnt. ``None`` heisst: nicht konfiguriert oder fehlgeschlagen (kein Push).
_FCM_APP: Any | None = None


def ensure_fcm() -> Any | None:
    """Firebase-App mit Service-Account initialisieren (gecacht).

    Liefert ``None``, wenn ``FIREBASE_SERVICE_ACCOUNT_KEY`` nicht gesetzt ist,
    ``firebase_admin`` fehlt oder die Datei unbrauchbar ist — aufruferseitig
    dasselbe Verhalten: kein Push, kein Fehler.
    """
    global _FCM_APP
    if _FCM_APP is not None:
        return _FCM_APP
    settings = get_settings()
    if not settings.firebase_service_account_key:
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials
    except ImportError:
        log.error("firebase_admin nicht installiert; FCM-Push deaktiviert")
        return None
    try:
        _FCM_APP = firebase_admin.initialize_app(
            credentials.Certificate(settings.firebase_service_account_key)
        )
    except Exception:  # noqa: BLE001 — schlechter Key darf nie den Versandpfad sprengen
        log.exception(
            "fcm_key_unbrauchbar — Service-Account-Datei %s nicht ladbar; "
            "FCM-Push deaktiviert",
            settings.firebase_service_account_key,
        )
        return None
    log.info("fcm_aktiviert — Service-Account-Key geladen")
    return _FCM_APP


def reset_fcm_cache_for_tests() -> None:
    """Prozess-Cache leeren (Tests mit wechselnden Key-Pfaden)."""
    global _FCM_APP
    if _FCM_APP is not None:
        try:
            import firebase_admin

            firebase_admin.delete_app(_FCM_APP)
        except Exception:  # noqa: BLE001
            pass
    _FCM_APP = None


def _send_one(*, token: str, payload: dict) -> str:
    """Ein Sendeversuch. Liefert ``"ok"``, ``"dead"`` oder ``"warn"``.

    ``dead`` = Token weg (App deinstalliert, rotiert) → Zeile löschen,
    damit jeder DM-Versand nicht ewig gegen eine tote Registrierung läuft.
    Niemals ``token`` oder Payload loggen.
    """
    try:
        from firebase_admin import messaging
    except ImportError:
        log.error("firebase_admin nicht installiert; FCM-Push deaktiviert")
        return "warn"
    try:
        messaging.send(
            messaging.Message(
                notification=messaging.Notification(
                    title=payload["title"], body=payload["body"]
                ),
                token=token,
                # channel_id im data-Block: das ist die Pulse-Kanalkennung für
                # den Deep-Link des Klienten, nicht der Android-Kanal.
                android=messaging.AndroidConfig(
                    notification=messaging.AndroidNotification(
                        channel_id=ANDROID_CHANNEL_ID
                    ),
                    data={k: v for k, v in payload.items() if isinstance(v, str)},
                ),
            )
        )
        return "ok"
    except messaging.UnregisteredError:
        return "dead"
    except messaging.InvalidArgumentError:
        # Malformed token — wird nie wieder gültig.
        return "dead"
    except Exception:  # noqa: BLE001 — Push ist best-effort
        log.warning("fcm_send_fehlgeschlagen")
        return "warn"


async def fan_out_fcm_dm_push(
    *,
    recipient_ids: set[int],
    author_name: str,
    channel_id: int,
    manager: Any | None = None,
) -> int:
    """Inhaltsfreien FCM-Push an offline DM-Empfänger ausliefern.

    Offline = keine offene WebSocket-Verbindung: wer online ist, bekommt die
    Nachricht live über den WS (``dm_bump``), und eine zusätzliche
    Systemmeldung wäre doppelt. Der Check läuft über
    ``ConnectionManager.user_socket_count``; ohne ``manager`` (Tests, pfad-
    lose Aufrufe) gilt jeder Empfänger als offline.

    Liefert die Anzahl erfolgreicher Sendungen zurück. Löst nie aus —
    Fehlkonfiguration und tote Tokens dürfen den Nachrichtenweg nie brechen.
    """
    if not recipient_ids:
        return 0
    if ensure_fcm() is None:
        return 0
    if manager is not None:
        recipient_ids = {
            uid for uid in recipient_ids if manager.user_socket_count(uid) == 0
        }
        if not recipient_ids:
            return 0

    payload = {
        "type": "dm",
        "title": author_name or "Pulse",
        "body": DM_BODY,
        "channel_id": str(channel_id),
    }

    try:
        async with SessionLocal() as session:
            rows = (
                (
                    await session.execute(
                        select(FcmToken).where(
                            FcmToken.user_id.in_(list(recipient_ids))
                        )
                    )
                )
                .scalars()
                .all()
            )
            if not rows:
                return 0
            results = await asyncio.gather(
                *(
                    asyncio.to_thread(_send_one, token=r.token, payload=payload)
                    for r in rows
                ),
                return_exceptions=True,
            )
            dead_tokens = [
                r.token
                for r, outcome in zip(rows, results, strict=True)
                if outcome == "dead"
            ]
            if dead_tokens:
                await session.execute(
                    delete(FcmToken).where(FcmToken.token.in_(dead_tokens))
                )
                await session.commit()
            return sum(1 for outcome in results if outcome == "ok")
    except Exception:  # noqa: BLE001
        log.exception("fan_out_fcm_dm_push fehlgeschlagen")
        return 0


__all__ = [
    "ANDROID_CHANNEL_ID",
    "DM_BODY",
    "ensure_fcm",
    "fan_out_fcm_dm_push",
    "reset_fcm_cache_for_tests",
]
