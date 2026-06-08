"""media-svc must accept Self-Host EdDSA session tokens.

On a self-host instance chat-gateway forwards the user's EdDSA *session token*
(no ``kid`` header) to media-svc on ``POST /channels/{id}/stream-token``.
media-svc used to only implement the Cloud RS256/JWKS path, so HQ-streaming
401'd ("missing kid") on self-host. ``decode_token`` now mirrors chat-gateway /
voice-signaling: a kid-less token is validated as a session-JWT *in self-host
mode only*; in cloud mode it still 401s with "missing kid".
"""

from __future__ import annotations

import dcc_media_svc.config as media_cfg
import dcc_media_svc.security as media_security
import pytest
from dcc_shared.session_tokens import (
    issue_session_token,
    reset_session_signer,
    synthesize_self_host_user_id,
)
from fastapi import HTTPException


def _settings(mode: str, key_path: str) -> media_cfg.Settings:
    return media_cfg.Settings(
        pulse_instance_mode=mode,
        session_signing_key_file=key_path,
    )


@pytest.fixture
def _tmp_key(tmp_path):
    reset_session_signer()
    yield str(tmp_path / "session_signing.pem")
    reset_session_signer()


def _patch_settings(monkeypatch, settings: media_cfg.Settings) -> None:
    monkeypatch.setattr(media_security, "get_settings", lambda: settings)


@pytest.mark.asyncio
async def test_self_host_session_token_accepted(monkeypatch, _tmp_key):
    """A valid EdDSA session token decodes to the synthetic-id payload — so the
    forwarded bearer mints a stream-token instead of 401'ing HQ-streaming."""
    _patch_settings(monkeypatch, _settings("self-host", _tmp_key))
    token = issue_session_token(
        "pairwise-sub-media", "cert-media-1", key_path=_tmp_key, admin=False
    )

    payload = await media_security.decode_token(token)

    assert payload["sub"] == str(synthesize_self_host_user_id("pairwise-sub-media"))
    assert payload["pairwise_sub"] == "pairwise-sub-media"
    assert payload["typ"] == "access"
    assert payload["self_host"] is True
    assert payload["cert_id"] == "cert-media-1"


@pytest.mark.asyncio
async def test_kidless_token_rejected_in_cloud_mode(monkeypatch, _tmp_key):
    """In cloud mode a kid-less token keeps the historical "missing kid" 401 —
    no self-host fallback for an attacker to probe."""
    _patch_settings(monkeypatch, _settings("cloud", _tmp_key))
    token = issue_session_token(
        "pairwise-sub-media", "cert-media-2", key_path=_tmp_key, admin=False
    )

    with pytest.raises(HTTPException) as exc:
        await media_security.decode_token(token)
    assert exc.value.status_code == 401
