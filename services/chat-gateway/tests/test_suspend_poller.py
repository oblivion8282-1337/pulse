"""Tests fuer den Sperr-Poller.

Der Fall, um den es geht: bis 2026-07-27 lief eine geloeschte Instanz unbeirrt
weiter, weil die Sperrliste der Cloud von niemandem abgefragt wurde. Diese Tests
halten fest, dass (a) der Zustand ankommt, (b) die feinere Angabe gewinnt und
(c) ein Cloud- oder Redis-Ausfall NICHT aussperrt.
"""

from __future__ import annotations

import httpx
import pytest

from dcc_chat_gateway.suspend_poller import (
    REDIS_SUSPENDED_ETAG_KEY,
    REDIS_SUSPENDED_KEY,
    STATE_ACTIVE,
    STATE_DELETED,
    STATE_SUSPENDED,
    _etag_marke,
    _state_for,
    read_state,
    suspend_poll_once,
)

MEINE_ID = 70557958936727552


class FakeRedis:
    """Minimal, aber mit Pipeline — der Poller schreibt gebuendelt."""

    def __init__(self, start: dict | None = None) -> None:
        self.data: dict[str, str] = dict(start or {})
        self.explodiert = False

    async def get(self, key: str):
        if self.explodiert:
            raise RuntimeError("Redis weg")
        return self.data.get(key)

    def pipeline(self):
        return _FakePipe(self)


class _FakePipe:
    def __init__(self, redis: FakeRedis) -> None:
        self.redis = redis
        self.ops: list[tuple[str, str]] = []

    def set(self, key: str, value: str) -> None:
        self.ops.append((key, value))

    async def execute(self) -> None:
        for key, value in self.ops:
            self.redis.data[key] = value


def _client(body: dict, etag: str = 'W/"x"', status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if status == 304:
            return httpx.Response(304)
        return httpx.Response(status, json=body, headers={"ETag": etag})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --- Zuordnung ------------------------------------------------------------


def test_nicht_in_der_liste_ist_aktiv():
    assert _state_for({"instance_ids": ["1", "2"]}, MEINE_ID) == STATE_ACTIVE


def test_gesperrt_wird_erkannt():
    body = {"instance_ids": [str(MEINE_ID)], "deleted_instance_ids": []}
    assert _state_for(body, MEINE_ID) == STATE_SUSPENDED


def test_geloescht_gewinnt_gegen_gesperrt():
    """`deleted_instance_ids` ist Teilmenge von `instance_ids` — die feinere
    Angabe muss gewinnen, sonst meldet die App "vorübergehend gesperrt" für
    einen Server, den es nicht mehr gibt."""
    body = {"instance_ids": [str(MEINE_ID)], "deleted_instance_ids": [str(MEINE_ID)]}
    assert _state_for(body, MEINE_ID) == STATE_DELETED


def test_ids_werden_als_text_verglichen():
    """Snowflakes kommen als String; ein int-Vergleich waere die Fehlerquelle."""
    body = {"instance_ids": [MEINE_ID], "deleted_instance_ids": []}
    assert _state_for(body, MEINE_ID) == STATE_SUSPENDED


# --- Poll-Zyklus ----------------------------------------------------------


@pytest.mark.asyncio
async def test_poll_schreibt_zustand_und_etag():
    redis = FakeRedis()
    body = {"instance_ids": [str(MEINE_ID)], "deleted_instance_ids": [str(MEINE_ID)]}
    async with _client(body, etag='W/"abc"') as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)
    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_DELETED
    # Mit Instanz-Marke: der ETag allein wuerde nach einem Wechsel der
    # Instanz-ID auf den falschen Zustand zeigen (s. unten).
    assert redis.data[REDIS_SUSPENDED_ETAG_KEY] == _etag_marke(MEINE_ID, 'W/"abc"')


@pytest.mark.asyncio
async def test_freigabe_setzt_zurueck():
    """Eine Sperre ist umkehrbar — der Poller muss auch wieder oeffnen."""
    redis = FakeRedis({REDIS_SUSPENDED_KEY: STATE_SUSPENDED})
    async with _client({"instance_ids": [], "deleted_instance_ids": []}) as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)
    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_ACTIVE


@pytest.mark.asyncio
async def test_cloud_ausfall_sperrt_nicht_aus():
    """DER wichtigste Test: ein Cloud-Ausfall darf keinen Self-Host lahmlegen.
    Der zuletzt bekannte Zustand bleibt stehen."""
    redis = FakeRedis({REDIS_SUSPENDED_KEY: STATE_ACTIVE})

    def kaputt(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Cloud nicht erreichbar")

    async with httpx.AsyncClient(transport=httpx.MockTransport(kaputt)) as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)
    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_ACTIVE


@pytest.mark.asyncio
async def test_serverfehler_laesst_stand_stehen():
    redis = FakeRedis({REDIS_SUSPENDED_KEY: STATE_SUSPENDED})
    async with _client({}, status=500) as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)
    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_SUSPENDED


