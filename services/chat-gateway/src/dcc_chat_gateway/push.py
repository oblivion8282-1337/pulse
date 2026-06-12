"""Web-Push (RFC 8030) sender.

``send_push_to_user`` fans a payload dict out to every
``WebPushSubscription`` owned by ``user_id``, drops endpoints that
push services reject with 404/410 (RFC 8030 §7.3 — "gone"), and
refreshes ``last_used_at`` on success. pywebpush is sync-only; we run
each send in a worker thread so a slow push service can't block the
event loop.

VAPID key management (``ensure_vapid`` etc.) lives in
``dcc_chat_gateway.vapid``; we re-export the public surface here so
existing ``from dcc_chat_gateway.push import ensure_vapid`` callers
keep working.

The payload shape — the contract with the FE Service Worker and the
Electron-side notifier — is documented at the bottom of this module
under ``MENTION_PAYLOAD_SCHEMA``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.models import WebPushSubscription
from dcc_chat_gateway.vapid import (
    VapidKeys,
    ensure_vapid,
    reset_vapid_cache_for_tests,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sender


async def send_push_to_user(
    user_id: int, payload: dict, session: AsyncSession
) -> int:
    """Push ``payload`` to every device subscribed by ``user_id``.

    Returns the count of *successful* deliveries. Failed endpoints (404,
    410, unrecoverable cryptography errors) are dropped from the DB
    inline so the next send doesn't waste a round-trip on them. Other
    failures (timeouts, 5xx) are logged at WARN and the subscription
    is left alone — push services are allowed to be flaky, and a single
    failed send mustn't permanently disable notifications.

    Never raises; a misconfigured VAPID or a dead push service must not
    turn a successful message-write into a 500.
    """
    settings = get_settings()
    vapid = ensure_vapid(settings)
    if vapid is None:
        return 0

    rows = (
        await session.execute(
            select(WebPushSubscription).where(WebPushSubscription.user_id == user_id)
        )
    ).scalars().all()
    if not rows:
        return 0

    body = json.dumps(payload, separators=(",", ":"))
    vapid_claims = {"sub": settings.vapid_subject}

    # pywebpush is sync; offload each send to a thread so a slow push
    # service can't stall the event loop. Concurrency-bound by the default
    # thread pool — typical user has 1-3 subscriptions.
    results = await asyncio.gather(
        *(
            asyncio.to_thread(
                _send_one,
                endpoint=r.endpoint,
                p256dh=r.p256dh,
                auth_secret=r.auth_secret,
                body=body,
                vapid_pem=vapid.private_pem,
                vapid_claims=vapid_claims,
            )
            for r in rows
        ),
        return_exceptions=False,
    )

    ok_ids: list[int] = []
    dead_ids: list[int] = []
    for row, outcome in zip(rows, results, strict=True):
        if outcome == "ok":
            ok_ids.append(row.id)
        elif outcome == "dead":
            dead_ids.append(row.id)
        # "warn" → leave alone (transient).

    if dead_ids:
        await session.execute(
            delete(WebPushSubscription).where(WebPushSubscription.id.in_(dead_ids))
        )
    if ok_ids:
        await session.execute(
            update(WebPushSubscription)
            .where(WebPushSubscription.id.in_(ok_ids))
            .values(last_used_at=datetime.now(UTC))
        )
    if dead_ids or ok_ids:
        await session.commit()
    return len(ok_ids)


def _send_one(
    *,
    endpoint: str,
    p256dh: str,
    auth_secret: str,
    body: str,
    vapid_pem: str,
    vapid_claims: dict,
) -> str:
    """Single push attempt. Returns ``"ok"``, ``"dead"``, or ``"warn"``.

    Imports pywebpush lazily so the chat-gateway can boot without the
    library installed (tests that mock the sender don't need it either —
    they monkey-patch ``send_push_to_user`` upstream of this function).

    NEVER logs ``body``, ``p256dh``, ``auth_secret``, or ``vapid_pem`` —
    those are sensitive (payload may carry message snippets; the keys
    let anyone send pushes to the user's browser). Only the endpoint
    host + status code go to logs.
    """
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.error("pywebpush not installed; push disabled")
        return "warn"
    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth_secret},
            },
            data=body,
            vapid_private_key=vapid_pem,
            vapid_claims=dict(vapid_claims),
        )
        return "ok"
    except WebPushException as exc:  # noqa: BLE001
        status = getattr(exc.response, "status_code", None) if exc.response else None
        if status in (404, 410):
            return "dead"
        # Endpoint host only — never the path (path can carry the
        # subscription token for some push services).
        host = endpoint.split("/", 3)[2] if "://" in endpoint else "<unknown>"
        log.warning("web-push send failed: host=%s status=%s", host, status)
        return "warn"
    except Exception:  # noqa: BLE001
        host = endpoint.split("/", 3)[2] if "://" in endpoint else "<unknown>"
        log.exception("web-push unexpected error: host=%s", host)
        return "warn"


# ---------------------------------------------------------------------------
# Payload contract — keep in sync with the Service Worker + Electron notifier.
#
# This is the documented shape ``send_push_to_user`` consumes (and what the
# FE service worker / Electron renderer event handler must decode).
#
# {
#   "type":         "mention",            # discriminator; future: "dm" etc.
#   "title":        "<author_name>",      # 1st notification line
#   "body":         "<snippet>",          # 2nd line, max ~120 chars
#   "channel_id":   "<snowflake string>",
#   "message_id":   "<snowflake string>",
#   "guild_id":     "<snowflake string>" | null,   # null for DMs
#   "author_name":  "<username>",
#   "icon":         "<absolute https url>" | null  # avatar; null → SW falls
#                                                  # back to app icon
# }
#
# All snowflake-shaped ids are STRINGS over the API boundary (CLAUDE.md).
# ``guild_id`` is null for DM mentions; the FE uses that to route the
# notification's click action to ``/app/dms/<channel_id>`` vs
# ``/app/guilds/<guild_id>/channels/<channel_id>``.
MENTION_PAYLOAD_SCHEMA = {
    "type": "string",
    "title": "string",
    "body": "string",
    "channel_id": "string",
    "message_id": "string",
    "guild_id": "string|null",
    "author_name": "string",
    "icon": "string|null",
}


async def fan_out_mention_push(
    *,
    user_ids: set[int],
    author_name: str,
    content: str,
    channel_id: int,
    message_id: int,
    guild_id: int | None,
) -> None:
    """Build the canonical mention payload + push it to each user.

    Opens a *single* DB session (via ``routes.ws_ops.SessionLocal``) and
    loads all subscriptions for all recipients in one query, then fans
    out sends concurrently in thread-pool workers (pywebpush is sync).
    Dead-endpoint deletes and last_used_at refreshes are batched into two
    bulk statements after all sends complete, so the DB pool is held for
    only one short window regardless of recipient count.

    Tests rebind ``routes.ws_ops.SessionLocal`` to their fixture's
    sessionmaker; production uses the prod factory.

    Never raises — push failures, missing VAPID, or an empty subscription
    set must not break the message-send REST path. Caller (route layer)
    fires this *after* the WS broadcast so the in-app counter bumps
    even if the push half is misconfigured.
    """
    if not user_ids:
        return

    settings = get_settings()
    vapid = ensure_vapid(settings)
    if vapid is None:
        return

    # 100-char snippet — long enough to be useful, short enough that an
    # OS-level toast doesn't truncate weirdly. Strip mention markers so
    # the preview doesn't read "<@123456789> please look". Use a soft
    # rstrip → ellipsis if we cut.
    body = _make_snippet(content)
    payload_base = {
        "type": "mention",
        "title": author_name or "Pulse",
        "body": body,
        "channel_id": str(channel_id),
        "message_id": str(message_id),
        "guild_id": str(guild_id) if guild_id is not None else None,
        "author_name": author_name or "",
        "icon": None,  # chat-gateway has no avatar URL; FE/SW fallback.
    }
    serialised_body = json.dumps(payload_base, separators=(",", ":"))
    vapid_claims = {"sub": settings.vapid_subject}

    # Late import: routes.ws_ops → push would cycle.
    from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops

    try:
        async with _routes_ws_ops.SessionLocal() as session:
            # Single query for all recipients — O(1) DB round-trip.
            uid_list = list(user_ids)
            rows = (
                await session.execute(
                    select(WebPushSubscription).where(
                        WebPushSubscription.user_id.in_(uid_list)
                    )
                )
            ).scalars().all()

            if not rows:
                return

            # Send all subscriptions concurrently in thread-pool workers;
            # pywebpush is sync-only so we must offload.
            results = await asyncio.gather(
                *(
                    asyncio.to_thread(
                        _send_one,
                        endpoint=r.endpoint,
                        p256dh=r.p256dh,
                        auth_secret=r.auth_secret,
                        body=serialised_body,
                        vapid_pem=vapid.private_pem,
                        vapid_claims=vapid_claims,
                    )
                    for r in rows
                ),
                return_exceptions=False,
            )

            ok_ids: list[int] = []
            dead_ids: list[int] = []
            for row, outcome in zip(rows, results, strict=True):
                if outcome == "ok":
                    ok_ids.append(row.id)
                elif outcome == "dead":
                    dead_ids.append(row.id)
                # "warn" → leave alone (transient).

            # Two bulk statements — one session, one commit.
            if dead_ids:
                await session.execute(
                    delete(WebPushSubscription).where(
                        WebPushSubscription.id.in_(dead_ids)
                    )
                )
            if ok_ids:
                await session.execute(
                    update(WebPushSubscription)
                    .where(WebPushSubscription.id.in_(ok_ids))
                    .values(last_used_at=datetime.now(UTC))
                )
            if dead_ids or ok_ids:
                await session.commit()
    except Exception:  # noqa: BLE001
        log.exception("fan_out_mention_push failed")


async def _fan_out_payload(user_ids: set[int], payload: dict) -> None:
    """Open a short-lived session and push ``payload`` to each user.

    Self-contained mirror of ``fan_out_mention_push``'s session handling for
    payloads that aren't mentions (DMs, friend events). Never raises — push
    is best-effort and must not break the originating REST path.
    """
    if not user_ids:
        return
    if ensure_vapid(get_settings()) is None:
        return
    from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops

    try:
        async with _routes_ws_ops.SessionLocal() as session:
            for uid in user_ids:
                await send_push_to_user(uid, payload, session)
    except Exception:  # noqa: BLE001
        log.exception("_fan_out_payload failed")


async def fan_out_dm_push(
    *,
    recipient_id: int,
    author_name: str,
    content: str,
    channel_id: int,
    message_id: int,
) -> None:
    """Push a closed-browser notification for a new DM to its recipient.

    The in-app path (``dm_bump`` WS frame) covers the tab-open case; this
    covers the tab-closed case. ``guild_id: None`` makes the SW route the
    click to ``/app/@me/<channel_id>``. DND is honoured SW-side; the per-type
    ``onDM`` toggle gates the in-page path (matching mention push).
    """
    payload = {
        "type": "dm",
        "title": author_name or "Pulse",
        "body": _make_snippet(content),
        "channel_id": str(channel_id),
        "message_id": str(message_id),
        "guild_id": None,
        "author_name": author_name or "",
        "icon": None,
    }
    await _fan_out_payload({recipient_id}, payload)


async def fan_out_friend_push(
    *, recipient_id: int, actor_name: str, kind: str
) -> None:
    """Push a closed-browser notification for a friend event.

    ``kind`` is ``"friend_request"`` (incoming request) or ``"friend_accept"``
    (request accepted). No channel/message — ``target_url`` routes the click to
    the friends page.
    """
    if kind == "friend_request":
        body = f"{actor_name} möchte dich als Freund hinzufügen"
    elif kind == "friend_accept":
        body = f"{actor_name} hat deine Freundschaftsanfrage angenommen"
    else:
        return
    payload = {
        "type": kind,
        "title": actor_name or "Pulse",
        "body": body,
        "channel_id": None,
        "message_id": None,
        "guild_id": None,
        "author_name": actor_name or "",
        "icon": None,
        "target_url": "/app/friends",
    }
    await _fan_out_payload({recipient_id}, payload)


def _make_snippet(content: str, limit: int = 100) -> str:
    """One-line, marker-free preview of the message content.

    Replaces ``<@123>``/``<@&123>`` with empty + ``@everyone``/``@here``
    with ``@everyone`` so the preview reads naturally. Collapses
    whitespace + truncates with an ellipsis when over ``limit`` chars.
    """
    import re

    text = re.sub(r"<@&?\d{1,20}>", "", content)
    text = re.sub(r"@(everyone|here)\b", "@everyone", text)
    text = " ".join(text.split())  # collapse runs of whitespace
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


__all__ = [
    "MENTION_PAYLOAD_SCHEMA",
    "VapidKeys",
    "ensure_vapid",
    "fan_out_dm_push",
    "fan_out_friend_push",
    "fan_out_mention_push",
    "reset_vapid_cache_for_tests",
    "send_push_to_user",
]
