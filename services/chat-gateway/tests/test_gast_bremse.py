"""Die Ratenbremse der anonymen Gast-Routen.

Sie ist der einzige Schutz dieser beiden Routen — der übrige chat-gateway
zählt pro Nutzer-ID, und die haben Anonyme nicht. Geprüft wird deshalb nicht
nur, DASS sie bremst, sondern auch die Stelle, an der eine naive Fassung
kaputtgeht: ein Zähler ohne Frist sperrt für immer.
"""

from __future__ import annotations

import os

import pytest
from redis.asyncio import Redis

from dcc_chat_gateway.gaeste import bremse


@pytest.fixture
async def redis():
    r = Redis.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:6380/0").replace(
            "localhost", "127.0.0.1"
        )
    )
    yield r
    await r.aclose()


@pytest.mark.asyncio
async def test_bremst_ab_dem_limit(redis):
    key = "gast:rate:test:bremst"
    await redis.delete(key)
    try:
        assert [await bremse(redis, key, 3, 60) for _ in range(4)] == [
            True,
            True,
            True,
            False,
        ]
    finally:
        await redis.delete(key)


@pytest.mark.asyncio
async def test_ein_zaehler_ohne_frist_wird_nachtraeglich_befristet(redis):
    """Der Fall, der eine IP dauerhaft aussperren würde.

    Zähler und Frist sind zwei Befehle. Bleibt der zweite aus (Verbindung
    stirbt genau dazwischen), liegt ein fristloser Schlüssel da: er zählt
    weiter und läuft nie ab. Mit ``nx=True`` holt der nächste Aufruf die Frist
    nach — ohne ihn wäre der Aufrufer für immer gesperrt.
    """
    key = "gast:rate:test:fristlos"
    await redis.delete(key)
    try:
        await redis.set(key, 1)  # fristloser Altbestand, wie nach dem Abriss
        assert await redis.ttl(key) == -1
        await bremse(redis, key, 30, 60)
        assert await redis.ttl(key) > 0, "der Schlüssel muss eine Frist bekommen"
    finally:
        await redis.delete(key)


@pytest.mark.asyncio
async def test_ein_laufendes_fenster_wird_nicht_verlaengert(redis):
    """Sonst hielte ein bestürmender Aufrufer sich selbst unbegrenzt gesperrt
    — und die Nachbarn hinter derselben IP gleich mit."""
    key = "gast:rate:test:fenster"
    await redis.delete(key)
    try:
        await bremse(redis, key, 30, 60)
        erste = await redis.ttl(key)
        await redis.expire(key, 5)  # Fenster läuft gleich ab
        await bremse(redis, key, 30, 60)
        assert await redis.ttl(key) <= 5, "die Frist darf nicht zurückgesetzt werden"
        assert erste > 5
    finally:
        await redis.delete(key)


@pytest.mark.asyncio
async def test_ohne_redis_wird_durchgelassen():
    """Fail-open, wie die übrige Präsenzschicht: eine Bremse, die bei Störung
    die Tür zumauert, verwandelt einen Redis-Ausfall in einen Totalausfall
    der Besprechungen."""
    assert await bremse(None, "egal", 1, 60) is True
