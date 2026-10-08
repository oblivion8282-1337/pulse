"""Zugangsdaten für MediaMTX' Steuer-API (``action == "api"``).

**Warum es das gibt (Security-Scan 2026-10-08):** Die API (``:9997``) kann die
laufende Konfiguration umschreiben (``/v3/config/global/patch``), Sitzungen
trennen und Pfade anlegen. Sie hing bisher allein daran, dass sie an
``127.0.0.1`` gebunden ist und MediaMTX sie per ``authHTTPExclude`` an diesem
Hook vorbeiwinkt. Im Self-Host-Container läuft aber mehr als nur media-svc auf
diesem Loopback — der Direktweg-Adapter etwa ließ sich bis zum selben Tag über
einen präparierten Pfad dorthin umlenken. Die Bindung ist damit kein
Zugangsschutz, sondern nur eine Erreichbarkeitsgrenze.

**Abschaltbar und abgeschaltet als Vorgabe:** Ist ``mediamtx_api_password``
leer, bleibt alles wie zuvor (``api`` → 200). Gesetzt wird es nur im
Self-Host-Container (``03-init-secrets.sh`` erzeugt es, ``07-render-env.sh``
reicht es an Hook UND media-svc, ``08-init-mediamtx.sh`` nimmt ``api`` aus
``authHTTPExclude``). Die Cloud (``infra/prod/mediamtx.yml``) schließt ``api``
weiter vom Hook aus — dort kommt die Anfrage hier nie an, gleich was gesetzt ist.

**Vor der Drossel geprüft** (``routes.authenticate``): Im Container erreichen
auch die WHEP-Zuschauer den Hook über Caddy, also mit ``ip == 127.0.0.1`` —
derselbe Schlüssel, unter dem der Poller von media-svc ankäme. Liefe die API
durch dieselbe Drossel, nähme der 3-s-Takt des Pollers (20 Anfragen je Minute
und mehr bei Paginierung) den Zuschauern einen Teil ihres Fensters weg. Die
Prüfung hier fragt Redis nicht, eine Flut kostet also nur einen Vergleich.
"""

from __future__ import annotations

import secrets

import structlog
from fastapi import HTTPException, status

log = structlog.get_logger(__name__)


def api_pruefen(user: str, password: str, erwartet_user: str, erwartet_passwort: str) -> None:
    """Wirft 401, wenn Benutzer oder Passwort nicht stimmen. Vergleich in
    konstanter Zeit, und BEIDE Vergleiche laufen immer (kein früher Ausstieg
    am Benutzernamen)."""
    user_ok = secrets.compare_digest(user.encode(), erwartet_user.encode())
    pass_ok = secrets.compare_digest(password.encode(), erwartet_passwort.encode())
    if not (user_ok and pass_ok):
        # Nie das übergebene Passwort loggen.
        log.info("auth_denied", reason="api_bad_credentials")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="denied")
