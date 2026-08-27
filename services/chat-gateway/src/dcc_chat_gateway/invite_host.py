"""Wohin zeigt eine Community-Einladung — und wann ist das erwähnenswert?

``community_invite_notifications.target_host`` trägt laut eigener Spalten-
Beschreibung ``NULL`` für ein Cloud-Ziel und nur bei einem fremden Server einen
Wert. Der Klient verlässt sich darauf: die Einladungskarte blendet die Zeile
„auf welchen Server trittst du" nur ein, wenn das Feld gesetzt ist — bei einem
Cloud-Ziel wäre sie Rauschen.

Geschrieben wurde aber, was der Absender schickte, und der schickt
``server.hostname``. Für die Cloud ist das ``https://howispulse.com``: unter
jeder Einladung stand seither die eigene Adresse (gemeldet 2026-08-27).

Beide Enden benutzen diese Stelle — das Schreiben, damit neue Zeilen der Spalte
entsprechen, und das Ausliefern, damit die bereits geschriebenen von selbst
heilen. Ein Nachziehen per Migration wäre der halbe Weg: der Klient hinge
weiter an einem Feld, das ihm ein anderer Aufrufer erneut falsch füllen kann.
"""

from __future__ import annotations

from dcc_chat_gateway.config import get_settings


def bare_host(host: str) -> str:
    """Schema und Schrägstrich abstreifen, klein schreiben → nackter FQDN.

    ``target_host`` kommt entweder als vollständige ``https://…``-Herkunft (so
    schickt es das Frontend) oder als nackter FQDN (ältere Aufrufer, Tests).
    """
    h = host.strip().lower().rstrip("/")
    for scheme in ("https://", "http://"):
        if h.startswith(scheme):
            h = h[len(scheme) :]
            break
    return h.rstrip("/")


def fremder_host(host: str | None) -> str | None:
    """Der Host, wenn er ein FREMDER ist — sonst ``None``.

    Leer und „die Cloud selbst" sind dasselbe Ergebnis: nichts zu erwähnen.
    """
    if not host:
        return None
    ziel = bare_host(host)
    if not ziel:
        return None
    cloud = bare_host(get_settings().pulse_cloud_origin)
    return None if ziel == cloud else ziel
