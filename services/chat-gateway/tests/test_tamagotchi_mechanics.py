"""Pure-Mechanik des Tamagotchi-"Lebendiges Pet"-Updates (v0.3.0).

Testet ``plugins/tamagotchi/mechanics.py`` — die zustandslose Kernlogik
für Zeit-Decay, Tod-Berechnung und XP/Level. Keine DB, kein Loader: das
Modul wird direkt via ``importlib`` geladen (gleiches Muster wie
``test_tamagotchi_state.py``).

Decay + Tod sind rein aus ``lastUpdatedAt`` + den gespeicherten Stats
ableitbar (kein Background-Loop, multi-pod-safe). Tod-Härte = "streng":
Hunger erreicht 0 und bleibt ``DEATH_GRACE_HOURS`` so → tot.
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_TAMAGOTCHI_DIR = Path(__file__).resolve().parents[3] / "plugins" / "tamagotchi"


def _load_mechanics():
    spec = importlib.util.spec_from_file_location(
        "test_tamagotchi_mechanics_module", _TAMAGOTCHI_DIR / "mechanics.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


m = _load_mechanics()

_NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _state(**over):
    base = {
        "name": "Tamagotchi",
        "hunger": 80,
        "happiness": 80,
        "energy": 80,
        "alive": True,
        "xp": 0,
        "level": 1,
        "lastUpdatedAt": _iso(_NOW),
    }
    base.update(over)
    return base


# --- Decay -----------------------------------------------------------------


def test_decay_reduces_stats_by_rate_times_hours():
    st = _state(lastUpdatedAt=_iso(_NOW - timedelta(hours=2)))
    out = m.apply_decay(st, _NOW)
    # hunger 10/h * 2h = -20 → 60; happiness 6/h → -12 → 68; energy 5/h → -10 → 70
    assert out["hunger"] == 60
    assert out["happiness"] == 68
    assert out["energy"] == 70


def test_decay_floors_at_zero():
    st = _state(hunger=15, lastUpdatedAt=_iso(_NOW - timedelta(hours=10)))
    out = m.apply_decay(st, _NOW)
    assert out["hunger"] == 0


def test_decay_zero_elapsed_no_change():
    st = _state(lastUpdatedAt=_iso(_NOW))
    out = m.apply_decay(st, _NOW)
    assert out["hunger"] == 80
    assert out["happiness"] == 80
    assert out["energy"] == 80


def test_decay_does_not_mutate_input():
    st = _state(lastUpdatedAt=_iso(_NOW - timedelta(hours=1)))
    m.apply_decay(st, _NOW)
    assert st["hunger"] == 80  # original untouched


# --- Tod -------------------------------------------------------------------


def test_not_dead_when_recently_fed():
    st = _state(hunger=80, lastUpdatedAt=_iso(_NOW - timedelta(hours=1)))
    assert m.should_be_dead(st, _NOW) is False


def test_dead_after_grace_past_starvation():
    # hunger 80, rate 10/h → 0 nach 8h. + DEATH_GRACE_HOURS (12) = 20h.
    st = _state(hunger=80, lastUpdatedAt=_iso(_NOW - timedelta(hours=21)))
    assert m.should_be_dead(st, _NOW) is True


def test_not_dead_within_grace_after_starvation():
    # 8h bis Hunger 0, +6h Gnade = 14h < 20h Schwelle
    st = _state(hunger=80, lastUpdatedAt=_iso(_NOW - timedelta(hours=14)))
    assert m.should_be_dead(st, _NOW) is False


def test_already_starving_dies_after_grace_only():
    # hunger schon 0 gespeichert → time-to-zero 0 → tot nach reiner Gnadenfrist
    st = _state(hunger=0, lastUpdatedAt=_iso(_NOW - timedelta(hours=13)))
    assert m.should_be_dead(st, _NOW) is True


# --- XP / Level ------------------------------------------------------------


def test_level_for_xp_thresholds():
    assert m.level_for_xp(0) == 1
    assert m.level_for_xp(99) == 1
    assert m.level_for_xp(100) == 2
    assert m.level_for_xp(300) == 3
    assert m.level_for_xp(1000) == 5


def test_xp_for_level_monotonic_increasing():
    seq = [m.xp_for_level(n) for n in range(1, 8)]
    assert seq == sorted(seq)
    assert seq[0] == 0  # level 1 needs no xp


def test_gain_xp_bumps_xp_and_recomputes_level():
    st = _state(xp=90, level=1)
    out = m.gain_xp(st, 10)
    assert out["xp"] == 100
    assert out["level"] == 2


def test_gain_xp_does_not_mutate_input():
    st = _state(xp=0, level=1)
    m.gain_xp(st, 10)
    assert st["xp"] == 0


# --- apply_action (volle Lifecycle-Transition) -----------------------------


def test_action_feed_adds_hunger_and_xp_and_stamps_time():
    st = _state(hunger=50, xp=0, lastUpdatedAt=_iso(_NOW))
    out = m.apply_action(st, "feed", _NOW)
    assert out["hunger"] == 70  # +20, no decay (0 elapsed)
    assert out["xp"] == m.XP_PER_ACTION
    assert out["lastUpdatedAt"] == _iso(_NOW)


def test_action_play_trades_energy_for_happiness():
    st = _state(happiness=50, energy=30, lastUpdatedAt=_iso(_NOW))
    out = m.apply_action(st, "play", _NOW)
    assert out["happiness"] == 70
    assert out["energy"] == 20


def test_action_sleep_restores_energy():
    st = _state(energy=40, lastUpdatedAt=_iso(_NOW))
    out = m.apply_action(st, "sleep", _NOW)
    assert out["energy"] == 70


def test_action_applies_decay_catchup_before_action():
    # 2h elapsed → hunger 80→60 (decay), dann feed +20 → 80
    st = _state(hunger=80, lastUpdatedAt=_iso(_NOW - timedelta(hours=2)))
    out = m.apply_action(st, "feed", _NOW)
    assert out["hunger"] == 80


def test_action_reset_returns_full_default_alive():
    st = _state(hunger=5, happiness=5, energy=5, xp=500, level=4)
    out = m.apply_action(st, "reset", _NOW)
    assert out["hunger"] == 80
    assert out["happiness"] == 80
    assert out["energy"] == 80
    assert out["alive"] is True
    assert out["xp"] == 0
    assert out["level"] == 1


def test_action_on_dead_pet_is_noop():
    st = _state(alive=False, hunger=0, xp=100, lastUpdatedAt=_iso(_NOW))
    out = m.apply_action(st, "feed", _NOW)
    assert out["alive"] is False
    assert out["hunger"] == 0  # feed ignored
    assert out["xp"] == 100  # no xp gained


def test_action_kills_neglected_pet_and_forfeits_action():
    # 21h since last update, hunger 80 → starved + grace passed → dies
    st = _state(hunger=80, lastUpdatedAt=_iso(_NOW - timedelta(hours=21)))
    out = m.apply_action(st, "feed", _NOW)
    assert out["alive"] is False
    assert out["hunger"] == 0  # action forfeited, decayed to 0


def test_fresh_pet_is_not_dead_despite_epoch_timestamp():
    # Default-Row wird mit Epoch-Sentinel angelegt → darf NICHT als
    # "ewig verhungert" gelten.
    st = _state(lastUpdatedAt=m.DEFAULT_STATE["lastUpdatedAt"])
    assert m.should_be_dead(st, _NOW) is False


def test_action_on_fresh_pet_feeds_without_starving():
    # Erster feed auf frischer Guild (Epoch-Timestamp): kein rückwirkender
    # Decay/Tod, Aktion greift normal.
    st = _state(hunger=80, lastUpdatedAt=m.DEFAULT_STATE["lastUpdatedAt"])
    out = m.apply_action(st, "feed", _NOW)
    assert out["alive"] is True
    assert out["hunger"] == 100  # 80 + 20, kein Decay
    assert out["lastUpdatedAt"] == _iso(_NOW)


def test_revive_brings_dead_pet_back_keeping_progress():
    st = _state(alive=False, hunger=0, happiness=0, energy=0, xp=300, level=3)
    out = m.revive(st, _NOW)
    assert out["alive"] is True
    assert out["hunger"] == m.REVIVE_STAT
    assert out["happiness"] == m.REVIVE_STAT
    assert out["energy"] == m.REVIVE_STAT
    assert out["xp"] == 300  # progress kept
    assert out["level"] == 3
    assert out["lastUpdatedAt"] == _iso(_NOW)
