"""Service-to-service helper: tell auth-svc to flip a user's
``discoverable`` flag when chat-gateway's privacy UI changes
``user_privacy.show_in_search``.

Fire-and-forget — failures are logged but the privacy update has
already been committed locally. The auth-svc side gets reconciled on
the next flip or by an operator-side nudge. Same shape as
``voice_evict.py``: monkeypatchable at the function level for tests.
"""

from __future__ import annotations

import logging

import httpx

from dcc_chat_gateway.config import get_settings

log = logging.getLogger(__name__)


async def push_discoverable(user_id: int, discoverable: bool) -> None:
    """POST ``/internal/users/discoverable`` on auth-svc. No-op when
    ``internal_service_secret`` is unset (dev / standalone). Logs +
    swallows network errors so the caller's transaction isn't held
    hostage to auth-svc availability."""
    settings = get_settings()
    secret = settings.internal_service_secret
    if not secret:
        log.info("discoverable push skipped: internal_service_secret unset")
        return
    url = settings.auth_svc_url.rstrip("/") + "/internal/users/discoverable"
    body = {"user_id": str(user_id), "discoverable": bool(discoverable)}
    try:
        async with httpx.AsyncClient(
            timeout=settings.auth_svc_timeout_s
        ) as http:
            resp = await http.post(
                url,
                json=body,
                headers={"X-Pulse-Internal-Secret": secret},
            )
        if resp.status_code >= 400:
            log.warning(
                "discoverable push for %s returned %s",
                user_id,
                resp.status_code,
            )
    except httpx.HTTPError as exc:
        log.warning("discoverable push for %s failed: %s", user_id, exc)
