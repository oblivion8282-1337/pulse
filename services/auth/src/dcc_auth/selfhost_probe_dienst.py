"""Erreichbarkeitsprüfung eines Self-Host-Servers — der Dienst hinter der Leitung.

Die Leitung selbst (Namensauflösung, TCP, TLS) prüft ``selfhost_probe``; hier
steht, was danach kommt: antwortet dort ein gesunder Pulse-Server, ist es die
RICHTIGE Instanz, lässt er den Browser heran, reicht der Proxy WebSockets durch,
und kommt UDP an.

Getrennt vom Nachbarn, weil beide Hälften unabhängig wachsen und die Datei
sonst über die Größen-Policy liefe (PLAN.md §12.1).
"""

from __future__ import annotations

import asyncio
import base64
import os
import secrets
import socket

import httpx

from dcc_auth.selfhost_probe import FRIST_S, Schritt, _schliesse, _tls_kontext

# ---------------------------------------------------------------------------
# HTTP: Gesundheit, Identität, CORS
# ---------------------------------------------------------------------------


async def _hole(klient: httpx.AsyncClient, url: str, **kw) -> httpx.Response | None:
    try:
        async with asyncio.timeout(FRIST_S):
            return await klient.get(url, **kw)
    except Exception:
        return None


async def pruefe_health(klient: httpx.AsyncClient, basis: str) -> Schritt:
    """``/health`` ist auf jedem Self-Host öffentlich (Caddyfile-Template)."""
    antwort = await _hole(klient, f"{basis}/health")
    if antwort is None:
        return Schritt("health", False, "keine_antwort")
    if antwort.status_code >= 500:
        # Der Dienst antwortet, meldet sich aber selbst als krank: `failed`
        # nennt die Ursache (db / redis) und ist die genauere Auskunft.
        try:
            fehlt = ",".join(antwort.json().get("failed", []))
        except Exception:
            fehlt = ""
        return Schritt("health", False, "server_krank", fehlt or None)
    if antwort.status_code >= 400:
        return Schritt("health", False, "unerwartete_antwort", f"HTTP {antwort.status_code}")
    return Schritt("health", True, "gesund")


async def pruefe_identitaet(
    klient: httpx.AsyncClient, basis: str, erwartete_id: str
) -> Schritt:
    """Antwortet unter dieser Adresse wirklich DIESE Instanz?

    Ohne den Vergleich sieht ein falsch gesetzter Proxy, der auf eine fremde
    Pulse-Instanz zeigt, in jedem anderen Schritt grün aus — und der Betreiber
    sucht den Fehler überall ausser dort.
    """
    antwort = await _hole(klient, f"{basis}/.well-known/pulse-server-info")
    if antwort is None or antwort.status_code >= 400:
        return Schritt("identitaet", False, "keine_auskunft")
    try:
        daten = antwort.json()
    except Exception:
        # Der häufigste Fall dahinter: der Proxy liefert die SPA-Startseite
        # statt der JSON-Antwort, weil die Route fehlt.
        return Schritt("identitaet", False, "keine_json_antwort")
    gemeldet = str(daten.get("instance_id") or "")
    if gemeldet != erwartete_id:
        return Schritt("identitaet", False, "fremde_instanz", gemeldet or "keine")
    return Schritt("identitaet", True, "stimmt", str(daten.get("server_version") or ""))


async def pruefe_cors(klient: httpx.AsyncClient, basis: str, origin: str) -> Schritt:
    """Prüft genau das, was der Browser prüft.

    Ein CORS-Block erreicht den Nutzer als „Failed to fetch" und ist von einem
    toten Netz nicht zu unterscheiden. Hier ist er es.
    """
    try:
        async with asyncio.timeout(FRIST_S):
            antwort = await klient.options(
                f"{basis}/.well-known/pulse-server-info",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "GET",
                },
            )
    except Exception:
        return Schritt("cors", False, "keine_antwort")

    erlaubt = antwort.headers.get_list("access-control-allow-origin")
    if len(erlaubt) > 1:
        # Zwei Header sind schlimmer als keiner: der Browser verwirft die
        # Antwort. Entsteht, wenn ein vorgelagerter Proxy CORS zusätzlich zu
        # den FastAPI-Diensten setzt (der Grund für den Warnblock im
        # Caddyfile-Template).
        return Schritt("cors", False, "doppelter_header", ", ".join(erlaubt))
    if not erlaubt:
        return Schritt("cors", False, "kein_header")
    if erlaubt[0] not in (origin, "*"):
        return Schritt("cors", False, "andere_herkunft", erlaubt[0])
    return Schritt("cors", True, "erlaubt", erlaubt[0])


# ---------------------------------------------------------------------------
# WebSocket-Upgrade
# ---------------------------------------------------------------------------


