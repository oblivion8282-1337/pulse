"""Web-Push subscription management routes.

Mounted at ``/notifications/*``. The PWA's Service Worker calls these
after the browser hands it a ``PushSubscription``; the Settings UI
also lists subscriptions for the "Devices subscribed for
notifications" panel.

VAPID public key is served by ``GET /notifications/vapid-public-key`` —
the SW passes that to ``pushManager.subscribe({applicationServerKey})``.
We refuse to subscribe when no key is configured (503 ``push_disabled``)
so the FE can render a clear "Notifications are disabled by the
server" state instead of crashing.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import WebPushSubscription
from dcc_chat_gateway.push import ensure_vapid
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications")


# ---------------------------------------------------------------------------
# Schemas


class _PushKeys(BaseModel):
    # The browser hands these as base64url strings. We don't validate the
    # exact format here — pywebpush would surface a clear error on first
    # send if they're malformed, and the strings are user-supplied not
    # security-critical to validate strictly.
    p256dh: str = Field(min_length=1, max_length=512)
    auth: str = Field(min_length=1, max_length=128)


class SubscribeIn(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
    keys: _PushKeys
    user_agent: str | None = Field(default=None, max_length=512)

    @field_validator("endpoint")
    @classmethod
    def _https_only(cls, v: str) -> str:
        # Real browsers always hand https:// (or wss://) endpoints; reject
        # anything else so a stale dev/test value can't poison the table.
        if not v.startswith("https://"):
            raise ValueError("endpoint must be https://")
        return v


class UnsubscribeIn(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)


class SubscriptionOut(BaseModel):
    id: str
    endpoint: str
    user_agent: str | None
    created_at: datetime
    last_used_at: datetime | None


class VapidKeyOut(BaseModel):
    public_key: str


# ---------------------------------------------------------------------------
# Routes


@router.get("/vapid-public-key", response_model=VapidKeyOut)
async def get_vapid_public_key(_current: CurrentUser) -> VapidKeyOut:
    """Return the server's VAPID public key (base64url).

    Auth-gated so a passer-by can't enumerate the key (it's not secret
    by spec — but gating means we can also 503 ``push_disabled`` to the
    FE cleanly when the operator hasn't set it up).
    """
    vapid = ensure_vapid()
    if vapid is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="push_disabled"
        )
    return VapidKeyOut(public_key=vapid.public_b64url)


@router.post("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def subscribe(
    payload: SubscribeIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Upsert a (user, endpoint) Web-Push subscription.

    Idempotent: re-subscribing with the same endpoint refreshes the keys
    + user_agent rather than minting a new row. This matters because a
    browser will re-subscribe transparently if its push service rotates,
    and we'd otherwise leak rows forever.
    """
    # ensure_vapid implicitly checks push is enabled — refuse to record
    # subscriptions we'd never actually send to.
    if ensure_vapid() is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="push_disabled"
        )
    existing = (
        await session.execute(
            select(WebPushSubscription).where(
                WebPushSubscription.user_id == current.id,
                WebPushSubscription.endpoint == payload.endpoint,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.p256dh = payload.keys.p256dh
        existing.auth_secret = payload.keys.auth
        existing.user_agent = payload.user_agent
    else:
        session.add(
            WebPushSubscription(
                id=next_id(),
                user_id=current.id,
                endpoint=payload.endpoint,
                p256dh=payload.keys.p256dh,
                auth_secret=payload.keys.auth,
                user_agent=payload.user_agent,
            )
        )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(
    payload: UnsubscribeIn,
    session: SessionDep,
    current: CurrentUser,
) -> Response:
    """Drop a single subscription. Silently 204s on a missing endpoint —
    a 404 here would leak whether the user ever subscribed from that
    device (low-stakes leak but also no benefit to surfacing)."""
    await session.execute(
        delete(WebPushSubscription).where(
            WebPushSubscription.user_id == current.id,
            WebPushSubscription.endpoint == payload.endpoint,
        )
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(
    session: SessionDep, current: CurrentUser
) -> list[SubscriptionOut]:
    """List the caller's own subscriptions. Powers the Settings panel
    that shows "this account is subscribed for notifications on N
    devices" with a per-row revoke button.

    ``p256dh`` + ``auth_secret`` are intentionally NOT returned — those
    are the encryption keys; surfacing them server-side would defeat
    the per-device opacity. ``endpoint`` is necessary so the UI can
    DELETE the right row by exactly the value the SW would send."""
    rows = (
        await session.execute(
            select(WebPushSubscription)
            .where(WebPushSubscription.user_id == current.id)
            .order_by(WebPushSubscription.created_at.desc())
        )
    ).scalars().all()
    return [
        SubscriptionOut(
            id=str(r.id),
            endpoint=r.endpoint,
            user_agent=r.user_agent,
            created_at=r.created_at,
            last_used_at=r.last_used_at,
        )
        for r in rows
    ]


__all__ = ["router"]
