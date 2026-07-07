"""Smoke tests for the event-schema-registry.

We don't test every field of every model — that's what type-checking and
the actual publisher/subscriber tests are for. Here we just make sure:

* every entry in ``EVENT_REGISTRY`` constructs cleanly with a
  representative payload,
* ``model_dump(mode="json")`` round-trips through
  ``model_validate(payload)`` (so a fresh listener can revive a wire
  payload back into the same model),
* the discriminator (``op``) emitted on the wire matches the registry
  key (no copy-paste mismatch),
* the bare-snapshot shapes work even though they're not in the registry.
"""

from __future__ import annotations

from typing import Any

import pytest

from dcc_shared.events import (
    EVENT_REGISTRY,
    ChannelBumpEvent,
    ChannelCreatedEvent,
    DmBumpEvent,
    FriendRemovedEvent,
    FriendRequestReceivedEvent,
    GuildBanAddedEvent,
    GuildMemberRemovedEvent,
    MessageDeleteEvent,
    MessageEvent,
    PresenceStatusChangedEvent,
    PresenceUpdateEvent,
    StreamStateSnapshot,
    UserBlockedEvent,
    VoiceDisconnectEvent,
    VoiceOverrideEvent,
    VoiceStateSnapshot,
    WatchStateSnapshot,
)


