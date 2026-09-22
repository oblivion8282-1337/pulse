"""The single /handler endpoint frps calls for Login/NewProxy RPCs.

frps POSTs JSON-over-HTTP (see doc/server_plugin.md):
  POST /handler?op=Login   body {version, op, content:{user, metas, ...}}
  POST /handler?op=NewProxy body {version, op, content:{user:{user,metas,run_id},
                                                        proxy_name, subdomain, metas}}
Response: {"reject": true, "reject_reason": "..."} to deny,
          {"reject": false, "unchange": true} to allow.
Token plaintext is NEVER logged.
"""
from __future__ import annotations
import time
from collections import defaultdict, deque
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Request

from dcc_relay_frps_plugin.config import get_settings

log = structlog.get_logger(__name__)
router = APIRouter()

# Security-Audit 2026-09-16: /handler authentifiziert den Aufrufer nicht
# (Loopback ist Konvention, siehe README) und jeder Request loest einen
# auth-svc-Call aus. Per-Prozess genuegt: frps laeuft als einzelner Prozess
# neben dem Plugin.
# Bughunt 2026-09-23: je QUELL-IP keyen killt das ganze Relay — frps ist in
# Prod der EINZIGE Caller, alle Tenant-Calls teilen sich einen Bucket, und ein
# unauthentifizierter Flood auf frps:7000 (hat kein auth.token) kippt den
# Shared-Bucket; 429 ist fail-closed und weist dann ALLE Logins ab. Deshalb
# je (IP, frps-User) keyen: Gueltiger Verkehr haelt seinen eigenen Bucket,
# Garbage rotiert durch Wegwerf-Buckets. Der Deckel auf die Bucket-Anzahl
# haelt das dict unter rotierenden Gueltigkeiten begrenzt.
_HANDLER_LIMIT = 240       # Requests je (IP, User) und Fenster
_HANDLER_FENSTER_S = 60.0
_MAX_BUCKETS = 4096
_handler_zeiten: dict[str, deque[float]] = defaultdict(deque)


def _rate_ok(ip: str, user: str) -> bool:
    jetzt = time.monotonic()
    if len(_handler_zeiten) > _MAX_BUCKETS:
        # Erst tote Buckets (kein Eintrag mehr im Fenster) wegwerfen ...
        tot = [
            k
            for k, d in _handler_zeiten.items()
            if not d or jetzt - d[-1] > _HANDLER_FENSTER_S
        ]
        for k in tot:
            del _handler_zeiten[k]
        # ... und FALLS ein rotierender Flood den Rest aufblaeht: die
        # aeltesten Buckets hart fallenlassen (Insertion-Order). Betroffen
        # sind max. limitierte Gueltigkeiten, kein legitimer Verkehr.
        while len(_handler_zeiten) > _MAX_BUCKETS:
            _handler_zeiten.pop(next(iter(_handler_zeiten)))
    bucket = _handler_zeiten[f"{ip}|{user}"]
    while bucket and jetzt - bucket[0] > _HANDLER_FENSTER_S:
        bucket.popleft()
    if len(bucket) >= _HANDLER_LIMIT:
        return False
    bucket.append(jetzt)
    return True


def _allow() -> dict[str, Any]:
    return {"reject": False, "unchange": True}


def _reject(reason: str) -> dict[str, Any]:
    return {"reject": True, "reject_reason": reason}


async def _validate(http: httpx.AsyncClient, subdomain: str, token: str) -> bool:
    """POST {subdomain, token} to auth-svc /selfhost/relay/auth. Fail-closed."""
    s = get_settings()
    try:
        resp = await http.post(
            f"{s.auth_svc_url}/selfhost/relay/auth",
            json={"subdomain": subdomain, "token": token},
            headers={"X-Pulse-Internal-Secret": s.internal_service_secret or ""},
            timeout=s.auth_timeout_seconds,
        )
    except Exception:  # noqa: BLE001 — any transport error ⇒ deny
        log.warning("relay_auth_unreachable", subdomain=subdomain)
        return False
    return resp.status_code == 200


@router.post("/handler")
async def handler(body: dict[str, Any], request: Request) -> dict[str, Any]:
    op = body.get("op", "")
    content = body.get("content") or {}
    ip = request.client.host if request.client else "?"
    # Rate-Key enthält den frps-User, damit ein Flood nicht den Shared-Bucket
    # der legitimen Tenants kippt (s. Kommentar am Limit oben). Login sendet
    # den User als String, NewProxy als Objekt mit "user"-Feld.
    user_raw = content.get("user")
    user_hint = str(
        user_raw.get("user") if isinstance(user_raw, dict) else user_raw or ""
    )
    if not _rate_ok(ip, user_hint):
        raise HTTPException(status_code=429, detail="rate limited")
    http: httpx.AsyncClient = request.app.state.http

    if op == "Login":
        user = str(content.get("user") or "")
        token = str((content.get("metas") or {}).get("token") or "")
        if not user or not token:
            return _reject("missing user/token")
        if await _validate(http, user, token):
            return _allow()
        return _reject("unauthorized relay login")

    if op == "NewProxy":
        user_obj = content.get("user") or {}
        user = str(user_obj.get("user") or "")
        token = str((user_obj.get("metas") or {}).get("token") or "")
        slug = str(content.get("subdomain") or "")
        if not user or not slug or not token:
            return _reject("missing user/subdomain/token")
        # Impersonation-Schutz: der angeforderte Routing-Slug muss exakt die
        # autorisierte volle Subdomain rekonstruieren.
        expected_full = f"{slug}.{get_settings().relay_base_domain}"
        if expected_full != user:
            log.warning("relay_newproxy_subdomain_mismatch", slug=slug)
            return _reject("subdomain does not match authorised tunnel")
        # Hijack-Schutz (Security-Audit 2026-09-16): frps liefert im selben
        # NewProxy-Body weitere routing-bestimmende Felder, die die Slug-Prüfung
        # oben NICHT deckt. Ein authentifizierter Tenant könnte mit
        # subdomain=<eigener Slug> PLUS custom_domains=["fremde.tld"] den
        # Host-Header einer fremden Domain in seinen Tunnel routen lassen;
        # remote_port oeffnet zusätzlich beliebige TCP/UDP-Ports auf dem frps-
        # Host. Erlaubt ist ausschliesslich das, was das Relay-Modell
        # vorsieht: http(s)-vhost auf dem eigenen Slug, sonst nichts.
        if content.get("custom_domains"):
            log.warning("relay_newproxy_custom_domains_rejected", slug=slug)
            return _reject("custom domains are not allowed")
        if str(content.get("proxy_type") or "http") not in ("http", "https"):
            log.warning("relay_newproxy_proxy_type_rejected", slug=slug,
                        proxy_type=content.get("proxy_type"))
            return _reject("only http(s) proxies are allowed")
        if content.get("remote_port") not in (None, 0):
            log.warning("relay_newproxy_remote_port_rejected", slug=slug,
                        remote_port=content.get("remote_port"))
            return _reject("remote ports are not allowed")
        if await _validate(http, user, token):
            return _allow()
        return _reject("unauthorized relay proxy")

    # Unknown / not-yet-handled ops: frps sends ONLY the ops registered in
    # frps.toml (Login + NewProxy). Anything else means frps.toml grew an op
    # this plugin has no handler for — fail closed instead of waving an
    # unvalidated op through (Audit 2026-09). Adding an op to frps.toml
    # requires growing a branch above.
    return _reject("unsupported op")
