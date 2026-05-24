"""Tests for the listener-side strict-validation helper
(Plugin-System Schritt 1b).

Covers the three validation modes (strict / warn / off), the unknown-op
fallback, the plugin-op bypass and the bare-snapshot escape hatch
(callers don't invoke ``validate_event`` for op-less payloads).

The helpers ``validate_event`` + ``maybe_drop`` are pure functions that
read ``PULSE_EVENT_VALIDATION`` from the environment, so each test sets
+ tears down the env-var via ``monkeypatch``. No Redis / no DB needed
for any of these.
"""

from __future__ import annotations

import logging

import pytest

from dcc_chat_gateway.pubsub_event_validation import (
    maybe_drop,
    resolve_validation_mode,
    validate_event,
)


# ---- resolve_validation_mode ----------------------------------------------


def test_default_mode_is_strict(monkeypatch):
    monkeypatch.delenv("PULSE_EVENT_VALIDATION", raising=False)
    assert resolve_validation_mode() == "strict"


@pytest.mark.parametrize("raw,expected", [
    ("strict", "strict"),
    ("warn", "warn"),
    ("off", "off"),
    ("STRICT", "strict"),
    ("  Warn  ", "warn"),  # whitespace + case-folded
])
def test_known_modes_are_normalised(monkeypatch, raw, expected):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", raw)
    assert resolve_validation_mode() == expected


def test_unknown_mode_falls_back_to_strict(monkeypatch):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "yolo")
    assert resolve_validation_mode() == "strict"


# ---- validate_event: valid + invalid + off ---------------------------------


def test_valid_event_passes_strict(monkeypatch):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    # GuildBanAddedEvent shape: {op, guild_id, user_id, reason?}
    payload = {
        "op": "guild_ban_added",
        "guild_id": "123",
        "user_id": "456",
        "reason": None,
    }
    ok, err = validate_event("guild_ban_added", payload)
    assert ok is True
    assert err is None


def test_invalid_event_fails_strict(monkeypatch):
    """Missing required field — strict + warn flag it as invalid."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    # GuildBanAddedEvent needs ``guild_id`` + ``user_id``.
    payload = {"op": "guild_ban_added", "guild_id": "123"}
    ok, err = validate_event("guild_ban_added", payload)
    assert ok is False
    assert err is not None
    assert "user_id" in err


def test_off_mode_skips_validation_entirely(monkeypatch):
    """Even a wildly-malformed payload passes when validation is off."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "off")
    payload = {"op": "guild_ban_added", "this_field": "is_not_allowed"}
    ok, err = validate_event("guild_ban_added", payload)
    assert ok is True
    assert err is None


def test_warn_mode_still_validates_and_returns_invalid(monkeypatch):
    """warn-mode produces the same ``(False, err)`` signal as strict —
    it's the caller (``maybe_drop``) that converts it into a different
    side effect (log vs. drop)."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "warn")
    payload = {"op": "guild_ban_added"}
    ok, err = validate_event("guild_ban_added", payload)
    assert ok is False
    assert err is not None


# ---- Plugin-op bypass ------------------------------------------------------


def test_plugin_op_bypasses_validation_strict(monkeypatch):
    """Namespaced ops (containing ``:``) skip core validation — plugins
    register their own ops + emit events the core registry doesn't know."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    payload = {"op": "tamagotchi:ack", "fed_at": 1234567890}
    ok, err = validate_event("tamagotchi:ack", payload)
    assert ok is True
    assert err is None


