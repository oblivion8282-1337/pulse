"""In-process per-user rate limiting for the voice-signaling service.

This is intentionally minimal: each bucket is a sliding window keyed on
(action, user_id) held in module-global state. It is *per process* — for a
multi-instance deployment behind Caddy this must be swapped for a Redis-backed
limiter. Buckets are evicted lazily once their window has fully elapsed, so
memory stays bounded by the number of *currently active* users.
"""

from __future__ import annotations

from time import monotonic

# action -> {user_id -> (window_start_monotonic, count)}
_buckets: dict[str, dict[int, tuple[float, int]]] = {}

# action -> (limit, window_seconds)
_RULES: dict[str, tuple[int, float]] = {
    # Jeder Voice-Join kostet ein Token; schnelles Kanal-Wechseln (Admin
    # zieht einen User durch Kanäle, Client-Reconnect nach Netzflicken)
    # braucht mehrere in der Minute. 5/min warf da schon beim dritten Zug
    # ein 429 — der Gezogene strandet dann ohne Voice („User verschwunden").
    # 20/min ist weiter strikt gegen Token-Minting-Missbrauch.
    "token": (20, 60.0),
}


def check(action: str, user_id: int) -> bool:
    """Return True if the call is allowed, False if the user is over budget.

    A side effect of every call is an opportunistic sweep of expired buckets
    for this action, which keeps the dict from growing without bound.
    """
    limit, window = _RULES[action]
    now = monotonic()
    bucket = _buckets.setdefault(action, {})

    # Lazy eviction: drop entries whose window has fully elapsed.
    if bucket:
        expired = [uid for uid, (start, _) in bucket.items() if now - start >= window]
        for uid in expired:
            del bucket[uid]

    entry = bucket.get(user_id)
    if entry is None or now - entry[0] >= window:
        bucket[user_id] = (now, 1)
        return True
    start, count = entry
    if count >= limit:
        return False
    bucket[user_id] = (start, count + 1)
    return True


def reset() -> None:
    """Clear all buckets (used by tests)."""
    _buckets.clear()
