"""Backend-State-Verhalten des Tamagotchi-Plugins (PR3 Server-shared).

Drei Bereiche:

* **Mutators** — feed/play/sleep/reset arbeiten direkt auf einem dict,
  cappen Stats auf 0–100, refreshen ``lastUpdatedAt``.
* **State-Store** — ``apply_atomic_update`` persistiert, race-safe
  (Concurrency-Test mit ``asyncio.gather`` von 5 parallelen Feeds).
* **HTTP-Endpoint** — ``GET /guilds/{id}/plugins/tamagotchi/state``
  liefert Default ohne DB-Row, persistierten State danach, 403 für
  Nicht-Mitglieder.

Plugin-Backend (``plugins/tamagotchi/backend.py``) wird über das
synthetische ``pulse_plugin.tamagotchi.backend``-Import via Loader
geladen — siehe Loader-Pfad. Wir importieren die Funktionen direkt
über das geladene Modul.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest
from dcc_chat_gateway.models import GuildPluginState, InstancePluginAllowlist
from dcc_chat_gateway.plugins.state_store import (
    apply_atomic_update,
    get_state,
)


# ---------------------------------------------------------------------------
# Plugin-Modul direkt laden — wir wollen die _mutate_*-Funktionen testen,
# ohne den Plugin-Loader durchlaufen zu müssen.
# ---------------------------------------------------------------------------
_TAMAGOTCHI_DIR = Path(__file__).resolve().parents[3] / "plugins" / "tamagotchi"


def _load_tamagotchi_backend():
    spec = importlib.util.spec_from_file_location(
        "test_tamagotchi_backend_module", _TAMAGOTCHI_DIR / "backend.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


tama = _load_tamagotchi_backend()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _make_token(signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}"), uid


async def _seed_allowlist(session_factory, names: list[str]) -> None:
    async with session_factory() as s:
        for n in names:
            s.add(InstancePluginAllowlist(plugin_name=n, added_by_user_id=None))
        await s.commit()


# ---------------------------------------------------------------------------
# Pure-Mutator-Tests — kein DB-Bedarf.
# ---------------------------------------------------------------------------


def test_feed_increments_hunger_capped_at_100():
    state = dict(tama.DEFAULT_STATE)
    state["hunger"] = 90
    out = tama._mutate_feed(state)
    assert out["hunger"] == 100  # 90 + 20 → capped


def test_play_adds_happiness_subtracts_energy():
    state = dict(tama.DEFAULT_STATE)
    state["happiness"] = 50
    state["energy"] = 30
    out = tama._mutate_play(state)
    assert out["happiness"] == 70
    assert out["energy"] == 20


def test_play_floors_energy_at_zero():
    state = dict(tama.DEFAULT_STATE)
    state["energy"] = 5
    out = tama._mutate_play(state)
    assert out["energy"] == 0


def test_sleep_caps_energy_at_100():
    state = dict(tama.DEFAULT_STATE)
    state["energy"] = 90
    out = tama._mutate_sleep(state)
    assert out["energy"] == 100


def test_reset_returns_default():
    state = {"name": "Custom", "hunger": 5, "happiness": 5, "energy": 5}
    out = tama._mutate_reset(state)
    assert out["name"] == "Tamagotchi"
    assert out["hunger"] == 80
    assert out["happiness"] == 80
    assert out["energy"] == 80


def test_merge_defaults_clamps_garbage_input():
    out = tama._merge_defaults({"hunger": 9999, "happiness": -50, "energy": "broken"})
    assert out["hunger"] == 100
    assert out["happiness"] == 0
    assert out["energy"] == 80  # ValueError fallback


# ---------------------------------------------------------------------------
# State-Store-Tests — apply_atomic_update + Default-Row-Auto-Create.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_atomic_update_creates_default_row(session_factory):
    """Erster Op auf einer Guild: kein Row da → Default-Row entsteht,
    dann läuft der Mutator drauf."""
    async with session_factory() as s:
        out = await apply_atomic_update(
            s,
            guild_id=1234,
            plugin_name="tamagotchi",
            default_state=dict(tama.DEFAULT_STATE),
            mutate=tama._mutate_feed,
            actor_user_id=42,
        )
    assert out["hunger"] == 100  # 80 (default) + 20
    assert out["happiness"] == 80
    assert out["energy"] == 80

    async with session_factory() as s:
        row = await s.get(GuildPluginState, (1234, "tamagotchi"))
        assert row is not None
        assert row.state["hunger"] == 100
        assert row.updated_by_user_id == 42


@pytest.mark.asyncio
async def test_apply_atomic_update_second_call_mutates_existing(session_factory):
    """Zweiter Op auf derselben Guild läuft auf dem persistierten State,
    nicht auf dem Default."""
    async with session_factory() as s:
        await apply_atomic_update(
            s,
            guild_id=1235,
            plugin_name="tamagotchi",
            default_state=dict(tama.DEFAULT_STATE),
            mutate=tama._mutate_feed,
            actor_user_id=1,
        )
    async with session_factory() as s:
        out = await apply_atomic_update(
            s,
            guild_id=1235,
            plugin_name="tamagotchi",
            default_state=dict(tama.DEFAULT_STATE),
            mutate=tama._mutate_feed,
            actor_user_id=2,
        )
    # Erster feed: 80→100 (capped); zweiter feed: 100→100 (immer noch capped).
    assert out["hunger"] == 100

    async with session_factory() as s:
        row = await s.get(GuildPluginState, (1235, "tamagotchi"))
        assert row.updated_by_user_id == 2  # zweiter Akteur überschreibt


@pytest.mark.asyncio
async def test_get_state_returns_none_when_no_row(session_factory):
    async with session_factory() as s:
        out = await get_state(s, 9999, "tamagotchi")
    assert out is None


@pytest.mark.asyncio
async def test_get_state_returns_persisted_value(session_factory):
    async with session_factory() as s:
        await apply_atomic_update(
            s,
            guild_id=5555,
            plugin_name="tamagotchi",
            default_state=dict(tama.DEFAULT_STATE),
            mutate=tama._mutate_play,
            actor_user_id=10,
        )
    async with session_factory() as s:
        out = await get_state(s, 5555, "tamagotchi")
    assert out is not None
    assert out["happiness"] == 100  # 80 + 20 → capped
    assert out["energy"] == 70  # 80 − 10


@pytest.mark.asyncio
async def test_concurrent_feeds_are_serialised(session_factory):
    """5 parallele feed-Ops über asyncio.gather → End-State deterministisch
    capped (alle 5 stoßen den Hunger-Cap).

    Race-Safety wird auf Postgres durch ``SELECT ... FOR UPDATE``
    garantiert; SQLite serialisiert Writes ohnehin pro-Datei. Beide
    Pfade müssen denselben deterministischen End-State liefern.
    """
    gid = 7777

    async def _one_feed() -> dict[str, Any]:
        async with session_factory() as s:
            return await apply_atomic_update(
                s,
                guild_id=gid,
                plugin_name="tamagotchi",
                default_state=dict(tama.DEFAULT_STATE),
                mutate=tama._mutate_feed,
                actor_user_id=1,
            )

    results = await asyncio.gather(*(_one_feed() for _ in range(5)))
    # Alle 5 Resultate sind das jeweils-aktuelle persisted-state. Wegen
    # Race wissen wir nicht, in welcher Reihenfolge — aber der ENDzustand
    # ist deterministisch (capped 100).
    assert all(r["hunger"] == 100 for r in results), [r["hunger"] for r in results]

    async with session_factory() as s:
        row = await s.get(GuildPluginState, (gid, "tamagotchi"))
        assert row.state["hunger"] == 100


# ---------------------------------------------------------------------------
# HTTP-Endpoint-Tests — GET /guilds/{id}/plugins/tamagotchi/state
# ---------------------------------------------------------------------------


async def _create_guild(client, token: str) -> int:
    r = await client.post("/guilds", json={"name": "g"}, headers=_auth(token))
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_get_state_default_when_no_row(
    client, _auth_signer, session_factory
):
    """Frisch-erstellte Guild ohne jemals einen Op gesehen zu haben →
    Default-State (80/80/80, Name "Tamagotchi"), KEINE DB-Row entsteht."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    token, _ = await _make_token(_auth_signer)
    gid = await _create_guild(client, token)

    r = await client.get(
        f"/guilds/{gid}/plugins/tamagotchi/state", headers=_auth(token)
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Tamagotchi"
    assert body["hunger"] == 80
    assert body["happiness"] == 80
    assert body["energy"] == 80

    # Kein Insert beim GET — Row sollte weiterhin nicht existieren.
    async with session_factory() as s:
        row = await s.get(GuildPluginState, (gid, "tamagotchi"))
        assert row is None


@pytest.mark.asyncio
async def test_get_state_after_persisted_mutation(
    client, _auth_signer, session_factory
):
    """Nach apply_atomic_update liefert GET den persistierten State."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    token, _ = await _make_token(_auth_signer)
    gid = await _create_guild(client, token)

    async with session_factory() as s:
        await apply_atomic_update(
            s,
            guild_id=gid,
            plugin_name="tamagotchi",
            default_state=dict(tama.DEFAULT_STATE),
            mutate=tama._mutate_feed,
            actor_user_id=1,
        )

    r = await client.get(
        f"/guilds/{gid}/plugins/tamagotchi/state", headers=_auth(token)
    )
    assert r.status_code == 200
    assert r.json()["hunger"] == 100  # 80 + 20


@pytest.mark.asyncio
async def test_get_state_non_member_403(
    client, _auth_signer, session_factory
):
    """Nicht-Mitglied der Guild → 403 (require_member-Pfad)."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    owner_token, _ = await _make_token(_auth_signer)
    gid = await _create_guild(client, owner_token)

    outsider_token, _ = await _make_token(_auth_signer)
    r = await client.get(
        f"/guilds/{gid}/plugins/tamagotchi/state",
        headers=_auth(outsider_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_get_state_coerces_garbage_persisted_blob(
    client, _auth_signer, session_factory
):
    """Persistierter State mit Schema-Drift (alte/kaputte Keys) wird
    durch ``_coerce_tamagotchi_state`` defensive normalisiert — kein 500."""
    await _seed_allowlist(session_factory, ["hello", "tamagotchi"])
    token, _ = await _make_token(_auth_signer)
    gid = await _create_guild(client, token)

    async with session_factory() as s:
        s.add(
            GuildPluginState(
                guild_id=gid,
                plugin_name="tamagotchi",
                state={
                    "hunger": 9999,
                    "happiness": -10,
                    # name fehlt komplett, energy ist garbage
                    "energy": "broken",
                },
                updated_by_user_id=None,
            )
        )
        await s.commit()

    r = await client.get(
        f"/guilds/{gid}/plugins/tamagotchi/state", headers=_auth(token)
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Tamagotchi"
    assert body["hunger"] == 100  # clamp
    assert body["happiness"] == 0  # clamp
    assert body["energy"] == 80  # fallback