@pytest.mark.asyncio
async def test_304_aendert_nichts():
    redis = FakeRedis({REDIS_SUSPENDED_KEY: STATE_SUSPENDED, REDIS_SUSPENDED_ETAG_KEY: 'W/"a"'})
    async with _client({}, status=304) as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)
    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_SUSPENDED


# --- Lesen ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_ohne_redis_nicht_gesperrt():
    assert await read_state(None) == STATE_ACTIVE


@pytest.mark.asyncio
async def test_redis_fehler_sperrt_nicht_aus():
    """Redis weg ist ein anderes Problem als 'gesperrt' — nicht aussperren."""
    redis = FakeRedis({REDIS_SUSPENDED_KEY: STATE_DELETED})
    redis.explodiert = True
    assert await read_state(redis) == STATE_ACTIVE


@pytest.mark.asyncio
async def test_bytes_aus_redis_werden_dekodiert():
    redis = FakeRedis({REDIS_SUSPENDED_KEY: b"deleted"})
    assert await read_state(redis) == STATE_DELETED


@pytest.mark.asyncio
async def test_unbekannter_wert_sperrt_nicht():
    """Ein Schluesselkonflikt oder ein Test-Mock darf nicht die ganze Instanz
    aussperren — nur die zwei bekannten Werte zaehlen."""
    for muell in ("<MagicMock id=1>", "true", "1", "gesperrt"):
        redis = FakeRedis({REDIS_SUSPENDED_KEY: muell})
        assert await read_state(redis) == STATE_ACTIVE, muell


# --- ETag gegen Instanz-Wechsel -------------------------------------------


def _client_mit_etag_pruefung(body: dict, etag: str) -> httpx.AsyncClient:
    """Die Cloud, wie sie wirklich antwortet: 304 nur bei passendem ETag.

    Der Standard-Helfer oben ignoriert ``If-None-Match`` und kann deshalb nicht
    zeigen, ob der Poller den ETag ueberhaupt mitschickt — genau darum geht es
    hier.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("If-None-Match") == etag:
            return httpx.Response(304)
        return httpx.Response(200, json=body, headers={"ETag": etag})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


ALTE_ID = 76731719364907008


@pytest.mark.asyncio
async def test_neue_instanz_id_verwirft_den_alten_etag():
    """Am 2026-08-27 an einer echten Instanz gemessen: Server lief nach einem
    Neuaufsetzen dauerhaft als "gesperrt", obwohl die Cloud ihn als aktiv
    fuehrte.

    Der ETag cacht die LISTE, der gespeicherte Zustand haengt aber an
    (Liste x eigener ID). Wechselt die ID, ohne dass sich die Liste aendert,
    antwortet die Cloud 304 — und ohne diese Pruefung bliebe der Zustand der
    VORGAENGER-Instanz stehen, und zwar bis irgendwo auf der Welt eine
    beliebige andere Instanz gesperrt wird.
    """
    liste = {"instance_ids": [str(ALTE_ID)], "deleted_instance_ids": [str(ALTE_ID)]}
    redis = FakeRedis(
        {
            REDIS_SUSPENDED_KEY: STATE_DELETED,
            REDIS_SUSPENDED_ETAG_KEY: _etag_marke(ALTE_ID, 'W/"unveraendert"'),
        }
    )
    async with _client_mit_etag_pruefung(liste, 'W/"unveraendert"') as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)

    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_ACTIVE


@pytest.mark.asyncio
async def test_gleiche_instanz_id_nutzt_den_etag_weiter():
    """Die Gegenprobe: bei unveraenderter ID bleibt der 304-Weg erhalten —
    ein Abruf je Minute soll die Liste nicht jedes Mal voll uebertragen."""
    liste = {"instance_ids": [str(MEINE_ID)], "deleted_instance_ids": []}
    redis = FakeRedis(
        {
            REDIS_SUSPENDED_KEY: STATE_SUSPENDED,
            REDIS_SUSPENDED_ETAG_KEY: _etag_marke(MEINE_ID, 'W/"gleich"'),
        }
    )
    async with _client_mit_etag_pruefung(liste, 'W/"gleich"') as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)

    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_SUSPENDED


@pytest.mark.asyncio
async def test_etag_aus_der_zeit_ohne_marke_gilt_nicht():
    """Bestandsfall: vor dieser Aenderung stand im Schluessel der nackte ETag.

    Er traegt keine Instanz-ID und ist damit nicht zuzuordnen — er muss
    verfallen, sonst bliebe eine bereits falsch gesperrte Instanz nach dem
    Update genauso stehen wie vorher.
    """
    liste = {"instance_ids": [str(ALTE_ID)], "deleted_instance_ids": [str(ALTE_ID)]}
    redis = FakeRedis(
        {REDIS_SUSPENDED_KEY: STATE_DELETED, REDIS_SUSPENDED_ETAG_KEY: 'W/"nackt"'}
    )
    async with _client_mit_etag_pruefung(liste, 'W/"nackt"') as client:
        await suspend_poll_once(redis, "https://cloud.example", MEINE_ID, client)

    assert redis.data[REDIS_SUSPENDED_KEY] == STATE_ACTIVE
