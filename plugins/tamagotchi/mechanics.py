"""Tamagotchi pure mechanics — "Lebendiges Pet"-Update (v0.3.0).

Zustandslose Kernlogik: Zeit-Decay, Tod-Berechnung, XP/Level. Bewusst
**ohne** DB-, Redis- oder Loader-Abhängigkeit, damit sie isoliert
testbar ist (``test_tamagotchi_mechanics.py``) und sowohl vom
Backend-Handler (``backend.py``) als auch — als TS-Spiegel in
``store.ts`` — vom Frontend genutzt werden kann.

**Decay ist lazy/timestamp-basiert** (kein Background-Loop): jeder Stat
sinkt mit einer festen Rate pro Stunde seit ``lastUpdatedAt``. Damit ist
der State multi-pod-safe und braucht keine Server-Tick-Loop.

**Tod-Härte "streng"**: Hunger erreicht 0 (nach ``hunger / rate`` Stunden)
und bleibt ``DEATH_GRACE_HOURS`` so → das Pet stirbt. Rein aus
``lastUpdatedAt`` + gespeichertem Hunger ableitbar, kein Extra-Feld.

Die TS-Konstanten in ``store.ts`` MÜSSEN mit den Werten hier synchron
bleiben (gleiches Muster wie das permissions-bitfield).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

# Default-Pet bei Erstkontakt mit einer Guild. ``lastUpdatedAt`` wird beim
# ersten Mutate auf now() überschrieben.
DEFAULT_STATE: dict[str, Any] = {
    "name": "Tamagotchi",
    "hunger": 80,
    "happiness": 80,
    "energy": 80,
    "alive": True,
    "xp": 0,
    "level": 1,
    "lastUpdatedAt": "1970-01-01T00:00:00+00:00",
}

# Stats, auf die ein wiederbelebtes Pet zurückkommt (zweite Chance, kein
# Gratis-Vollreset).
REVIVE_STAT = 40

# Decay-Raten in Punkten/Stunde. Startwerte — leicht justierbar.
DECAY_PER_HOUR: dict[str, float] = {
    "hunger": 10.0,
    "happiness": 6.0,
    "energy": 5.0,
}

# Gnadenfrist ab Hunger=0 bis Tod (streng). Mit Default-Hunger 80 und
# Rate 10/h: 8h bis Hunger 0, + 12h = ~20h totale Vernachlässigung.
DEATH_GRACE_HOURS = 12.0

# XP pro Pflege-Aktion (feed/play/sleep).
XP_PER_ACTION = 10

_STATS = ("hunger", "happiness", "energy")


def _clamp(value: float, lo: float = 0, hi: float = 100) -> int:
    return int(max(lo, min(hi, value)))


def _is_unborn(state: dict[str, Any]) -> bool:
    """True, solange das Pet noch nie real gestempelt wurde (Default-Row
    trägt den Epoch-Sentinel). Verhindert, dass ein frisches Pet beim
    ersten Zugriff rückwirkend "verhungert" / stirbt."""
    return state.get("lastUpdatedAt", "") == DEFAULT_STATE["lastUpdatedAt"]


def _hours_since(then_iso: str, now: datetime) -> float:
    """Stunden zwischen ``then_iso`` (ISO-8601) und ``now``. Negativ /
    unparsebar → 0 (kein Decay)."""
    try:
        then = datetime.fromisoformat(then_iso)
    except (TypeError, ValueError):
        return 0.0
    elapsed = (now - then).total_seconds() / 3600.0
    return elapsed if elapsed > 0 else 0.0


def apply_decay(state: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Gib einen neuen State zurück, dessen Stats um ``rate * verstrichene
    Stunden`` gesunken sind (geclamped auf 0). ``lastUpdatedAt`` und
    ``alive`` bleiben unangetastet — das ist Sache des Callers."""
    out = dict(state)
    if _is_unborn(state):
        return out
    elapsed = _hours_since(state.get("lastUpdatedAt", ""), now)
    if elapsed <= 0:
        return out
    for stat in _STATS:
        cur = state.get(stat, 0)
        out[stat] = _clamp(cur - DECAY_PER_HOUR[stat] * elapsed)
    return out


