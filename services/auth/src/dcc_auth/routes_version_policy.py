"""``GET /.well-known/pulse-version-policy.json`` — die Versions-Richtlinie.

**Warum es diese Datei gibt.** Jeder Self-Host fragt diesen Pfad alle 6 Stunden
ab (``dcc_chat_gateway/cloud_policy_poller.py``). Die nginx-Regel routete ihn
schon hierher, nur gab es im auth-svc keine Route dafür — der Name kam im ganzen
Dienst nicht vor. Die Cloud antwortete also **404**, und jeder Server der Welt
schrieb alle sechs Stunden eine Warnung in sein Log:

    cloud_policy_poll: HTTP 404 from https://howispulse.com/… — keeping
    last-known-good

„last-known-good" gab es dabei nie, denn es kam nie ein erstes Mal etwas an.
Aufgefallen ist es am 2026-08-28 beim Aufsetzen eines Servers von Hand.

**Was hier NICHT passiert.** Die Richtlinie wird ausgeliefert und vom Empfänger
abgelegt — mehr nicht. Den Vergleich („ist dieser Server zu alt?") gibt es noch
nirgends, weder im Klienten noch im Gateway. Diese Route schliesst das Loch im
Transportweg, sie führt keine Versionspflicht ein.

**Die Vorgabe für ``min_version`` ist bewusst ``0.0.0``**, also „keine
Untergrenze". Ein Wert, der die aktuelle Version spiegelt, wäre die naheliegende
Wahl und die gefährlichste: Sobald irgendwann jemand den Vergleich baut, würde
jeder Server, der nicht am selben Tag aktualisiert hat, ausgesperrt — ohne dass
das je jemand entschieden hätte. Eine Untergrenze ist eine Betreiber-Entscheidung
und gehört in die ``.env`` (``PULSE_POLICY_MIN_VERSION``), nicht in einen
Vorgabewert.

Der Endpunkt ist **öffentlich und ohne Anmeldung** — wie ``jwks.json`` und
``pulse-suspended-instances`` daneben. Er verrät nur zwei Versionsnummern, die
ohnehin an jedem ``/.well-known/pulse-server-info`` der Welt stehen.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from dcc_auth.config import get_settings

router = APIRouter()

#: Format-Version des Dokuments selbst. Steigt nur, wenn sich die FELDER ändern
#: — nicht, wenn sich die Versionsnummern darin ändern.
SCHEMA_VERSION = 1

#: Wie lange ein Server die Antwort behalten darf. Der Poller fragt alle 6 h;
#: fünf Minuten Zwischenspeicher nehmen einer Cloud-Wiederholung die Spitze,
#: ohne eine geänderte Richtlinie nennenswert zu verzögern.
CACHE_SEKUNDEN = 300


@router.get("/.well-known/pulse-version-policy.json")
async def version_policy(response: Response) -> dict:
    """Die aktuelle und die mindestens verlangte Server-Version."""
    settings = get_settings()
    response.headers["Cache-Control"] = f"public, max-age={CACHE_SEKUNDEN}"
    return {
        "version": SCHEMA_VERSION,
        "current_version": settings.pulse_policy_current_version,
        "min_version": settings.pulse_policy_min_version,
        "updated_at": settings.pulse_policy_updated_at or None,
    }
