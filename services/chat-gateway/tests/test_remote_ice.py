"""Fernsteuerung — TURN-Credential-Erzeugung (M3)."""

from __future__ import annotations

import base64
import hashlib
import hmac

from dcc_chat_gateway.routes.remote_ice import _credential_for, ephemeral_turn_credential


def test_credential_format_and_hmac() -> None:
    secret = "s3cr3t"
    username, credential = _credential_for(secret, "12345", expiry=1_800_000_000)
    # username = "<ablauf>:<user_id>"
    assert username == "1800000000:12345"
    # credential = base64(HMAC-SHA1(secret, username)) — deterministisch nachrechnen.
    expected = base64.b64encode(
        hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    ).decode()
    assert credential == expected


def test_credential_is_deterministic_for_same_inputs() -> None:
    a = _credential_for("k", "u", 42)
    b = _credential_for("k", "u", 42)
    assert a == b


def test_credential_changes_with_user_and_expiry() -> None:
    base = _credential_for("k", "u", 100)
    assert _credential_for("k", "u2", 100) != base  # anderer User
    assert _credential_for("k", "u", 200) != base  # anderer Ablauf
    assert _credential_for("k2", "u", 100) != base  # anderes Secret


def test_ephemeral_uses_ttl_from_now(monkeypatch) -> None:
    # `ephemeral_turn_credential` liest die Uhr — Ablauf = now + ttl.
    monkeypatch.setattr("dcc_chat_gateway.routes.remote_ice.time.time", lambda: 1000.0)
    username, _ = ephemeral_turn_credential("k", "u", ttl_s=300)
    assert username == "1300:u"
