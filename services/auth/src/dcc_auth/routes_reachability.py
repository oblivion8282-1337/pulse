"""NAT-Reachability-Probe (②b-②a).

Diagnose-only: testet, ob die Pulse-Medien-Ports des AUFRUFERS von außen
erreichbar sind. Schickt UDP-Token an die Quell-IP + versucht TCP-Connects.
Missbrauchssicher: probt ausschließlich die Quell-IP (``_client_ip``), nur die
feste Port-Allowlist, kleine feste Payload, rate-limited, cloud-only.
Kein Medien-Traffic. Token wird NICHT geloggt.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_auth.config import get_settings
from dcc_auth.routes import _check_rate, _client_ip
from dcc_auth.routes_admin_instances import _require_cloud

# Ranges that must never be probed (SSRF-Schutz).
# Enthält RFC-1918, Loopback, Link-Local — NICHT RFC-5737-Dokumentationsadressen,
# die in Tests und öffentlichen Deployment-Anleitungen vorkommen.
_INTERNAL_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),   # shared address space (RFC 6598)
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

ALLOWED_UDP = frozenset({7882, 8189})
ALLOWED_TCP = frozenset({7881, 1936})

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


class ProbeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    udp_ports: list[Annotated[int, Field(ge=1, le=65535)]]
    tcp_ports: list[Annotated[int, Field(ge=1, le=65535)]]
    token: Annotated[str, Field(min_length=1, max_length=128)]
    public_ip: Annotated[str, Field(min_length=1, max_length=64)]


def _tcp_reachable(ip: str, port: int, timeout: float = 2.0) -> bool:
    """SYN-Connect-Test (synchron, in to_thread aufgerufen)."""
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _send_udp_token(ip: str, port: int, token: str) -> None:
    """Ein kleines Datagramm an ip:port (fire-and-forget; der Host bestätigt Empfang)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.sendto(token.encode("utf-8")[:64], (ip, port))
    except OSError:
        pass


@router.post("/selfhost/reachability/probe")
async def reachability_probe(body: ProbeIn, request: Request) -> dict:
    await _check_rate(request, "reachability_probe",
                      get_settings().rate_limit_reachability_probe)

    source_ip = _client_ip(request)
    if body.public_ip != source_ip:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="public_ip mismatch")
    try:
        addr = ipaddress.ip_address(source_ip)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="bad source ip")
    if any(addr in net for net in _INTERNAL_NETS):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="source ip not public")
    if set(body.udp_ports) - ALLOWED_UDP or set(body.tcp_ports) - ALLOWED_TCP:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="port not allowed")

    for port in body.udp_ports:
        _send_udp_token(source_ip, port, body.token)

    tcp: dict[str, bool] = {}
    for port in body.tcp_ports:
        tcp[str(port)] = await asyncio.to_thread(_tcp_reachable, source_ip, port)

    return {"source_ip": source_ip, "tcp": tcp}
