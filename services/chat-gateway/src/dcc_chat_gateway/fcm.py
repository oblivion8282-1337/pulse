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
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select

from dcc_chat_gateway import badgezaehler
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import FcmToken

# Nur für die Typangabe von ``_build_dm_message``: zur Laufzeit lädt diese
# Zeile nichts — ``firebase_admin`` wird erst beim ersten Senden importiert
# (s. Modulkopf).
if TYPE_CHECKING:
    from firebase_admin import messaging

log = logging.getLogger(__name__)

#: Android-Benachrichtigungskanal für Push-Meldungen. Der Klient legt ihn
#: beim App-Start an (``FirebaseMessaging.createChannel``); FCM ordnet die
#: Meldung über ``AndroidNotification.channel_id`` dort ein.
ANDROID_CHANNEL_ID = "messages"

#: Inhaltsfreier Benachrichtigungstext — der Server kann (bei verschlüsselten
#: DMs: soll) den Klartext nicht kennen, also steht hier nie mehr als die
#: Kategorie.
DM_BODY = "Neue Nachricht"

#: Mitteilungs-Kategorie für DMs. Sie verbindet die Meldung mit den Aktionen,
#: die die App registriert hat (`AppDelegate.swift` — „Antworten" mit
#: Eingabefeld). Der Bezeichner muss dort WORTGLEICH stehen; passt er nicht,
#: zeigt iOS die Meldung ohne Aktionen an — ohne jeden Fehler.
DM_KATEGORIE = "dm"

#: Dasselbe, wenn ein Anhang dranhängt (Eigentümer-Entscheid 2026-10-08).
#: Der Server WEISS das — die Bezugszeilen (``dm_anhang_bezuege``) stehen in
#: seiner Datenbank —, und nur das sagt dieser Text. Kein Dateiname, keine
#: Art, keine Grösse: die hat er auch gar nicht entschlüsselt vorliegen.
#: Der Preis ist bewusst in Kauf genommen und klein: Apple und der Server
#: erfahren, DASS diese eine Nachricht einen Anhang trug.
DM_BODY_ANHANG = "Hat dir einen Anhang geschickt"


def dm_body(hat_anhang: bool) -> str:
    """Der Mitteilungstext für eine DM. Eigene Funktion, weil die Entscheidung
    an zwei Stellen gleich ausfallen muss (``aps.alert`` für iOS und
    ``notification`` für Android) — stünden dort verschiedene Texte, sähe
    dieselbe Nachricht je nach Gerät anders aus."""
    return DM_BODY_ANHANG if hat_anhang else DM_BODY

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


def _build_dm_message(
    *, token: str, payload: dict, badge: int | None = None
) -> messaging.Message:
    """Baut die FCM-Message für eine DM (Alert + iOS-Sound + Zeitkritisch +
    Icon-Badge + Android-Kanal + Deep-Link-Daten). Eigenständige Funktion,
    damit der Test den echten Bau durch den firebase-Encoder schicken kann
    (Befund 2026-10-06: messaging.ApsSound existierte nicht — nur ein echter
    Konstruktions-Test fängt so etwas).

    ``badge`` ist der Ungelesen-Stand des EMPFÄNGERS (s. ``badgezaehler``).
    ``None`` heisst *schweigen*: das Feld entfällt und die Zahl am Gerät
    bleibt stehen. Eine ``0`` dagegen räumt die Plakette ab — deshalb darf
    ein unbekannter Stand niemals als 0 durchgehen.
    """
    from firebase_admin import messaging

    # Der FCM-``data``-Block ist String→String. ``payload`` trägt heute nur
    # Strings; der Filter ist der Riegel dagegen, dass ein künftiges Feld
    # anderen Typs hineingerät. Einmal gebaut, zweimal verwendet (top-level
    # und im Android-Block) — die beiden müssen denselben Inhalt tragen.
    daten = {k: v for k, v in payload.items() if isinstance(v, str)}
    return messaging.Message(
        notification=messaging.Notification(
            title=payload["title"], body=payload["body"]
        ),
        token=token,
        # Deep-Link-Daten TOP-LEVEL, nicht nur im Android-Block: nur so
        # erreichen sie auch die iOS-Hülle, deren Tap-Handler
        # `notification.data.channel_id` liest (Befund Review 2026-10-08 —
        # vorher öffnete ein Push-Tap am iPhone nur die App, nicht den Chat).
        data=daten,
        # iOS: eigener Sound (pulse-push.caf im Bundle) + zeitkritisch —
        # durchbricht Fokus-Modi; das Zeitkritisch-Privileg vergibt der
        # Nutzer einmalig im Systemdialog.
        #
        # **Die Dringlichkeit steht im `aps`-Block, nicht im Kopf.** Bis zum
        # 2026-10-11 stand hier ein Kopf `apns-interruption-level` — einen
        # solchen Kopf kennt APNs nicht (die Kopfzeilen sind `apns-push-type`,
        # `apns-priority`, `apns-expiration`, `apns-topic`, `apns-collapse-id`,
        # `apns-id`); die Ebene ist ein Feld der Nutzlast,
        # `aps.interruption-level` (Apple, „Generating a remote
        # notification"). Der Kopf wurde still übergangen, und keine Meldung
        # war je zeitkritisch (Bughunt T16). Gefolgert aus der Doku, nicht am
        # Gerät gemessen.
        apns=messaging.APNSConfig(
            headers={"apns-push-type": "alert"},
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    alert=messaging.ApsAlert(
                        title=payload["title"], body=payload["body"]
                    ),
                    sound="pulse-push.caf",
                    # Der Encoder lässt None-Felder weg — genau das ist hier
                    # die Absicht, s. Docstring.
                    badge=badge,
                    category=DM_KATEGORIE,
                    custom_data={"interruption-level": "time-sensitive"},
                )
            ),
        ),
        # channel_id im data-Block: das ist die Pulse-Kanalkennung für den
        # Deep-Link des Klienten, nicht der Android-Kanal.
        android=messaging.AndroidConfig(
            notification=messaging.AndroidNotification(channel_id=ANDROID_CHANNEL_ID),
            data=daten,
        ),
    )


def _send_one(*, token: str, payload: dict, badge: int | None = None) -> str:
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
        messaging.send(_build_dm_message(token=token, payload=payload, badge=badge))
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
    hat_anhang: bool = False,
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
        "body": dm_body(hat_anhang),
        "channel_id": str(channel_id),
    }

    try:
        async with SessionLocal() as session:
            ergebnis = await session.execute(
                select(FcmToken).where(FcmToken.user_id.in_(list(recipient_ids)))
            )
            rows = ergebnis.scalars().all()
            if not rows:
                return 0
            # Icon-Badge: EINMAL je Konto hochzählen, nicht je Gerätezeile —
            # ein Konto hat einen Ungelesen-Stand, auch wenn Handy und Tablet
            # beide einen Push bekommen. Ohne Redis (pfadlose Aufrufe, Tests)
            # bleibt der Stand unbekannt und das Feld entfällt im Push.
            redis = getattr(manager, "redis", None)
            badges: dict[int, int | None] = {}
            if redis is not None:
                for uid in {r.user_id for r in rows}:
                    badges[uid] = await badgezaehler.erhoehen(redis, uid)
            results = await asyncio.gather(
                *(
                    asyncio.to_thread(
                        _send_one,
                        token=r.token,
                        payload=payload,
                        badge=badges.get(r.user_id),
                    )
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