def test_plugin_op_bypass_with_completely_unknown_op(monkeypatch):
    """Even an op no one ever registered passes if it's namespaced."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    payload = {"op": "totally:made-up", "anything": "goes"}
    ok, err = validate_event("totally:made-up", payload)
    assert ok is True
    assert err is None


# ---- Unknown-op fallback ---------------------------------------------------


def test_unknown_non_plugin_op_accepts_but_flags(monkeypatch):
    """An op that's not in ``EVENT_REGISTRY`` and not namespaced is
    treated as registry drift (most likely a publisher emitting a new
    op the listener wasn't redeployed for). Accepted, but with a note."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    ok, err = validate_event("some_new_op", {"op": "some_new_op"})
    assert ok is True
    assert err is not None
    assert "unknown op" in err.lower()


# ---- maybe_drop: integration with caller -----------------------------------


def test_maybe_drop_valid_event_returns_false(monkeypatch):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    payload = {
        "op": "guild_ban_added",
        "guild_id": "1",
        "user_id": "2",
        "reason": None,
    }
    assert maybe_drop("guild_ban_added", payload, "guild:events") is False


def test_maybe_drop_strict_invalid_returns_true_and_logs(monkeypatch, caplog):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    with caplog.at_level(logging.ERROR, logger="dcc_chat_gateway.pubsub_event_validation"):
        dropped = maybe_drop(
            "guild_ban_added",
            {"op": "guild_ban_added"},  # missing required
            "guild:events",
        )
    assert dropped is True
    # Look for the explicit drop log line.
    error_records = [
        r for r in caplog.records if r.levelno == logging.ERROR
    ]
    assert error_records, "expected an ERROR log on dropped invalid event"
    assert "dropping" in error_records[0].getMessage()
    assert "guild_ban_added" in error_records[0].getMessage()


def test_maybe_drop_warn_invalid_returns_false_and_logs(monkeypatch, caplog):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "warn")
    with caplog.at_level(logging.WARNING, logger="dcc_chat_gateway.pubsub_event_validation"):
        dropped = maybe_drop(
            "guild_ban_added",
            {"op": "guild_ban_added"},
            "guild:events",
        )
    assert dropped is False
    # warn-mode logs WARNING (not ERROR) on the kept-but-invalid event.
    warn_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "proceeding anyway" in r.getMessage()
    ]
    assert warn_records, "expected a WARNING log when warn-mode kept an invalid event"


def test_maybe_drop_off_mode_returns_false_and_no_log(monkeypatch, caplog):
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "off")
    with caplog.at_level(logging.WARNING, logger="dcc_chat_gateway.pubsub_event_validation"):
        dropped = maybe_drop(
            "guild_ban_added",
            {"op": "guild_ban_added", "totally": "broken"},
            "guild:events",
        )
    assert dropped is False
    # Off-mode short-circuits — nothing to log.
    assert not caplog.records, (
        f"off-mode should be silent; got: {[r.getMessage() for r in caplog.records]}"
    )


def test_maybe_drop_plugin_op_returns_false_no_log(monkeypatch, caplog):
    """Plugin ops are always allowed through; no log noise."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    with caplog.at_level(logging.WARNING, logger="dcc_chat_gateway.pubsub_event_validation"):
        dropped = maybe_drop(
            "tamagotchi:ack",
            {"op": "tamagotchi:ack", "x": 1},
            "user:events",
        )
    assert dropped is False
    assert not caplog.records


def test_maybe_drop_unknown_op_returns_false_with_warning(monkeypatch, caplog):
    """Unknown non-plugin op = registry drift. Kept, but flagged as
    WARNING so deployment skew is visible."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    with caplog.at_level(logging.WARNING, logger="dcc_chat_gateway.pubsub_event_validation"):
        dropped = maybe_drop(
            "freshly_added_op",
            {"op": "freshly_added_op"},
            "guild:events",
        )
    assert dropped is False
    warn_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "unknown op" in r.getMessage().lower()
    ]
    assert warn_records, "expected a WARNING log on unknown op acceptance"


# ---- Real-world envelope shapes (sanity round-trip) ------------------------


def test_voice_disconnect_round_trip(monkeypatch):
    """The exact payload voice-signaling publishes for the
    ``voice_disconnect`` admin-action — make sure the listener's strict
    validation greenlit it."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    payload = {
        "op": "voice_disconnect",
        "channel_id": "987654",
        "user_id": "1234",
    }
    ok, err = validate_event("voice_disconnect", payload)
    assert ok is True, f"voice_disconnect must validate cleanly, got: {err}"


def test_presence_status_changed_with_sender_id_alias(monkeypatch):
    """``PresenceStatusChangedEvent`` exposes ``_sender_user_id`` as an
    alias — the wire format keeps the underscore-prefixed name, which the
    model accepts via ``populate_by_name + Field(alias=...)``."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    payload = {
        "op": "presence_status_changed",
        "data": {"user_id": "42", "status": "idle"},
        "_sender_user_id": "42",
    }
    ok, err = validate_event("presence_status_changed", payload)
    assert ok is True, f"presence_status_changed must accept _sender_user_id, got: {err}"


def test_invalid_event_drops_in_strict_via_maybe_drop_with_real_op(monkeypatch, caplog):
    """End-to-end: an invalid ``role_created`` envelope in strict mode
    returns ``True`` (drop) — same path the listener uses."""
    monkeypatch.setenv("PULSE_EVENT_VALIDATION", "strict")
    payload = {"op": "role_created"}  # missing ``role`` body
    with caplog.at_level(logging.ERROR, logger="dcc_chat_gateway.pubsub_event_validation"):
        assert maybe_drop("role_created", payload, "guild:events") is True
    assert any("role_created" in r.getMessage() for r in caplog.records)
