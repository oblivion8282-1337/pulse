"""Direkter APNs-Weg für VoIP-Pushes (iOS-Liste Punkt 40).

**Warum nicht über Firebase.** Jeder andere Push dieses Dienstes geht über
``firebase_admin`` (``fcm.py``), und das ist richtig: Firebase verwaltet den
APNs-Schlüssel, kennt Android mit, und wir haben dort eine Zustellart. Ein
VoIP-Push ist aber keine Zustellart von Firebase — er verlangt den Kopf
``apns-push-type: voip`` auf dem Topic ``<bundle>.voip``, und das kann die
Firebase-Schnittstelle nicht setzen. Dieser Weg existiert also nicht aus
Geschmack, sondern weil es keinen anderen gibt.

**Warum ein VoIP-Push überhaupt.** Ein normaler Push weckt die App nicht so
weit, dass sie klingeln kann — bis hierher erreichte ein Anruf nur, wer eine
offene WebSocket hatte (``routes/anrufe.py`` publisht an Redis, sonst
nichts). Wer das Telefon in der Tasche hat, verpasste jeden Anruf, ohne dass
irgendwo etwas schiefging. Ein VoIP-Push weckt die App in jedem Zustand und
verpflichtet sie im Gegenzug, SOFORT einen Anruf zu melden (CallKit) — tut
sie das nicht, beendet iOS sie, und nach Wiederholung entzieht es die
VoIP-Pushes ganz.

**Alles fail-open.** Fehlt die Konfiguration, passiert nichts und der Anruf
läuft wie bisher über die WebSocket. Ein fehlender Schlüssel darf keinen
Anruf verhindern, der sonst zustande käme.

**Keine neue Abhängigkeit:** ``httpx`` mit HTTP/2 (``h2`` zieht
``firebase-admin`` selbst mit) und ``pyjwt[crypto]`` liegen schon im
Environment.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("dcc_chat_gateway.apns_voip")

# APNs lässt ein Anbieter-JWT maximal eine Stunde gelten und verlangt, dass
# es nicht zu häufig neu erzeugt wird. 50 Minuten lassen Luft für Uhrdrift,
# ohne an die Grenze zu gehen.
JWT_LAUFZEIT_S = 50 * 60

PROD_HOST = "https://api.push.apple.com"
SANDBOX_HOST = "https://api.sandbox.push.apple.com"


@dataclass(frozen=True)
class ApnsZugang:
    """Was ein Sendeversuch an Konfiguration braucht."""

    schluessel_pem: str
    key_id: str
    team_id: str
    bundle_id: str
    sandbox: bool


def host_fuer(sandbox: bool) -> str:
    """Welcher APNs-Host.

    **Das ist keine Kleinigkeit, sondern die häufigste Fehlerquelle:** ein
    Gerätetoken gehört zu GENAU EINER Umgebung. Ein Token aus einem
    Entwicklungs-Bau (``aps-environment = development``, so steht es heute in
    ``App.entitlements``) wird von der Produktions-Adresse mit
    ``BadDeviceToken`` abgewiesen — und das sieht aus wie ein kaputter Token,
    nicht wie die falsche Adresse.
    """
    return SANDBOX_HOST if sandbox else PROD_HOST


def jwt_bauen(zugang: ApnsZugang, jetzt: float | None = None) -> str:
    """Anbieter-JWT für APNs (ES256 über den ``.p8``-Schlüssel).

    ``iss`` ist die Team-ID, ``kid`` die Key-ID des Schlüssels — beides steht
    im Apple-Developer-Portal neben dem Schlüssel und NICHT in der Datei.
    """
    import jwt as pyjwt

    iat = int(jetzt if jetzt is not None else time.time())
    return pyjwt.encode(
        {"iss": zugang.team_id, "iat": iat},
        zugang.schluessel_pem,
        algorithm="ES256",
        headers={"kid": zugang.key_id},
    )


def kopfzeilen(zugang: ApnsZugang, token_jwt: str) -> dict[str, str]:
    """Die Kopfzeilen eines VoIP-Pushes.

    ``apns-expiration: 0`` ist eine ENTSCHEIDUNG: APNs versucht die
    Zustellung genau einmal und speichert nichts. Für einen klingelnden Anruf
    ist das richtig — ein Push, der nach zwei Minuten eintrifft, lässt das
    Telefon für ein Gespräch klingeln, das längst vorbei ist. Verwerfen ist
    besser als zu spät.
    """
    return {
        "authorization": f"bearer {token_jwt}",
        "apns-topic": f"{zugang.bundle_id}.voip",
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
    }


def deutung(status: int, grund: str | None) -> str:
    """APNs-Antwort → ``"ok"`` | ``"dead"`` | ``"warn"``.

    ``dead`` heisst „diese Registrierung wird nie wieder gültig" und löscht
    die Zeile. Alles andere ist ``warn``: ein 403 ist meist ein falscher
    Schlüssel, ein 429 oder 5xx ist Apples Seite — beides darf keinen Token
    kosten, sonst räumt eine Störung die Registrierungen leer.

    Die ``dead``-Gründe stehen ausdrücklich als LISTE und nicht als „alles
    4xx": ``TooManyRequests`` ist 429 und ``ExpiredProviderToken`` ist 403 —
    beide 4xx, beide harmlos.
    """
    if status == 200:
        return "ok"
    if status == 410:
        return "dead"
    if status == 400 and grund in {
        "BadDeviceToken",
        "DeviceTokenNotForTopic",
        "Unregistered",
    }:
        return "dead"
    return "warn"


_gewarnt: set[str] = set()


def _einmal_warnen(ereignis: str) -> None:
    """Je Prozess eine Zeile pro Ereignis — s. ``zugang_aus_einstellungen``."""
    if ereignis in _gewarnt:
        return
    _gewarnt.add(ereignis)
    log.warning(ereignis)


def zugang_aus_einstellungen(einstellungen: Any) -> ApnsZugang | None:
    """Zugang aus der Konfiguration lesen, oder ``None``.

    ``None`` ist der normale Zustand einer Installation ohne eigenen
    APNs-Schlüssel — dann gibt es keine VoIP-Pushes und sonst ändert sich
    nichts. Es wird EINMAL gewarnt, nicht je Anruf: eine Zeile pro Klingeln
    wäre Lärm, und die Fehlkonfiguration ändert sich zwischen zwei Anrufen
    nicht.
    """
    pfad = getattr(einstellungen, "apns_key_file", None)
    key_id = getattr(einstellungen, "apns_key_id", None)
    team_id = getattr(einstellungen, "apns_team_id", None)
    bundle_id = getattr(einstellungen, "apns_bundle_id", None)
    if not (pfad and key_id and team_id and bundle_id):
        return None
    try:
        with open(pfad, encoding="utf-8") as datei:
            pem = datei.read()
    except OSError:
        _einmal_warnen("apns_schluessel_nicht_lesbar")
        return None
    return ApnsZugang(
        schluessel_pem=pem,
        key_id=key_id,
        team_id=team_id,
        bundle_id=bundle_id,
        sandbox=bool(getattr(einstellungen, "apns_sandbox", True)),
    )


# JWT-Zwischenspeicher. APNs bittet ausdrücklich darum, nicht für jede
# Nachricht ein neues Anbieter-JWT zu erzeugen; ausserdem kostet die
# ES256-Signatur Rechenzeit, die bei einem klingelnden Telefon niemand hat.
_jwt_stand: tuple[str, float] | None = None


def jwt_mit_vorrat(zugang: ApnsZugang, jetzt: float | None = None) -> str:
    """Gültiges JWT aus dem Zwischenspeicher, oder ein frisches.

    Der Zwischenspeicher hängt NICHT am Zugang: wechselt der Schlüssel, läuft
    der Dienst ohnehin neu an. Ein Schlüsselwechsel im Betrieb ist kein Fall,
    den es hier gibt.
    """
    global _jwt_stand
    nun = jetzt if jetzt is not None else time.time()
    if _jwt_stand is not None and nun < _jwt_stand[1]:
        return _jwt_stand[0]
    frisch = jwt_bauen(zugang, nun)
    _jwt_stand = (frisch, nun + JWT_LAUFZEIT_S)
    return frisch


def jwt_vorrat_leeren() -> None:
    """Nur für Tests — sonst lebt der Vorrat so lange wie der Prozess."""
    global _jwt_stand
    _jwt_stand = None


async def senden(*, zugang: ApnsZugang, geraete_token: str, nutzlast: dict) -> str:
    """Ein Sendeversuch. Liefert ``"ok"``, ``"dead"`` oder ``"warn"``.

    **Niemals den Token oder die Nutzlast loggen** (Projektregel) — im Fehler-
    fall nur Status und Grund, und der Grund kommt von Apple, nicht von uns.
    """
    import httpx

    url = f"{host_fuer(zugang.sandbox)}/3/device/{geraete_token}"
    try:
        async with httpx.AsyncClient(http2=True, timeout=10.0) as klient:
            antwort = await klient.post(
                url, json=nutzlast, headers=kopfzeilen(zugang, jwt_mit_vorrat(zugang))
            )
    except Exception:  # noqa: BLE001 — Push ist best-effort
        log.warning("apns_voip_sendefehler")
        return "warn"
    grund: str | None = None
    if antwort.status_code != 200:
        try:
            grund = antwort.json().get("reason")
        except Exception:  # noqa: BLE001 — APNs antwortet nicht immer mit JSON
            grund = None
        log.warning("apns_voip_abgewiesen status=%d grund=%s", antwort.status_code, grund)
    return deutung(antwort.status_code, grund)


__all__ = [
    "JWT_LAUFZEIT_S",
    "PROD_HOST",
    "SANDBOX_HOST",
    "ApnsZugang",
    "deutung",
    "host_fuer",
    "jwt_bauen",
    "jwt_mit_vorrat",
    "jwt_vorrat_leeren",
    "kopfzeilen",
    "senden",
    "zugang_aus_einstellungen",
]
