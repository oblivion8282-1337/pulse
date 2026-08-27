"""Erreichbarkeitsprüfung eines Self-Host-Servers — die einzelnen Schritte.

Ein Self-Host muss sieben Glieder hintereinander bestehen (DNS, TCP/443,
Zertifikat, Routing durch einen fremden Proxy, CORS-Header, WebSocket-Upgrade,
UDP-Medienports). Bis 2026-08 prüfte niemand davon irgendetwas von AUSSEN: der
Client meldete jeden Fehlschlag als „nicht erreichbar", und die Cloud kannte
zwar den Hostnamen, sah ihn aber nie an.

Ein achtes Glied kam am 2026-08-27 dazu und steht in ``selfhost_probe_betreiber``:
Es fragt nicht, ob man den Server ERREICHT, sondern ob man auf ihm etwas DARF —
eine andere Frage mit einer anderen Ursache, und die einzige, die auch bei sieben
grünen Gliedern noch reissen kann.

Hier steht die Prüfung. Jeder Schritt liefert einen eigenen Befund, und jeder
Befund hat eine andere Handlung dahinter — Befunde ohne eigene Handlung gehören
nicht in die Liste, sie machen sie nur länger.

**Was hier NICHT passiert:** kein Rückfallweg, kein Tunnel, kein Umleiten. Ein
Self-Host bleibt isoliert; die Prüfung sagt, was zu tun ist, und tut es nicht
selbst.

Aufgerufen von ``routes_selfhost_diagnose``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import ssl
from dataclasses import dataclass, field

# Jeder einzelne Schritt hat eine Grenze; die Route deckelt zusätzlich das Ganze.
FRIST_S = 5.0

# Netze, in die NIE geprobt wird (SSRF-Schutz). RFC-5737-Dokumentationsadressen
# fehlen bewusst — die kommen in Tests und öffentlichen Anleitungen vor.
INTERNE_NETZE = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),  # RFC 6598
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
)


def ist_oeffentlich(roh: str) -> bool:
    """True nur für global routbare Adressen."""
    try:
        adr = ipaddress.ip_address(roh)
    except ValueError:
        return False
    return not any(adr in netz for netz in INTERNE_NETZE)


@dataclass
class Schritt:
    """Ein Prüfschritt und sein Befund.

    ``befund`` ist ein maschinenlesbarer Schlüssel — die Übersetzung in einen
    Satz macht die Oberfläche, damit Installer, App und ``pulse-doctor``
    denselben Zustand nicht mit drei verschiedenen Wörtern beschreiben.
    """

    schritt: str
    ok: bool
    befund: str
    einzelheit: str | None = None
    adressen: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Namensauflösung
# ---------------------------------------------------------------------------


async def pruefe_dns(host: str) -> Schritt:
    """Löst den Namen auf und verwirft nicht-öffentliche Antworten.

    Ein Eintrag, der ins private Netz zeigt, ist entweder Fehlkonfiguration
    oder ein Versuch, die Cloud zu einer Verbindung ins eigene Innere zu
    bewegen. Beides endet hier.
    """
    try:
        async with asyncio.timeout(FRIST_S):
            treffer = await asyncio.get_running_loop().getaddrinfo(
                host, None, type=socket.SOCK_STREAM
            )
    except (TimeoutError, socket.gaierror, OSError):
        return Schritt("dns", False, "name_unbekannt")

    adressen: list[str] = []
    for eintrag in treffer:
        adr = eintrag[4][0]
        if adr not in adressen:
            adressen.append(adr)
    if not adressen:
        return Schritt("dns", False, "name_unbekannt")
    if not all(ist_oeffentlich(a) for a in adressen):
        return Schritt("dns", False, "zeigt_ins_private_netz", ", ".join(adressen))
    return Schritt("dns", True, "aufgeloest", ", ".join(adressen), adressen)


# ---------------------------------------------------------------------------
# TCP und TLS
# ---------------------------------------------------------------------------


async def pruefe_tcp(adresse: str, port: int, name: str = "tcp") -> Schritt:
    """Reiner Verbindungsaufbau. ``name`` trennt 443 von 1936 in der Ausgabe."""
    try:
        async with asyncio.timeout(FRIST_S):
            _, schreiber = await asyncio.open_connection(adresse, port)
        await _schliesse(schreiber)
        return Schritt(name, True, "offen", f"{adresse}:{port}")
    except (TimeoutError, OSError):
        return Schritt(name, False, "kein_durchkommen", f"{adresse}:{port}")


def _tls_kontext() -> ssl.SSLContext:
    """Kontext, der das Zertifikat LIEST, ohne es zu verlangen.

    Absicht und eng begrenzt: ein abgebrochener Handschlag gibt nur „Fehler"
    her, und genau das wollen wir loswerden — ein abgelaufenes Zertifikat, eines
    auf den falschen Namen und ein fehlender Aussteller sähen sonst identisch
    aus. Über diese Verbindung geht kein Byte Nutzdaten; die HTTP-Schritte
    darunter laufen mit voller Prüfung, und deren Urteil zählt.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _schliesse(schreiber: asyncio.StreamWriter) -> None:
    schreiber.close()
    await asyncio.gather(schreiber.wait_closed(), return_exceptions=True)


