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
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Request

from dcc_relay_frps_plugin.config import get_settings

log = structlog.get_logger(__name__)
router = APIRouter()


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
    http: httpx.AsyncClient = request.app.state.http

    if op == "Login":
        user = str(content.get("user") or "")
        token = str((content.get("metas") or {}).get("token") or "")
        if not user or not token:
            return _reject("missing user/token")
        if await _validate(http, user, token):
            return _allow()
        return _reject("unauthorized relay login")

    # Unknown / not-yet-handled ops: allow-and-keep so frps' other ops are not
    # blocked by this plugin (only Login + NewProxy are registered in frps.toml).
    return _allow()
