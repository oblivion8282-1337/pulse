"""Lese-Token sperren, wenn jemand die Community verliert.

Der Befund dahinter: das WHEP-Lese-Token ist an Kanal und Streamer gebunden,
nicht an den Zuschauer, und wird nicht verbraucht — ohne aktives Sperren schaut
ein Gebannter bis zu eine Stunde weiter (Bughunt 2026-08-13).
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.stream_revoke import revoke_read_tokens_for_viewer
from dcc_shared.streaming import read_cache_key


class _FakeSession:
    """Liefert die Kanaele einer Community — mehr braucht der Weg nicht."""

    def __init__(self, kanaele: dict[int, list[int]]):
        self.kanaele = kanaele
        self.abfragen = 0

    async def execute(self, stmt):
        self.abfragen += 1
        # Die Guild-Kennung steckt in der WHERE-Klausel; hier reicht es, die
        # gebundenen Parameter abzugreifen.
        werte = [
            p.value
            for p in stmt.compile().binds.values()
        ]
        guild_id = int(werte[0]) if werte else 0
        return _FakeResult(self.kanaele.get(guild_id, []))


class _FakeResult:
    def __init__(self, ids):
        self._ids = ids

    def scalars(self):
        return self._ids


class _FakeRedis:
    """Genug Redis fuer diesen Weg: scan_iter, mget, delete."""

    def __init__(self, daten: dict[str, str]):
        self.daten = {k.encode(): v.encode() for k, v in daten.items()}

    async def scan_iter(self, match: str, count: int = 100):
        vorsatz = match.rstrip("*").encode()
        for k in list(self.daten):
            if k.startswith(vorsatz):
                yield k

    async def mget(self, keys):
        return [self.daten.get(k) for k in keys]

    async def delete(self, *keys):
        n = 0
        for k in keys:
            kk = k if isinstance(k, bytes) else k.encode()
            if kk in self.daten:
                del self.daten[kk]
                n += 1
        return n


def _session() -> _FakeSession:
    """Frisch je Test — ein geteiltes Exemplar wuerde den ``abfragen``-Zaehler
    ueber Testgrenzen hinweg summieren."""
    return _FakeSession({1: [100, 101], 2: [200]})


@pytest.mark.asyncio
async def test_sperrt_nachschlage_und_token_schluessel():
    """**Beides muss weg.** Nur den Nachschlage-Schluessel zu loeschen hiesse:
    der naechste Anlauf holt ein frisches Token (gut) — aber das bereits
    ausgehaendigte gilt weiter (der eigentliche Fehler)."""
    cache = read_cache_key("42", "100", "7", 0)
    r = _FakeRedis({cache: "geheim-token", "stream:token:geheim-token": "{}"})

    n = await revoke_read_tokens_for_viewer(r, _session(), 1, 42, grund="test")

    assert n == 2
    assert r.daten == {}


@pytest.mark.asyncio
async def test_fremde_zuschauer_bleiben_unberuehrt():
    """Der Bann trifft EINEN — die Token aller anderen muessen stehen bleiben."""
    meins = read_cache_key("42", "100", "7", 0)
    fremd = read_cache_key("43", "100", "7", 0)
    r = _FakeRedis({
        meins: "t-42",
        "stream:token:t-42": "{}",
        fremd: "t-43",
        "stream:token:t-43": "{}",
    })

    await revoke_read_tokens_for_viewer(r, _session(), 1, 42, grund="test")

    assert fremd.encode() in r.daten
    assert b"stream:token:t-43" in r.daten
    assert meins.encode() not in r.daten


@pytest.mark.asyncio
async def test_ohne_token_passiert_nichts():
    r = _FakeRedis({})
    assert await revoke_read_tokens_for_viewer(r, _session(), 1, 42, grund="test") == 0


@pytest.mark.asyncio
async def test_ohne_redis_wirft_es_nicht():
    """Ein Bann darf nicht daran scheitern, dass Redis klemmt."""
    assert await revoke_read_tokens_for_viewer(None, _session(), 1, 42, grund="test") == 0


@pytest.mark.asyncio
async def test_ein_fehler_reisst_den_bann_nicht_mit():
    class _Kaputt(_FakeRedis):
        async def mget(self, keys):
            raise RuntimeError("redis weg")

    cache = read_cache_key("42", "100", "7", 0)
    r = _Kaputt({cache: "t", "stream:token:t": "{}"})
    # Wirft nicht — meldet 0 und protokolliert.
    assert await revoke_read_tokens_for_viewer(r, _session(), 1, 42, grund="test") == 0


@pytest.mark.asyncio
async def test_bann_in_einer_community_laesst_die_andere_in_ruhe():
    """Der wichtigste Fall. Der Schluessel traegt den Kanal, nicht die
    Community — ohne den Abgleich gegen die Kanalliste wuerde ein Bann in
    Server 1 auch die laufende Uebertragung in Server 2 abreissen."""
    hier = read_cache_key("42", "100", "7", 0)      # Kanal 100 -> Guild 1
    woanders = read_cache_key("42", "200", "9", 0)  # Kanal 200 -> Guild 2
    r = _FakeRedis({
        hier: "t-hier",
        "stream:token:t-hier": "{}",
        woanders: "t-woanders",
        "stream:token:t-woanders": "{}",
    })

    n = await revoke_read_tokens_for_viewer(r, _session(), 1, 42, grund="test")

    assert n == 2
    assert woanders.encode() in r.daten
    assert b"stream:token:t-woanders" in r.daten
    assert hier.encode() not in r.daten


@pytest.mark.asyncio
async def test_community_ohne_kanaele_fragt_redis_gar_nicht():
    """Ohne Kanaele kann es keine Treffer geben — dann auch kein SCAN."""

    class _Zaehlend(_FakeRedis):
        def __init__(self):
            super().__init__({})
            self.scans = 0

        async def scan_iter(self, match: str, count: int = 100):
            self.scans += 1
            for k in []:
                yield k

    r = _Zaehlend()
    assert await revoke_read_tokens_for_viewer(r, _FakeSession({}), 1, 42, grund="x") == 0
    assert r.scans == 0


@pytest.mark.asyncio
async def test_praefix_kollision_vier_gegen_zweiundvierzig():
    """``stream:read-cache:4:*`` darf ``…:42:…`` nicht treffen. Der Doppelpunkt
    ist literal — der Test haelt das fest, damit es beim naechsten Umbau der
    Schluesselform nicht lautlos kippt."""
    vier = read_cache_key("4", "100", "7", 0)
    zweiundvierzig = read_cache_key("42", "100", "7", 0)
    r = _FakeRedis({vier: "t-4", "stream:token:t-4": "{}",
                    zweiundvierzig: "t-42", "stream:token:t-42": "{}"})

    await revoke_read_tokens_for_viewer(r, _session(), 1, 4, grund="test")

    assert vier.encode() not in r.daten
    assert zweiundvierzig.encode() in r.daten
    assert b"stream:token:t-42" in r.daten
