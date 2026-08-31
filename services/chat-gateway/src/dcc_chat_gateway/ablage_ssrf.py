"""Pfad-Normalisierung + SSRF-Schutz fuer die Ablage-Weiterreich-Route.

Design ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`` §4.2:
``GET /channels/{channel_id}/ablage/abruf?pfad=<relativ>`` haengt einen vom
Aufrufer gelieferten relativen Pfad an eine SERVEREIGENE Basis-Adresse (die
Freigabe-Adresse des Kanals, ``AblageKanalLaufwerk``) und holt das Ergebnis.
Ohne die Regeln hier waere das ein offener Umleitungsdienst ins Server-Netz.

Was hier NICHT passiert: keine Ausnahme fuer „vertrauenswuerdige" Hosts, kein
Zwischenspeichern, kein Loggen der Ziel-Adresse — der Aufrufer dieses Moduls
(``routes/ablage_kanal.py``) haelt sich daran, indem er ``AblageAbrufFehler``
nur den ``code`` weiterreicht, nie die URL, die ihn ausgeloest hat.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import urllib.parse
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

Resolver = Callable[[str], Awaitable[list[str]]]


class AblageAbrufFehler(Exception):
    """Eine der Design-Regeln hat gegriffen. ``code`` ist maschinenlesbar —
    die Route uebersetzt ihn in einen HTTP-Status. Die Botschaft enthaelt nie
    die Freigabe-Adresse, den aufgeloesten Pfad oder eine IP."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


# ---------------------------------------------------------------------------
# Pfad: dekodieren, dann pruefen — nie umgekehrt (Design §4.2)
# ---------------------------------------------------------------------------

_MAX_DEKODIER_RUNDEN = 6
_TRENNER = re.compile(r"[\\/]+")
_LAUFWERKSBRIEF = re.compile(r"^[A-Za-z]:[\\/]")


def normalisiere_pfad(roh: str) -> list[str]:
    """Zerlegt den Anfrage-Pfad in bereinigte Segmente.

    Dekodiert zuerst vollstaendig (auch doppelt kodierte Varianten wie
    ``%252e%252e``) und prueft ERST danach — eine Prüfung vor dem Dekodieren
    liesse genau die kodierten Umgehungen durch, gegen die diese Funktion
    steht. Absolute Pfade, ein Schema-Wechsel (``file://`` etc.) und ``..``
    werden abgewiesen. Die Rueckgabe sind Segmente, kein roher String — der
    Aufrufer haengt sie per Konkatenation an, nie per ``urljoin`` (das wuerde
    ein im Pfad verstecktes Schema/Host wieder gelten lassen).
    """
    if not roh:
        raise AblageAbrufFehler("pfad_leer")

    dekodiert = roh
    for _ in range(_MAX_DEKODIER_RUNDEN):
        neu = urllib.parse.unquote(dekodiert)
        if neu == dekodiert:
            break
        dekodiert = neu
    else:
        # Nach so vielen Runden noch nicht stabil — plausibler Versuch,
        # die Rundenzahl selbst als Umgehung zu nutzen. Fail closed.
        raise AblageAbrufFehler("pfad_kodierung")

    if "\x00" in dekodiert:
        raise AblageAbrufFehler("pfad_ungueltig")
    if "://" in dekodiert:
        raise AblageAbrufFehler("pfad_schema_wechsel")
    if dekodiert.startswith(("/", "\\")):
        raise AblageAbrufFehler("pfad_absolut")
    if _LAUFWERKSBRIEF.match(dekodiert):
        raise AblageAbrufFehler("pfad_absolut")

    segmente = [t for t in _TRENNER.split(dekodiert) if t not in ("", ".")]
    if any(t == ".." for t in segmente):
        raise AblageAbrufFehler("pfad_traversal")
    if not segmente:
        raise AblageAbrufFehler("pfad_leer")
    return segmente


def baue_ziel_url(basis: str, segmente: list[str]) -> str:
    """Haengt geprueften Segmente HINTER die servereigene Basis. Jedes
    Segment wird einzeln quotiert, damit ein Segment mit ``?``/``#``/``@``
    nie zu einer neuen Query/einem neuen Host wird."""
    pfad = "/".join(urllib.parse.quote(s, safe="") for s in segmente)
    return basis.rstrip("/") + "/" + pfad


# ---------------------------------------------------------------------------
# Private Netze — derselbe Schutz wie ``dcc_auth.selfhost_probe`` (dort fuer
# die umgekehrte Richtung gebaut, in einem anderen Service). Dupliziert statt
# importiert: chat-gateway haelt keine Abhaengigkeit auf auth-svc-Code
# (CLAUDE.md — Services sprechen nur ueber Redis/HTTP miteinander).
# ---------------------------------------------------------------------------

PRIVATE_NETZE = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),  # RFC 6598 (carrier-grade NAT)
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
)


def ist_privat(roh_ip: str) -> bool:
    try:
        adr = ipaddress.ip_address(roh_ip)
    except ValueError:
        return True  # unparsbar -> fail closed, nicht durchlassen
    return any(adr in netz for netz in PRIVATE_NETZE)


