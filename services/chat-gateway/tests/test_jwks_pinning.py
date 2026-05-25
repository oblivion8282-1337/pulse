"""Tests for JWKS-pinning (Phase 3.1, DE 11 Defense-in-Depth).

Covers:
- Initial pin written on first pull
- Unchanged JWKS: silent (no file update)
- Graduated rotation (old kids still present in new JWKS): silent update
- Unexpected replacement (no kid overlap): WARN + flag set, pin not updated
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import logging

import pytest

from dcc_chat_gateway.jwks_pinning import (
    check_and_update_pin,
    compute_jwks_pin,
    load_pin,
    save_pin,
)


def _make_jwks(*kids: str) -> str:
    """Build a minimal JWKS JSON string with the given kid values."""
    keys = [{"kty": "RSA", "kid": kid, "n": "stub", "e": "AQAB"} for kid in kids]
    return json.dumps({"keys": keys})


# ---------------------------------------------------------------------------
# compute_jwks_pin
# ---------------------------------------------------------------------------

def test_compute_jwks_pin_deterministic():
    jwks = _make_jwks("key-1", "key-2")
    pin1 = compute_jwks_pin(jwks)
    pin2 = compute_jwks_pin(jwks)
    assert pin1 == pin2
    assert len(pin1) == 64  # SHA-256 hex


def test_compute_jwks_pin_changes_on_kid_change():
    jwks_a = _make_jwks("key-1", "key-2")
    jwks_b = _make_jwks("key-1", "key-3")
    assert compute_jwks_pin(jwks_a) != compute_jwks_pin(jwks_b)


def test_compute_jwks_pin_empty_returns_none():
    assert compute_jwks_pin(json.dumps({"keys": []})) is None


def test_compute_jwks_pin_invalid_json_returns_none():
    assert compute_jwks_pin("not-json") is None


# ---------------------------------------------------------------------------
# load_pin / save_pin
# ---------------------------------------------------------------------------

def test_load_pin_missing_file_returns_none():
    with tempfile.TemporaryDirectory() as tmpdir:
        assert load_pin(f"{tmpdir}/nonexistent.txt") is None


def test_save_and_load_pin_roundtrip():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = f"{tmpdir}/pin.txt"
        save_pin(path, "abc123")
        assert load_pin(path) == "abc123"


def test_save_pin_creates_parent_dirs():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = f"{tmpdir}/nested/deep/pin.txt"
        save_pin(path, "xyz")
        assert Path(path).read_text() == "xyz"


# ---------------------------------------------------------------------------
# check_and_update_pin — lifecycle scenarios
# ---------------------------------------------------------------------------

def _fresh_state():
    return SimpleNamespace(jwks_changed_unexpectedly=False)


def test_initial_pin_written_on_first_pull():
    """First pull: no pin file → write pin, no warning."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pin_path = f"{tmpdir}/pin.txt"
        state = _fresh_state()
        jwks = _make_jwks("key-1")

        check_and_update_pin(jwks, pin_path, state)

        pin = load_pin(pin_path)
        assert pin == compute_jwks_pin(jwks)
        assert state.jwks_changed_unexpectedly is False


def test_unchanged_jwks_silent():
    """Second pull with same JWKS: pin file unchanged, no flag set."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pin_path = f"{tmpdir}/pin.txt"
        state = _fresh_state()
        jwks = _make_jwks("key-1", "key-2")

        # Establish initial pin
        check_and_update_pin(jwks, pin_path, state)
        pin_after_first = load_pin(pin_path)
        mtime_after_first = Path(pin_path).stat().st_mtime

        # Second pull — identical JWKS
        check_and_update_pin(jwks, pin_path, state)
        pin_after_second = load_pin(pin_path)

        assert pin_after_first == pin_after_second
        assert state.jwks_changed_unexpectedly is False


def test_graduated_rotation_silent_update():
    """Graduated rotation: new JWKS has old kids + new kid → silent pin update."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pin_path = f"{tmpdir}/pin.txt"
        kids_path = pin_path + ".kids"
        state = _fresh_state()

        jwks_old = _make_jwks("key-1")
        jwks_new = _make_jwks("key-1", "key-2")  # key-1 still present

        # Write initial pin + kids file manually to simulate previous pull
        check_and_update_pin(jwks_old, pin_path, state)
        # Seed the kids file (would be written on first rotation in production)
        Path(kids_path).write_text("key-1")

        check_and_update_pin(jwks_new, pin_path, state)

        new_pin = load_pin(pin_path)
        assert new_pin == compute_jwks_pin(jwks_new)
        assert state.jwks_changed_unexpectedly is False


def test_unexpected_replacement_warns_and_sets_flag(caplog):
    """Full kid replacement: WARN log, flag set, pin NOT updated."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pin_path = f"{tmpdir}/pin.txt"
        kids_path = pin_path + ".kids"
        state = _fresh_state()

        jwks_old = _make_jwks("key-1")
        jwks_new = _make_jwks("key-9")  # completely different kid

        # Establish initial pin + kids
        check_and_update_pin(jwks_old, pin_path, state)
        Path(kids_path).write_text("key-1")
        original_pin = load_pin(pin_path)

        with caplog.at_level(logging.WARNING):
            check_and_update_pin(jwks_new, pin_path, state)

        # Pin must NOT have changed
        assert load_pin(pin_path) == original_pin

        # Flag must be set
        assert state.jwks_changed_unexpectedly is True

        # Warning must appear in logs
        assert any("unexpectedly" in r.message for r in caplog.records)
