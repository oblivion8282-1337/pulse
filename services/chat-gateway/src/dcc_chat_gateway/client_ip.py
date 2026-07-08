"""Best-effort Client-IP für per-IP-Rate-Limiting hinter Reverse-Proxies.

Spiegel des auth-svc-Patterns (``dcc_auth/routes.py::_client_ip``): hinter
Caddy/nginx ist ``request.client.host`` immer die Proxy-Adresse — alle echten
Clients teilen sich dann EINEN Rate-Limit-Bucket (ein Angreifer kann alle
anderen aussperren, ist selbst aber faktisch ungedrosselt). Deshalb wird
``X-Forwarded-For`` ausgewertet, aber NUR wenn der direkte Peer in
``Settings.trusted_proxies`` (CSV aus IPs/CIDRs) steht — von beliebigen Peers
wäre der Header trivial spoofbar und der per-IP-Schutz komplett umgehbar.
"""

from __future__ import annotations

import ipaddress

from fastapi import Request, WebSocket

from dcc_chat_gateway.config import get_settings

# (raw trusted_proxies string, parsed networks) — re-parsed when the raw
# setting changes (tests swap settings; prod never does).
_trusted_networks_cache: tuple[str, list] | None = None


def _peer_is_trusted(peer: str) -> bool:
    """Whether ``peer`` matches any entry in ``Settings.trusted_proxies``."""
    global _trusted_networks_cache
    raw = get_settings().trusted_proxies or ""
    if _trusted_networks_cache is None or _trusted_networks_cache[0] != raw:
        nets: list[ipaddress._BaseNetwork] = []
        for entry in (e.strip() for e in raw.split(",") if e.strip()):
            try:
                # Accept both single IPs ("127.0.0.1") and CIDRs ("10.0.0.0/8").
                nets.append(ipaddress.ip_network(entry, strict=False))
            except ValueError:
                continue
        _trusted_networks_cache = (raw, nets)
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in n for n in _trusted_networks_cache[1])


def _resolve_client_ip(peer: str, xff: str | None) -> str:
    """Geteilte XFF-Logik für HTTP und WS.

    Peer vertrauenswürdig (trusted_proxies) → erster ``X-Forwarded-For``-Hop
    (in beiden Pulse-Deployments setzt der ÄUSSERSTE Proxy den Header auf die
    echte Client-IP: Cloud-Caddy via ``header_up X-Forwarded-For {remote_host}``,
    Self-Host-Caddy per Default-Verhalten gegenüber untrusted Clients).
    Sonst die Socket-Adresse — ein Direkt-Caller kann seinen Bucket nicht per
    Header wählen.
    """
    if _peer_is_trusted(peer) and xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return peer


def _peer_host(addr: object | None) -> str:
    """Best-effort ``.host`` extraction from a Starlette client tuple."""
    return getattr(addr, "host", None) or "unknown"


def client_ip(request: Request) -> str:
    """Client-IP für HTTP-Rate-Limit-Keying (siehe Modul-Docstring)."""
    return _resolve_client_ip(
        _peer_host(request.client), request.headers.get("x-forwarded-for")
    )


def ws_client_ip(websocket: WebSocket) -> str:
    """Client-IP für WebSocket per-IP-Limits.

    Selbe trusted-proxy/XFF-Logik wie :func:`client_ip`, angewandt auf die
    WS-Handshake-Header — in prod ist der direkte WS-Peer für jede Verbindung
    Caddy, weshalb ohne XFF-Auswertung alle Clients in EINEM IP-Bucket
    zusammenfielen und das per-IP-Limit wirkungslos wäre.
    """
    return _resolve_client_ip(
        _peer_host(websocket.client), websocket.headers.get("x-forwarded-for")
    )