# Representative payloads keyed by op. Every registry entry must have one
# — the parametrised test below iterates ``EVENT_REGISTRY`` and looks up
# the payload here. Missing entries fail loudly (KeyError) which is the
# point: forgetting to register a payload sample is the same kind of
# bug as forgetting to register the model itself.
_PAYLOADS: dict[str, dict[str, Any]] = {
    "message": {"op": "message", "data": {"id": "1", "content": "hi"}},
    "message_update": {
        "op": "message_update",
        "data": {"id": "1", "content": "edited"},
    },
    "message_delete": {
        "op": "message_delete",
        "data": {"id": "1", "channel_id": "2"},
    },
    "reaction_add": {
        "op": "reaction_add",
        "data": {
            "message_id": "1",
            "channel_id": "2",
            "user_id": "3",
            "emoji": ":smile:",
        },
    },
    "reaction_remove": {
        "op": "reaction_remove",
        "data": {
            "message_id": "1",
            "channel_id": "2",
            "user_id": "3",
            "emoji": ":smile:",
        },
    },
    "stream_chat_message": {
        "op": "stream_chat_message",
        "channel_id": "10",
        "streamer_id": "11",
        "message": {
            "id": "1",
            "author_id": "11",
            "content": "hi",
            "created_at": "2026-05-23T12:00:00Z",
        },
    },
    "watch_chat_message": {
        "op": "watch_chat_message",
        "channel_id": "10",
        "party_id": "20",
        "message": {
            "id": "1",
            "author_id": "11",
            "content": "hi",
            "created_at": "2026-05-23T12:00:00Z",
        },
    },
    "watch_chat_reaction": {
        "op": "watch_chat_reaction",
        "data": {
            "message_id": "1",
            "channel_id": "10",
            "party_id": "20",
            "user_id": "11",
            "emoji": "🔥",
            "added": True,
        },
    },
    "channel_bump": {
        "op": "channel_bump",
        "guild_id": "5",
        "channel_id": "6",
        "message_id": "1",
        "author_id": "3",
    },
    "dm_bump": {
        "op": "dm_bump",
        "channel_id": "7",
        "user_a_id": "3",
        "user_b_id": "4",
        "message_id": "1",
        "author_id": "3",
    },
    "typing": {
        "op": "typing",
        "channel_id": "7",
        "user_id": "3",
    },
    "mention_added": {
        "op": "mention_added",
        "data": {"channel_id": "6", "message_id": "1", "guild_id": "5"},
    },
    "friend_request_received": {
        "op": "friend_request_received",
        "data": {"request_id": "9", "from": "3"},
    },
    "friend_request_accepted": {
        "op": "friend_request_accepted",
        "data": {"user_id": "4"},
    },
    "friend_request_declined": {
        "op": "friend_request_declined",
        "data": {"request_id": "9"},
    },
    "friend_request_cancelled": {
        "op": "friend_request_cancelled",
        "data": {"request_id": "9"},
    },
    "friend_removed": {"op": "friend_removed", "data": {"user_id": "4"}},
    "user_blocked": {"op": "user_blocked", "data": {"user_id": "4"}},
    "user_unblocked": {"op": "user_unblocked", "data": {"user_id": "4"}},
    "community_invite_received": {
        "op": "community_invite_received",
        "data": {
            "id": "9",
            "inviter_id": "3",
            "target_host": "pulse.firma.de",
            "code": "ABCD1234",
        },
    },
    "community_invite_removed": {
        "op": "community_invite_removed",
        "data": {"invite_id": "9"},
    },
    "channel_created": {"op": "channel_created", "channel": {"id": "6"}},
    "channel_updated": {"op": "channel_updated", "channel": {"id": "6"}},
    "channel_deleted": {
        "op": "channel_deleted",
        "guild_id": "5",
        "channel_id": "6",
    },
    "channel_permissions_updated": {
        "op": "channel_permissions_updated",
        "channel_id": "6",
        "guild_id": "5",
        "overwrites": [{"target_type": 0, "target_id": "1"}],
    },
    "guild_updated": {"op": "guild_updated", "guild": {"id": "5"}},
    "guild_deleted": {"op": "guild_deleted", "guild_id": "5"},
    "guild_member_added": {
        "op": "guild_member_added",
        "guild_id": "5",
        "user_id": "3",
    },
    "guild_member_updated": {
        "op": "guild_member_updated",
        "guild_id": "5",
        "user_id": "3",
        "nickname": "Alex",
    },
    "guild_member_removed": {
        "op": "guild_member_removed",
        "guild_id": "5",
        "user_id": "3",
    },
    "guild_ban_added": {
        "op": "guild_ban_added",
        "guild_id": "5",
        "user_id": "3",
        "reason": "spam",
    },
    "guild_ban_removed": {
        "op": "guild_ban_removed",
        "guild_id": "5",
        "user_id": "3",
    },
    "role_created": {"op": "role_created", "role": {"id": "100"}},
    "role_updated": {"op": "role_updated", "role": {"id": "100"}},
    "role_deleted": {
        "op": "role_deleted",
        "guild_id": "5",
        "role_id": "100",
    },
    "member_roles_updated": {
        "op": "member_roles_updated",
        "guild_id": "5",
        "user_id": "3",
    },
    "permissions_updated": {
        "op": "permissions_updated",
        "allow_guild_creation": True,
        "allow_member_invites": False,
        "guild_sound_max_size_bytes": 524288,
    },
    "guild_sound_updated": {
        "op": "guild_sound_updated",
        "guild_id": "5",
        "sound_id": "join",
        "removed": False,
    },
    "guild_plugins_changed": {
        "op": "guild_plugins_changed",
        "guild_id": "5",
        "plugin_name": "tamagotchi",
        "enabled": True,
    },
    "presence_update": {
        "op": "presence_update",
        "user_id": "3",
        "online": True,
    },
    "presence_status_changed": {
        "op": "presence_status_changed",
        "data": {"user_id": "3", "status": "idle"},
    },
    "voice_disconnect": {
        "op": "voice_disconnect",
        "channel_id": "6",
        "user_id": "3",
    },
    "voice_pull": {
        "op": "voice_pull",
        "user_id": "3",
        "channel_id": "6",
        "channel_name": "General",
        "guild_id": "1",
        "pulled_by": "9",
    },
    "channel_revealed": {
        "op": "channel_revealed",
        "channel": {"id": "6", "guild_id": "1", "name": "v", "type": 1},
    },
    "channel_hidden": {
        "op": "channel_hidden",
        "guild_id": "1",
        "channel_id": "6",
    },
    "voice_override": {
        "op": "voice_override",
        "channel_id": "6",
        "user_id": "3",
        "muted": True,
        "deafened": False,
    },
    # Dropbox / Ablage — minimal sample payloads for the round-trip
    # contract. Mirrors a real publisher: every entry is a free-form
    # dict (the listener doesn't introspect it — the FE does the shape
    # validation against DropboxEntryOut).
    "dropbox_entry_created": {
        "op": "dropbox_entry_created",
        "guild_id": "1",
        "entry": {"id": "1", "name": "screenshots"},
    },
    "dropbox_entry_updated": {
        "op": "dropbox_entry_updated",
        "guild_id": "1",
        "entry": {"id": "1", "name": "screenshots"},
    },
    "dropbox_entry_deleted": {
        "op": "dropbox_entry_deleted",
        "guild_id": "1",
        "entry": {"id": "1", "name": "screenshots"},
    },
    "dropbox_entry_restored": {
        "op": "dropbox_entry_restored",
        "guild_id": "1",
        "entry": {"id": "1", "name": "screenshots"},
    },
    "dropbox_entry_purged": {
        "op": "dropbox_entry_purged",
        "guild_id": "1",
        "entry_id": "1",
        "kind": 0,
    },
    "dropbox_quota_updated": {
        "op": "dropbox_quota_updated",
        "guild_id": "1",
        "enabled": True,
        "total_quota_bytes": 5368709120,
        "per_file_max_bytes": 104857600,
        "used_bytes": 0,
        "trash_retention_days": 30,
    },
}


@pytest.mark.parametrize("op", sorted(EVENT_REGISTRY.keys()))
def test_event_round_trips(op: str) -> None:
    """validate → dump → validate must be identity for every op."""
    model_cls = EVENT_REGISTRY[op]
    payload = _PAYLOADS[op]
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(mode="json")
    # The dumped envelope must still carry the original op (no rename drift).
    assert dumped["op"] == op
    # Revive the dump → must validate cleanly.
    revived = model_cls.model_validate(dumped)
    assert revived == instance


