"""Web-Push subscription cleanup sweep.

Two delete-path tests + one mock-based loop-resilience smoke. We call
``_run_once`` directly with the test engine — ``cleanup_loop`` itself is
endless and is exercised separately.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import pytest
from dcc_chat_gateway.cleanup import _run_once, cleanup_loop
from dcc_chat_gateway.config import Settings
from dcc_chat_gateway.models import WebPushSubscription
from sqlalchemy import select


def _settings() -> Settings:
    return Settings(
        push_subscription_idle_days=60,
        cleanup_interval_seconds=86400,
    )


def _make_sub(user_id: int, sub_id: int, endpoint: str) -> WebPushSubscription:
    return WebPushSubscription(
        id=sub_id,
        user_id=user_id,
        endpoint=endpoint,
        p256dh="BL_pubkey",
        auth_secret="auth-secret",
        user_agent="test-ua",
    )


@pytest.mark.asyncio
async def test_run_once_deletes_idle_old_subscription(engine, session_factory):
    now = datetime.now(UTC)
    old = now - timedelta(days=120)
    recent = now - timedelta(days=5)

    async with session_factory() as s:
        # idle + old: created 120 d ago, never used — deleted
        idle_old = _make_sub(1, 100001, "https://fcm.example.com/idle-old")
        idle_old.created_at = old
        idle_old.last_used_at = None
        s.add(idle_old)
        # idle + old but recently used — kept (last_used_at fresh)
        old_but_active = _make_sub(1, 100002, "https://fcm.example.com/old-but-active")
        old_but_active.created_at = old
        old_but_active.last_used_at = recent
        s.add(old_but_active)
        # old created + last_used also old — deleted
        idle_old_with_stale_use = _make_sub(
            1, 100003, "https://fcm.example.com/double-old"
        )
        idle_old_with_stale_use.created_at = old
        idle_old_with_stale_use.last_used_at = now - timedelta(days=100)
        s.add(idle_old_with_stale_use)
        await s.commit()

    deleted = await _run_once(engine, _settings())
    assert deleted == 2

    async with session_factory() as s:
        remaining = (
            await s.execute(select(WebPushSubscription.endpoint))
        ).scalars().all()
    assert remaining == ["https://fcm.example.com/old-but-active"]


@pytest.mark.asyncio
async def test_run_once_keeps_young_subscriptions(engine, session_factory):
    """Subs younger than the idle cutoff stay regardless of last_used_at."""
    now = datetime.now(UTC)

    async with session_factory() as s:
        # young + never used — kept (created_at fresh)
        young = _make_sub(2, 200001, "https://fcm.example.com/fresh")
        young.created_at = now - timedelta(days=10)
        young.last_used_at = None
        s.add(young)
        # young + recently used — kept
        young_used = _make_sub(2, 200002, "https://fcm.example.com/fresh-used")
        young_used.created_at = now - timedelta(days=10)
        young_used.last_used_at = now - timedelta(hours=2)
        s.add(young_used)
        await s.commit()

    deleted = await _run_once(engine, _settings())
    assert deleted == 0

    async with session_factory() as s:
        n = len((await s.execute(select(WebPushSubscription))).scalars().all())
    assert n == 2


@pytest.mark.asyncio
async def test_cleanup_loop_survives_run_once_exception(
    monkeypatch, caplog, engine
):
    calls = {"n": 0}

    async def _broken(_engine, _settings):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated blip")
        return 0

    import dcc_chat_gateway.cleanup as cleanup_mod

    monkeypatch.setattr(cleanup_mod, "_run_once", _broken)

    s = _settings()
    s.cleanup_interval_seconds = 0
    caplog.set_level(logging.ERROR, logger="dcc_chat_gateway.cleanup")

    task = asyncio.create_task(cleanup_loop(s, engine))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert calls["n"] >= 2
    assert any(
        "push_subscription_cleanup_failed" in rec.message for rec in caplog.records
    )
