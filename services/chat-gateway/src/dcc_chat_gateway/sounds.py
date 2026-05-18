"""Per-guild sound override constants.

The set of valid ``sound_id`` values mirrors the frontend registry
(``web/src/lib/sounds/registry.ts``). Kept in sync by hand — if a new
sound is added to the frontend, also add it here (and bump tests).
The DB column is plain TEXT (not an enum) so adding new IDs needs no
migration; the application layer rejects unknown IDs.
"""

from __future__ import annotations

# Must mirror SOUNDS keys in web/src/lib/sounds/registry.ts.
VALID_SOUND_IDS: frozenset[str] = frozenset(
    {
        "notification.message",
        "notification.mention",
        "notification.dm",
        "voice.user_join",
        "voice.user_leave",
        "voice.self_join",
        "voice.self_leave",
        "voice.self_mute",
        "voice.self_unmute",
        "voice.self_deafen",
        "voice.self_undeafen",
        "ui.send",
        "ui.modal_open",
    }
)

# Pinning Content-Type at upload time makes MinIO reject mismatches and
# lets the browser pick the right decoder on playback. WAV is excluded
# on purpose — uncompressed is 10× larger and would blow past sensible
# size caps for no audible win on short UI sounds.
ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset({"audio/ogg", "audio/mpeg"})


def storage_key(guild_id: int, sound_id: str) -> str:
    """MinIO key for the override blob. Stable across uploads — a re-upload
    overwrites in place. The browser never sees this key directly; it
    receives a fresh presigned GET URL on every fetch."""
    return f"guild-sounds/{guild_id}/{sound_id}"
