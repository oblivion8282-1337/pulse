"""Protokolliert, ob ein Cert-User als Instanz-Owner (= Admin) erkannt wurde.

Warum es das gibt: Am 2026-07-27 meldete ein Self-Hoster, er sei auf seinem
eigenen Server kein Admin — und sein Server protokollierte zu dieser
Entscheidung **nichts**. Damit war von aussen nicht zu unterscheiden, ob
``PULSE_INSTANCE_OWNER_ID`` fehlt, ob sie nicht zum vorgelegten Cert passt,
oder ob der Fehler ganz woanders liegt. Genau diese Zeile fehlte.

Das ist die einzige Stelle, an der der Admin-Status entschieden wird: der
``admin``-Claim im Session-Token entsteht hier und wird spaeter nur noch
durchgereicht. Faellt er aus, gibt es weiter unten (``ws.py`` / ``security.py``)
KEIN Auffangnetz mehr — dort stand frueher eine zweite, wirkungslose Rechnung,
die 2026-07-27 entfernt wurde.

Eigenes Modul, weil ``routes/cert_login.py`` mit 573 Zeilen bereits ueber der
harten 500-Zeilen-Grenze der Groessen-Policy lag; diese Diagnose sollte das
nicht weiter verschlechtern.

**Sichtbarkeit ist Teil der Diagnose, nicht ihr Beiwerk.** Diese Zeilen liefen
vom 2026-07-27 bis zum 2026-08-25 ins Leere: sie stehen auf ``info``, und ohne
``dcc_shared.logging_setup`` steht der Wurzel-Logger unter uvicorn auf
``warning`` — die Diagnose gegen „der Betreiber ist kein Admin" war damit
selbst unsichtbar, und zwar durch zwei Meldungen desselben Fehlers hindurch.
Der Self-Host-Container laeuft auf ``PULSE_LOG_LEVEL=info``; wer diese Stufe
senkt, schaltet damit auch diese Auskunft ab.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

#: Bereits protokollierte Cert-User (pro Prozess). Der Cert-Login laeuft bei
#: JEDEM Session-Refresh erneut (5-Minuten-Token) — ohne diese Sperre stuende
#: die Zeile alle paar Minuten je Nutzer im Log und waere damit wertlos.
_gemeldet: set[str] = set()


def log_owner_konfiguration(settings) -> None:
    """Beim Start einmal sagen, wem diese Instanz laut Konfiguration gehört.

    Die Zeile unten faellt erst, wenn sich jemand anmeldet — und beantwortet
    damit nur die halbe Frage. Wer die Instanz gerade aufsetzt und noch gar
    keinen Login versucht hat, soll die konfigurierte Kennung trotzdem sehen
    koennen: sie ist der eine Wert, den er mit seinem eigenen Konto vergleichen
    muss. Ein Geheimnis ist sie nicht — sie steht in seiner ``.env``.
    """
    if settings.pulse_instance_mode != "self-host":
        return
    if not settings.pulse_instance_owner_id:
        log.warning(
            "PULSE_INSTANCE_OWNER_ID ist nicht gesetzt — diese Instanz kann "
            "keinen Admin erkennen; niemand kann sie verwalten"
        )
        return
    log.info(
        "Diese Instanz gehoert Cloud-Konto %s — nur dieses Konto wird hier Admin",
        settings.pulse_instance_owner_id,
    )


def log_owner_admin_decision(settings, cert_user_id, is_owner_admin: bool) -> None:
    """Einmal je Cert-User festhalten, wie die Owner-Pruefung ausging.

    Beide IDs stehen ohnehin in der Instanz-Konfiguration bzw. im vorgelegten
    Cert — hier werden keine Geheimnisse sichtbar.
    """
    if settings.pulse_instance_mode != "self-host":
        return
    schluessel = str(cert_user_id)
    if schluessel in _gemeldet:
        return
    _gemeldet.add(schluessel)

    if not settings.pulse_instance_owner_id:
        log.warning(
            "PULSE_INSTANCE_OWNER_ID ist nicht gesetzt — diese Instanz kann "
            "keinen Admin erkennen; niemand kann sie verwalten"
        )
    elif is_owner_admin:
        log.info("Cert-User %s als Instanz-Owner erkannt — Admin", schluessel)
    else:
        log.info(
            "Cert-User %s ist NICHT der Instanz-Owner (konfiguriert: %s) — kein Admin",
            schluessel,
            settings.pulse_instance_owner_id,
        )