def test_extra_fields_are_rejected() -> None:
    """``extra="forbid"`` on the base — a typo in publisher fails loudly."""
    with pytest.raises(Exception):  # pydantic.ValidationError
        ChannelBumpEvent.model_validate(
            {
                "op": "channel_bump",
                "guild_id": "5",
                "channel_id": "6",
                "message_id": "1",
                "author_id": "3",
                "typo_field": "boom",
            }
        )


def test_event_frozen() -> None:
    """Models are immutable — a mutation after construct must raise."""
    evt = PresenceUpdateEvent(user_id="3", online=True)
    with pytest.raises(Exception):  # pydantic.ValidationError on frozen
        evt.user_id = "4"  # type: ignore[misc]


def test_op_default_is_correct() -> None:
    """Constructing without passing ``op`` must default to the canonical
    discriminator — guards against an accidental rename of the Literal."""
    evt = MessageEvent(data={"id": "1"})
    assert evt.op == "message"
    assert MessageDeleteEvent(data={"id": "1", "channel_id": "2"}).op == "message_delete"


def test_voice_state_snapshot_bare() -> None:
    """Bare snapshot (no op field): listener wraps as ``voice_state``.
    Must not accept an ``op`` field — extra-forbid catches it."""
    snap = VoiceStateSnapshot(
        channel_id="6", user_ids=["3"], streaming_user_ids=[]
    )
    dumped = snap.model_dump(mode="json")
    assert dumped == {
        "channel_id": "6",
        "user_ids": ["3"],
        "streaming_user_ids": [],
        "camera_user_ids": [],
    }
    assert "op" not in dumped


def test_stream_state_snapshot_bare() -> None:
    snap = StreamStateSnapshot(channel_id="6", user_ids=["3", "4"])
    # ``streams`` defaults to [] (additive); publishers drop the empty key on the
    # wire so single-stream channels stay byte-identical to the pre-slot shape.
    assert snap.model_dump(mode="json") == {
        "channel_id": "6",
        "user_ids": ["3", "4"],
        "streams": [],
    }


def test_stream_state_snapshot_with_slots() -> None:
    # One user (3) running two streams (slots 0 + 1) plus a second user (4).
    snap = StreamStateSnapshot(
        channel_id="6",
        user_ids=["3", "4"],
        streams=[
            {"user_id": "3", "slot": 0},
            {"user_id": "3", "slot": 1},
            {"user_id": "4", "slot": 0},
        ],
    )
    assert snap.model_dump(mode="json") == {
        "channel_id": "6",
        "user_ids": ["3", "4"],
        "streams": [
            {"user_id": "3", "slot": 0},
            {"user_id": "3", "slot": 1},
            {"user_id": "4", "slot": 0},
        ],
    }


def test_watch_state_snapshot_bare() -> None:
    snap = WatchStateSnapshot(channel_id="6", party_id="20", state={"is_playing": True})
    dumped = snap.model_dump(mode="json")
    assert dumped["channel_id"] == "6"
    assert dumped["party_id"] == "20"
    assert dumped["state"] == {"is_playing": True}

    # state=None == party stopped (the wire-shape used by delete_party).
    stop = WatchStateSnapshot(channel_id="6", party_id="20", state=None)
    assert stop.model_dump(mode="json") == {"channel_id": "6", "party_id": "20", "state": None}


def test_presence_status_changed_alias() -> None:
    """``_sender_user_id`` wire-field must survive a round-trip via
    the ``sender_user_id`` python attr — alias-config check."""
    evt = PresenceStatusChangedEvent.model_validate(
        {
            "op": "presence_status_changed",
            "data": {"user_id": "3", "status": "online"},
            "_sender_user_id": "3",
        }
    )
    assert evt.sender_user_id == "3"
    dumped = evt.model_dump(mode="json")
    # Wire-format key must remain the leading-underscore one.
    assert "_sender_user_id" in dumped
    assert dumped["_sender_user_id"] == "3"
    # Re-validate from the dump.
    again = PresenceStatusChangedEvent.model_validate(dumped)
    assert again.sender_user_id == "3"


def test_presence_status_changed_no_sender() -> None:
    """The user:events variant (sender's own sockets) omits the field."""
    evt = PresenceStatusChangedEvent(
        data={"user_id": "3", "status": "invisible"}
    )
    dumped = evt.model_dump(mode="json", exclude_none=True)
    assert "_sender_user_id" not in dumped
    assert dumped["data"]["status"] == "invisible"


def test_registry_keys_match_op_defaults() -> None:
    """The op-string keying each registry entry must equal that model's
    own ``op``-Literal default — catches a registry-table typo."""
    for op, cls in EVENT_REGISTRY.items():
        # Build with placeholder ``data``/etc to read the default op.
        # Easiest: inspect the model field default.
        default = cls.model_fields["op"].default
        assert default == op, (
            f"registry key {op!r} != model default {default!r} for {cls!r}"
        )
