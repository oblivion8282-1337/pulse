"""Service-to-service helper: hand a community mod-queue report up to the
platform operator's complaint inbox (auth-svc).

Unlike ``auth_mirror.py`` / ``voice_evict.py`` this is NOT fire-and-forget:
the escalating moderator must know whether the report actually reached the
operator, so a failure here raises and the route leaves the report
un-escalated (no ``escalated_at`` written). Same X-Pulse-Internal-Secret
auth + ``auth_svc_url`` config as the discoverable-mirror push.
"""

from __future__ import annotations

import logging

import httpx

from dcc_chat_gateway.config import get_settings

log = logging.getLogger(__name__)


class EscalationUnavailable(RuntimeError):
    """Raised when the complaint could not be filed with auth-svc (secret
    unset, network error, or a non-2xx response). The caller maps this to a
    502 so the report stays open and the moderator can retry."""


async def escalate_report_to_operator(
    body: str,
    target_user_id: int | None,
    submitter_user_id: int | None = None,
) -> str:
    """POST ``/internal/complaints`` on auth-svc. Returns the new complaint id.

    ``submitter_user_id`` (the reporter) is optional — set on the DM-report path
    so the operator's resolve-DM can reach the reporter; unset for a mod-queue
    escalation (the escalating mod isn't the reporter).

    Raises :class:`EscalationUnavailable` on any failure — the report must not
    be marked escalated unless the operator's inbox actually received it.
    """
    settings = get_settings()
    secret = settings.internal_service_secret
    if not secret:
        raise EscalationUnavailable("internal_service_secret unset")

    url = settings.auth_svc_url.rstrip("/") + "/internal/complaints"
    payload: dict[str, object] = {"body": body}
    if target_user_id is not None:
        payload["target_user_id"] = target_user_id
    if submitter_user_id is not None:
        payload["submitter_user_id"] = submitter_user_id

    try:
        async with httpx.AsyncClient(timeout=settings.auth_svc_timeout_s) as http:
            resp = await http.post(
                url, json=payload, headers={"X-Pulse-Internal-Secret": secret}
            )
    except httpx.HTTPError as exc:
        log.warning("complaint escalation failed: %s", exc)
        raise EscalationUnavailable(str(exc)) from exc

    if resp.status_code >= 400:
        log.warning("complaint escalation returned %s", resp.status_code)
        raise EscalationUnavailable(f"auth-svc returned {resp.status_code}")

    return str(resp.json().get("id", ""))
