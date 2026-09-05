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
from pydantic import BaseModel

from dcc_chat_gateway import config as chat_cfg
from dcc_chat_gateway.client_ip import client_ip
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.user_purge import purge_user
from dcc_chat_gateway.voice_pull_cleanup import revoke_voice_pull

router = APIRouter()
log = logging.getLogger(__name__)


class VoicePullRevokeIn(BaseModel):
    """Body for the voice-pull revoke call from voice-signaling.

    voice-signaling fires this when a participant leaves a channel that
    had an active voice-pull grant for them (detected via the Redis
    ``voice_pull:channel-<cid>:user-<uid>`` marker in the webhook)."""

    channel_id: int
    user_id: int


class ComplaintNotifyIn(BaseModel):
    """Body for the complaint-notify call from auth-svc: the admin user-ids to
    live-push a ``complaint_new`` to."""

    admin_user_ids: list[int]


class ModerationDmIn(BaseModel):
    """Body for the moderation-DM call from auth-svc.

    auth-svc fires this when the platform operator notifies a user about a
    complaint outcome. ``from_user_id`` is the acting super-admin, ``to_user_id``
    the reported user; the content is delivered as a gate-free one-way DM."""

    from_user_id: int
    to_user_id: int
    content: str


def _check_internal_secret(request: Request, provided: str | None) -> None:
    """Constant-time compare against ``settings.internal_service_secret``.

    Raises 401 on missing / empty / wrong header, or when the server
    secret itself is unset (fail-closed — same posture as
    voice-signaling's ``/internal/evict-from-voice``). Rate-limited BEFORE
    the compare so online guessing can't run hot (Audit 2026-09; the
    nginx/Caddy deny for ``/api/chat/internal/*`` is the layer in front)."""
    if not ratelimit_check("internal_secret", client_ip(request)):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="rate limit exceeded (internal_secret)",
        )
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
    _check_internal_secret(request, x_pulse_internal_secret)
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


@router.post(
    "/internal/voice-pull-revoke", response_model=dict[str, bool]
)
async def revoke_voice_pull_endpoint(
    payload: VoicePullRevokeIn,
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    """Revoke a temporary voice-pull grant — called by voice-signaling
    when the pulled user leaves the channel. Idempotent: a repeat call
    (or a stale Redis marker) is a no-op because ``revoke_voice_pull``
    only acts when a ``channel_voice_pulls`` row exists, so a permanent
    user-overwrite can never be touched here."""
    _check_internal_secret(request, x_pulse_internal_secret)
    manager = getattr(request.app.state, "connection_manager", None)
    redis = getattr(request.app.state, "redis", None)
    revoked = await revoke_voice_pull(
        session,
        channel_id=payload.channel_id,
        user_id=payload.user_id,
        manager=manager,
        redis=redis,
    )
    return {"revoked": revoked}


@router.post("/internal/complaint-notify", status_code=status.HTTP_204_NO_CONTENT)
async def complaint_notify_endpoint(
    payload: ComplaintNotifyIn,
    request: Request,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Live-push a ``complaint_new`` to each admin so the operator's inbox
    badge + open list update immediately (no 60s poll wait / no reload).
    Best-effort — a dead manager/Redis just means the poll catches up later."""
    _check_internal_secret(request, x_pulse_internal_secret)
    from dcc_shared.events import ComplaintNewEvent

    manager = getattr(request.app.state, "connection_manager", None)
    if manager is None:
        return
    for uid in payload.admin_user_ids:
        await manager.publish_user_event(uid, ComplaintNewEvent())


@router.post("/internal/moderation-dm", status_code=status.HTTP_204_NO_CONTENT)
async def moderation_dm_endpoint(
    payload: ModerationDmIn,
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Send a one-way admin→user DM on behalf of another service (auth-svc's
    complaint-notify flow). Bypasses the friend-gate; see ``system_dm``."""
    _check_internal_secret(request, x_pulse_internal_secret)
    from dcc_chat_gateway.system_dm import send_moderation_dm

    manager = getattr(request.app.state, "connection_manager", None)
    await send_moderation_dm(
        session,
        manager,
        from_user_id=payload.from_user_id,
        to_user_id=payload.to_user_id,
        content=payload.content,
    )