async def pruefe_tls(host: str, adresse: str, port: int) -> Schritt:
    """Zwei Anläufe, und der Unterschied zwischen ihnen IST die Diagnose.

    Der erste ohne Prüfung: kommt ein Handschlag überhaupt zustande? Der zweite
    mit voller Prüfung: nähme ein Browser dieses Zertifikat? Geht der erste
    durch und der zweite nicht, liegt es am Zertifikat und nicht am Netz — und
    der Verify-Code benennt, woran. Ohne den ersten Anlauf wäre jeder
    Zertifikatsfehler von einem toten Port nicht zu unterscheiden, und genau
    diese Verwechslung soll die ganze Prüfung abschaffen.
    """
    try:
        async with asyncio.timeout(FRIST_S):
            _, schreiber = await asyncio.open_connection(
                adresse, port, ssl=_tls_kontext(), server_hostname=host
            )
        await _schliesse(schreiber)
    except ssl.SSLError as exc:
        # Kein Handschlag trotz abgeschalteter Prüfung: dort spricht kein TLS
        # (falscher Port, reines HTTP, ein Proxy, der etwas anderes erwartet).
        return Schritt("tls", False, "handschlag_abgelehnt", str(exc.reason or exc))
    except (TimeoutError, OSError):
        return Schritt("tls", False, "kein_handschlag", f"{adresse}:{port}")

    try:
        async with asyncio.timeout(FRIST_S):
            _, schreiber = await asyncio.open_connection(
                adresse, port, ssl=ssl.create_default_context(), server_hostname=host
            )
        await _schliesse(schreiber)
        return Schritt("tls", True, "gueltig", host)
    except ssl.SSLCertVerificationError as exc:
        grund = {
            10: "abgelaufen",  # X509_V_ERR_CERT_HAS_EXPIRED
            18: "selbstsigniert",  # DEPTH_ZERO_SELF_SIGNED_CERT
            19: "selbstsigniert",  # SELF_SIGNED_CERT_IN_CHAIN
            20: "kette_unvollstaendig",  # UNABLE_TO_GET_ISSUER_CERT_LOCALLY
            21: "kette_unvollstaendig",  # UNABLE_TO_VERIFY_LEAF_SIGNATURE
        }.get(exc.verify_code or 0)
        if grund is None:
            grund = "falscher_name" if "hostname" in str(exc).lower() else "nicht_vertrauenswuerdig"
        return Schritt("tls", False, grund, host)
    except (ssl.SSLError, TimeoutError, OSError):
        return Schritt("tls", False, "nicht_vertrauenswuerdig", host)
