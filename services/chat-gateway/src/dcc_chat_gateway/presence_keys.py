"""Redis key constants for the Etappe-3 presence-status system.

Analogous to ``streamkeys.py`` — centralises key names so the code
never contains magic strings.  Both ``presence_status.py`` (the sweeper
+ broadcast helper) and the REST route import from here.
"""

from __future__ import annotations

# presence:status:<user_id>  →  "online"|"idle"|"dnd"|"invisible"
# TTL 24 h, refreshed on every explicit set.
PRESENCE_STATUS_KEY = "presence:status:{user_id}"
PRESENCE_STATUS_TTL_SECONDS = 86_400  # 24 h

# presence:activity  →  ZSET  member=str(user_id)  score=unix-ms last-activity
# Updated on every ``activity`` WS op.  No explicit cleanup needed —
# the idle sweeper reads and acts on stale members.
PRESENCE_ACTIVITY_ZSET = "presence:activity"

__all__ = [
    "PRESENCE_STATUS_KEY",
    "PRESENCE_STATUS_TTL_SECONDS",
    "PRESENCE_ACTIVITY_ZSET",
]
