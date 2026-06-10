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

from fastapi import Request

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


def client_ip(request: Request) -> str:
    """Client-IP für Rate-Limit-Keying.

    Peer vertrauenswürdig (trusted_proxies) → erster ``X-Forwarded-For``-Hop
    (in beiden Pulse-Deployments setzt der ÄUSSERSTE Proxy den Header auf die
    echte Client-IP: Cloud-Caddy via ``header_up X-Forwarded-For {remote_host}``,
    Self-Host-Caddy per Default-Verhalten gegenüber untrusted Clients).
    Sonst die Socket-Adresse — ein Direkt-Caller kann seinen Bucket nicht per
    Header wählen.
    """
    client = request.client
    peer = client.host if client else "unknown"
    if _peer_is_trusted(peer):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
    return peer
