"""F14 — voice-signaling must accept Self-Host EdDSA session tokens.

On a self-host instance a user logs in via Cert-Login and chat-gateway mints a
local EdDSA *session token* (no ``kid`` header). voice-signaling used to only
implement the Cloud RS256/JWKS path, so ``POST /token`` 401'd with "missing
kid" → voice unusable. ``decode_token`` now mirrors chat-gateway: a kid-less
token is validated as a session-JWT *in self-host mode only*; in cloud mode it
still 401s with "missing kid".
"""

from __future__ import annotations

import dcc_voice_signaling.config as voice_cfg
import dcc_voice_signaling.security as voice_security
import pytest
from dcc_shared.session_tokens import (
    issue_session_token,
    reset_session_signer,
)
from fastapi import HTTPException


def _settings(mode: str, key_path: str) -> voice_cfg.Settings:
    return voice_cfg.Settings(
        livekit_api_key="testkey",
        livekit_api_secret="testsecrettestsecrettestsecrettestsecret",
        livekit_url="ws://livekit.test:7880",
        pulse_instance_mode=mode,
        session_signing_key_file=key_path,
    )


@pytest.fixture
def _tmp_key(tmp_path):
    reset_session_signer()
    yield str(tmp_path / "session_signing.pem")
    reset_session_signer()


def _patch_settings(monkeypatch, settings: voice_cfg.Settings) -> None:
    monkeypatch.setattr(voice_security, "get_settings", lambda: settings)


@pytest.mark.asyncio
async def test_self_host_session_token_accepted(monkeypatch, _tmp_key):
    """A valid EdDSA session token decodes to the synthetic-id payload."""
    _patch_settings(monkeypatch, _settings("self-host", _tmp_key))
    token = issue_session_token(
        "4711", "cert-voice-1", key_path=_tmp_key, admin=True
    )

    payload = await voice_security.decode_token(token)

    assert payload["sub"] == "4711"
    assert payload["pairwise_sub"] == "4711"
    assert payload["typ"] == "access"
    assert payload["admin"] is True
    assert payload["self_host"] is True
    assert payload["cert_id"] == "cert-voice-1"


@pytest.mark.asyncio
async def test_self_host_session_token_via_get_current_user(monkeypatch, _tmp_key):
    """get_current_user resolves the synthetic int user-id from the session."""
    _patch_settings(monkeypatch, _settings("self-host", _tmp_key))
    token = issue_session_token("4711", "cert-2", key_path=_tmp_key)

    user = await voice_security.get_current_user(authorization=f"Bearer {token}")

    assert user.id == 4711


@pytest.mark.asyncio
async def test_session_token_rejected_in_cloud_mode(monkeypatch, _tmp_key):
    """The very same kid-less token is rejected with 'missing kid' in cloud mode."""
    token = issue_session_token("4711", "cert-3", key_path=_tmp_key)
    _patch_settings(monkeypatch, _settings("cloud", _tmp_key))

    with pytest.raises(HTTPException) as exc:
        await voice_security.decode_token(token)
    assert exc.value.status_code == 401
    assert exc.value.detail == "missing kid"


@pytest.mark.asyncio
async def test_tampered_session_token_rejected(monkeypatch, _tmp_key):
    """A tampered (signature-broken) session token → 401 invalid token."""
    _patch_settings(monkeypatch, _settings("self-host", _tmp_key))
    token = issue_session_token("4711", "cert-4", key_path=_tmp_key)
    header, body, sig = token.split(".")
    tampered = f"{header}.{body[:-4] + 'XXXX'}.{sig}"

    with pytest.raises(HTTPException) as exc:
        await voice_security.decode_token(tampered)
    assert exc.value.status_code == 401
    assert exc.value.detail == "invalid token"
