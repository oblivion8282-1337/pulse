"""Internal service-to-service endpoints.

Currently exposes ``POST /internal/users/{user_id}/purge`` — called by
auth-svc when a user self-deletes their account so chat-gateway can
hard-delete every piece of data it owns for them.

Gated by a shared secret header (``X-Pulse-Internal-Secret``) — same
name as the existing chat-gateway → voice-signaling integration so all
service-to-service traffic uses a single header convention.
Constant-time compare to avoid timing-side-channel leaks of the secret. Empty
``internal_service_secret`` in config DISABLES the endpoint so a
misconfigured deploy can't accidentally expose an unauthenticated
account-purge path.
"""

from __future__ import annotations

import hmac
import logging
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status

from dcc_chat_gateway import config as chat_cfg
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.user_purge import purge_user

router = APIRouter()
log = logging.getLogger(__name__)


def _check_internal_secret(provided: str | None) -> None:
    """Constant-time compare against ``settings.internal_service_secret``.

    Raises 401 on missing / empty / wrong header, or when the server
    secret itself is unset (fail-closed — same posture as
    voice-signaling's ``/internal/evict-from-voice``)."""
    expected = chat_cfg.get_settings().internal_service_secret
    if not expected:
        # Treat unset secret as 401 (caller can't fix this, but a 5xx
        # would mislead them into rolling back their tx assuming the
        # purge ran). The auth-side contract says 401 on bad/missing
        # secret — server-side unset is "missing" from the caller's POV.
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="internal endpoint disabled — set INTERNAL_SERVICE_SECRET",
        )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="invalid internal secret"
        )


@router.post(
    "/internal/users/{user_id}/purge", status_code=status.HTTP_204_NO_CONTENT
)
async def purge_user_endpoint(
    user_id: int,
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Hard-delete every piece of data chat-gateway owns for
    ``user_id`` (messages, reactions, memberships, owned guilds,
    web-push subs, DM channels, …). See ``user_purge.purge_user`` for
    the exact ordering. Idempotent; a second call is a no-op.

    Returns 204 on success. Any internal failure surfaces as 5xx so
    the caller (auth-svc) can roll back its own ``DELETE /me`` tx —
    we don't want a half-purged-user state where auth.users is gone
    but chat-gateway still has their messages.
    """
    _check_internal_secret(x_pulse_internal_secret)
    manager = getattr(request.app.state, "connection_manager", None)
    redis = getattr(request.app.state, "redis", None)
    try:
        result = await purge_user(
            session, user_id, manager=manager, redis=redis
        )
    except Exception:
        # Log here so the trace lives next to the user_id; FastAPI's
        # default 500 handler will still surface a generic error to
        # the caller (we deliberately don't echo the exception text —
        # auth-svc just needs the status code to decide on rollback).
        log.exception("purge_user failed for user_id=%s", user_id)
        raise
    log.info(
        "purged user_id=%s (deleted_guild_ids=%s)",
        user_id,
        result["deleted_guild_ids"],
    )
