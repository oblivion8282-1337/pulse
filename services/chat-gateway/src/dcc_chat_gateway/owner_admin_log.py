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
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

#: Bereits protokollierte Cert-User (pro Prozess). Der Cert-Login laeuft bei
#: JEDEM Session-Refresh erneut (5-Minuten-Token) — ohne diese Sperre stuende
#: die Zeile alle paar Minuten je Nutzer im Log und waere damit wertlos.
_gemeldet: set[str] = set()


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