def should_be_dead(state: dict[str, Any], now: datetime) -> bool:
    """True, wenn der Hunger 0 erreicht hat und die Gnadenfrist abgelaufen
    ist. Rechnet auf dem gespeicherten (un-decayten) State. Ein ungeborenes
    Pet (Epoch-Sentinel) kann nicht tot sein."""
    if _is_unborn(state):
        return False
    rate = DECAY_PER_HOUR["hunger"]
    hunger = max(0, state.get("hunger", 0))
    time_to_zero = hunger / rate if rate > 0 else 0.0
    elapsed = _hours_since(state.get("lastUpdatedAt", ""), now)
    return elapsed >= time_to_zero + DEATH_GRACE_HOURS


def xp_for_level(level: int) -> int:
    """Kumulative XP, um ``level`` zu erreichen. Quadratische Kurve:
    Level 1 = 0, Level n = 50·(n-1)·n (→ 0/100/300/600/1000/…)."""
    if level <= 1:
        return 0
    return 50 * (level - 1) * level


def level_for_xp(xp: int) -> int:
    """Höchstes Level, dessen Schwelle ``xp`` erreicht."""
    level = 1
    while xp_for_level(level + 1) <= xp:
        level += 1
    return level


def gain_xp(state: dict[str, Any], amount: int) -> dict[str, Any]:
    """Erhöhe XP um ``amount`` und leite das Level neu ab. Reiner Return,
    mutiert den Input nicht."""
    out = dict(state)
    out["xp"] = int(state.get("xp", 0)) + amount
    out["level"] = level_for_xp(out["xp"])
    return out


def merge_defaults(state: dict[str, Any] | None) -> dict[str, Any]:
    """Fülle fehlende Keys mit Defaults + coerce auf valide Typen/Ranges.
    Schutz gegen Schema-Drift (alte Blobs ohne alive/xp/level)."""
    merged = dict(DEFAULT_STATE)
    merged.update(state or {})
    for key in _STATS:
        try:
            merged[key] = _clamp(int(merged.get(key, 80)))
        except (TypeError, ValueError):
            merged[key] = 80
    if not isinstance(merged.get("name"), str) or not merged["name"]:
        merged["name"] = DEFAULT_STATE["name"]
    merged["alive"] = bool(merged.get("alive", True))
    try:
        merged["xp"] = max(0, int(merged.get("xp", 0)))
    except (TypeError, ValueError):
        merged["xp"] = 0
    merged["level"] = level_for_xp(merged["xp"])
    return merged


# Reine Aktions-Deltas auf einem bereits decayten/gemergten State.
_ACTION_DELTAS = {
    "feed": {"hunger": 20},
    "play": {"happiness": 20, "energy": -10},
    "sleep": {"energy": 30},
}


def apply_action(
    state: dict[str, Any], action: str, now: datetime
) -> dict[str, Any]:
    """Volle Lifecycle-Transition für eine Pflege-Aktion.

    Reihenfolge: defaults mergen → tot? (no-op) → Decay-Catch-up →
    gerade verhungert? (sterben, Aktion verfällt) → Aktion + XP →
    Zeitstempel. ``reset`` ist ein harter Voll-Reset (lebendig, XP weg).
    Reiner Return, mutiert den Input nicht.
    """
    s = merge_defaults(state)

    if action == "reset":
        fresh = dict(DEFAULT_STATE)
        fresh["lastUpdatedAt"] = now.isoformat()
        return fresh

    if not s["alive"]:
        return s

    if should_be_dead(s, now):
        dead = apply_decay(s, now)
        dead["alive"] = False
        return dead

    s = apply_decay(s, now)
    for stat, delta in _ACTION_DELTAS.get(action, {}).items():
        s[stat] = _clamp(s[stat] + delta)
    s = gain_xp(s, XP_PER_ACTION)
    s["lastUpdatedAt"] = now.isoformat()
    return s


def revive(state: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Bringe ein totes Pet zurück: alive, Stats auf ``REVIVE_STAT``,
    XP/Level bleiben erhalten (zweite Chance). Reiner Return."""
    s = merge_defaults(state)
    s["alive"] = True
    for stat in _STATS:
        s[stat] = REVIVE_STAT
    s["lastUpdatedAt"] = now.isoformat()
    return s