async def pruefe_websocket(host: str, adresse: str, port: int) -> Schritt:
    """Führt den Upgrade-Handschlag von Hand und liest den Schliesscode.

    Der Gateway ruft ``accept()`` VOR der Token-Prüfung (``routes/ws.py``) —
    ein Aufruf mit Wegwerf-Token bekommt deshalb einen sauberen Schliesscode
    zurück, und der trennt: 4001 = die ganze Kette steht · 4046 = der Server
    erreicht die Cloud nicht · 4070 = Instanz gesperrt · kein 101 = der Proxy
    reicht WebSockets nicht durch (die häufigste Falle beim Self-Hosten).

    Von Hand statt mit einer Bibliothek, weil der Dienst keine WebSocket-
    Abhängigkeit hat und ein Handschlag plus ein Close-Rahmen zusammen weniger
    Code sind als die Diskussion über eine neue Abhängigkeit.

    **Der Pfad ist ``/ws`` und gilt NUR für Self-Hosts.** Die Cloud liegt hinter
    nginx unter ``/api/ws/ws`` (``gateway-connection.ts``: ``isCloud ?
    '/api/ws/ws' : '/ws'``, Self-Host-Caddyfile: ``handle /ws``). Gegen die
    Cloud gerichtet liefert diese Prüfung deshalb ein falsches „kein_upgrade"
    — einmal so gemessen. Sie kann das nicht: geprüft werden ausschliesslich
    Zeilen aus ``registered_instances``, und die Cloud hat dort keine.
    """
    schluessel = base64.b64encode(os.urandom(16)).decode()
    anfrage = (
        f"GET /ws?token=probe-{secrets.token_hex(8)} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {schluessel}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    ).encode()

    try:
        async with asyncio.timeout(FRIST_S):
            leser, schreiber = await asyncio.open_connection(
                adresse, port, ssl=_tls_kontext(), server_hostname=host
            )
            try:
                schreiber.write(anfrage)
                await schreiber.drain()
                kopf = await leser.readuntil(b"\r\n\r\n")
                if b" 101 " not in kopf.split(b"\r\n", 1)[0]:
                    status = kopf.split(b"\r\n", 1)[0].decode(errors="replace")
                    return Schritt("websocket", False, "kein_upgrade", status)
                code = await _lies_schliesscode(leser)
            finally:
                await _schliesse(schreiber)
    except (TimeoutError, OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        return Schritt("websocket", False, "kein_upgrade", "keine Antwort")

    if code is None:
        # Upgrade kam durch, aber niemand hat auf Pulse-Art geantwortet.
        return Schritt("websocket", False, "kein_gateway")
    if code == 4046:
        return Schritt("websocket", False, "server_ohne_cloud", "4046")
    if code == 4070:
        return Schritt("websocket", False, "instanz_gesperrt", "4070")
    # Jeder Code aus dem 4000er-Band kommt vom Gateway selbst — auch einer, den
    # diese Version noch nicht kennt. Dass er ANKAM, ist die Aussage.
    if 4000 <= code <= 4999:
        return Schritt("websocket", True, "kette_steht", str(code))
    return Schritt("websocket", False, "kein_gateway", str(code))


async def _lies_schliesscode(leser: asyncio.StreamReader) -> int | None:
    """Liest den ersten Rahmen und gibt den Schliesscode zurück, falls es einer ist.

    Server-Rahmen sind unmaskiert, und ein Close trägt seinen Code als zwei
    Byte in Netz-Reihenfolge. Mehr vom Protokoll wird hier nicht gebraucht.
    """
    try:
        kopf = await leser.readexactly(2)
    except (asyncio.IncompleteReadError, OSError):
        return None
    opcode = kopf[0] & 0x0F
    laenge = kopf[1] & 0x7F
    if opcode != 0x8 or laenge < 2:
        return None
    if laenge == 126:
        try:
            await leser.readexactly(2)
        except (asyncio.IncompleteReadError, OSError):
            return None
    try:
        nutz = await leser.readexactly(2)
    except (asyncio.IncompleteReadError, OSError):
        return None
    return int.from_bytes(nutz, "big")


# ---------------------------------------------------------------------------
# UDP: STUN gegen coturn
# ---------------------------------------------------------------------------

_STUN_KEKS = 0x2112A442


async def pruefe_stun(adresse: str, port: int = 3478) -> Schritt:
    """Echter STUN-Binding-Request an coturn.

    **Warum ausgerechnet 3478 und nicht die ICE-Ports:** coturn antwortet auf
    einen Binding-Request garantiert, das ist sein Zweck — die Aussage ist also
    beweiskräftig. Ob LiveKit (7882) und MediaMTX (8189) auf einen Request OHNE
    ICE-Zugangsdaten überhaupt antworten, ist ungemessen; eine Prüfung, die
    still verworfen wird, sähe von hier aus wie eine geschlossene Firewall und
    wäre ein Fehlalarm. 3478 gilt deshalb ausdrücklich als STELLVERTRETER für
    „UDP kommt grundsätzlich durch" — beide stammen aus derselben
    ``docker run``-Zeile und derselben Firewall-Regel. Das ist eine
    Plausibilität, keine Messung, und wird auch so benannt.
    """
    kennung = os.urandom(12)
    paket = (
        (0x0001).to_bytes(2, "big") + (0).to_bytes(2, "big") + _STUN_KEKS.to_bytes(4, "big") + kennung
    )
    sock = socket.socket(socket.AF_INET6 if ":" in adresse else socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    schleife = asyncio.get_running_loop()
    try:
        await schleife.sock_sendto(sock, paket, (adresse, port))
        async with asyncio.timeout(FRIST_S):
            antwort = await schleife.sock_recv(sock, 1024)
    except (TimeoutError, OSError):
        return Schritt("stun", False, "kein_durchkommen", f"{adresse}:{port}/udp")
    finally:
        sock.close()

    # Die Kennung muss zurückkommen — sonst war es irgendein Datagramm.
    if len(antwort) < 20 or antwort[8:20] != kennung:
        return Schritt("stun", False, "fremde_antwort", f"{adresse}:{port}/udp")
    return Schritt("stun", True, "antwortet", f"{adresse}:{port}/udp")
