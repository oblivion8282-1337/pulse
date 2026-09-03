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


@pytest.mark.asyncio
async def test_run_once_stempelt_verfallene_geraete(engine, session_factory):
    """Der Geraete-Verfall (Spec §3a) haengt in DIESER Schleife, nicht in einer
    zweiten daneben — geprueft ueber ``_run_once``, nicht ueber den Sweep
    selbst. Ein Aufraeumlauf, den niemand ruft, sieht in seinem eigenen Test
    genauso gruen aus wie einer, der laeuft."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    alt = datetime.now(UTC) - timedelta(days=20)
    bid = next_id()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=bid,
                user_id=424242,
                device_pubkey="pub-cleanup-verfall",
                curve25519="curve",
                dauerhaft=False,
                zuletzt_benutzt=alt,
            )
        )
        await s.commit()

    await _run_once(engine, _settings())

    async with session_factory() as s:
        zeile = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.id == bid)
            )
        ).scalar_one()
    assert zeile.verfallen_am is not None


@pytest.mark.asyncio
async def test_ein_kaputter_teil_sweep_stoppt_die_uebrigen_nicht(
    engine, session_factory, monkeypatch, caplog
):
    """R8: alle Sweeps lagen in einer Funktion ohne eigenes ``try`` — der
    erste Fehler (eine fremde Cloud, ein DB-Deadlock) brach den ganzen Lauf
    ab, und alles dahinter blieb bis zum naechsten Takt liegen, ohne dass
    irgendwo stand, WELCHER Teil gefehlt hat.

    Der Nachtrag-Sweep laeuft als erster Teil nach dem Web-Push-Lauf; er ist
    hier der Kaputte. Gemessen wird an einem SPAETEREN Teil, dass er
    trotzdem dran kam.
    """
    from dcc_chat_gateway import cleanup as cleanup_mod

    async def _wirft(_session):
        raise RuntimeError("Nextcloud weg")

    gelaufen: list[str] = []

    async def _spaeter(_session):
        gelaufen.append("kopplung")
        return 0

    monkeypatch.setattr(cleanup_mod, "sweep_ablage_kanal_nachtraege", _wirft)
    monkeypatch.setattr(cleanup_mod, "sweep_verfallene_kopplungen", _spaeter)

    with caplog.at_level(logging.ERROR, logger="dcc_chat_gateway.cleanup"):
        deleted = await _run_once(engine, _settings())

    assert deleted == 0
    assert gelaufen == ["kopplung"]
    # Und der Fehlschlag ist benannt, nicht verschluckt.
    assert any("teil=ablage_kanal_nachtrag" in r.getMessage() for r in caplog.records)