async def standard_resolver(host: str) -> list[str]:
    """Echte Namensaufloesung. Tests reichen stattdessen einen eigenen
    ``Resolver`` durch — kein DNS im Testlauf noetig."""
    treffer = await asyncio.get_running_loop().getaddrinfo(
        host, None, type=socket.SOCK_STREAM
    )
    ergebnis: list[str] = []
    for eintrag in treffer:
        adr = eintrag[4][0]
        if adr not in ergebnis:
            ergebnis.append(adr)
    return ergebnis


async def pruefe_ziel_oeffentlich(url: str, resolver: Resolver) -> None:
    """Wirft, wenn der Host von ``url`` — direkt als IP oder ueber DNS
    aufgeloest — in ein privates/link-lokales Netz zeigt. Wird vor JEDER
    Anfrage gerufen: der ersten UND einer einmal gefolgten Umleitung. Ein
    DNS-Name kann auf eine private Adresse zeigen — deshalb wird die
    AUFGELOESTE Adresse geprueft, nie nur der Name."""
    geteilt = urllib.parse.urlsplit(url)
    if geteilt.scheme not in ("http", "https"):
        raise AblageAbrufFehler("ziel_schema")
    host = geteilt.hostname
    if not host:
        raise AblageAbrufFehler("ziel_ungueltig")
    try:
        ipaddress.ip_address(host)
        adressen = [host]
    except ValueError:
        try:
            adressen = await resolver(host)
        except OSError as exc:
            raise AblageAbrufFehler("ziel_unaufloesbar") from exc
    if not adressen or any(ist_privat(a) for a in adressen):
        raise AblageAbrufFehler("ziel_privat")


# ---------------------------------------------------------------------------
# Der Abruf selbst
# ---------------------------------------------------------------------------


@dataclass
class AbrufErgebnis:
    inhalt: bytes
    content_type: str | None


async def _hole_einmal(
    client: httpx.AsyncClient, url: str, max_bytes: int
) -> tuple[bytes, str | None, str | None]:
    """Ein einzelner GET. Liefert entweder ``(bytes, content_type, None)``
    oder — bei einer Umleitung — ``(b"", None, ziel)``. Bricht ab, sobald der
    Koerper ``max_bytes`` ueberschreitet, auch wenn ``Content-Length`` fehlt
    oder luegt (Chunked-Transfer)."""
    async with client.stream("GET", url) as antwort:
        if antwort.status_code in (301, 302, 303, 307, 308):
            ort = antwort.headers.get("location")
            if not ort:
                raise AblageAbrufFehler("umleitung_ohne_ziel")
            return b"", None, ort
        if antwort.status_code != 200:
            raise AblageAbrufFehler("upstream_fehler")
        stueck = bytearray()
        async for teil in antwort.aiter_bytes():
            stueck.extend(teil)
            if len(stueck) > max_bytes:
                raise AblageAbrufFehler("antwort_zu_gross")
        return bytes(stueck), antwort.headers.get("content-type"), None


async def hole(
    *,
    basis: str,
    pfad: str,
    max_bytes: int,
    timeout_s: float,
    resolver: Resolver = standard_resolver,
    http: httpx.AsyncClient | None = None,
) -> AbrufErgebnis:
    """Holt ``pfad`` relativ zu ``basis``. ``basis`` kommt IMMER vom Server
    (der gespeicherten Freigabe-Adresse), nie vom Aufrufer der Route.

    Eine Umleitung wird hoechstens einmal verfolgt, und das Ziel wird genauso
    geprueft wie die urspruengliche Adresse (Design §4.2) — beides innerhalb
    EINER Gesamtfrist, damit ein langsam tropfender Upstream die Zeitschranke
    nicht durch zwei einzeln kurze Anfragen umgeht.
    """
    segmente = normalisiere_pfad(pfad)
    url = baue_ziel_url(basis, segmente)

    eigener_client = http is None
    client = http if http is not None else httpx.AsyncClient(
        timeout=timeout_s, follow_redirects=False
    )
    try:
        async with asyncio.timeout(timeout_s):
            await pruefe_ziel_oeffentlich(url, resolver)
            inhalt, typ, ort = await _hole_einmal(client, url, max_bytes)
            if ort is not None:
                neue_url = urllib.parse.urljoin(url, ort)
                await pruefe_ziel_oeffentlich(neue_url, resolver)
                inhalt, typ, ort2 = await _hole_einmal(client, neue_url, max_bytes)
                if ort2 is not None:
                    raise AblageAbrufFehler("zu_viele_umleitungen")
            return AbrufErgebnis(inhalt, typ)
    except TimeoutError as exc:
        raise AblageAbrufFehler("zeit_ueberschritten") from exc
    except httpx.HTTPError as exc:
        raise AblageAbrufFehler("upstream_nicht_erreichbar") from exc
    finally:
        if eigener_client:
            await client.aclose()
