"""Tests for GET /.well-known/pulse-server-info (Phase 3.3).

Coverage:
1. Default (self-host mode, instance_id=0): instance_id=null (0 ≙ unregistered).
2. self-host mode with real instance_id: instance_id as string.
3. cloud mode: instance_id=null regardless of instance_id setting.
4. Response carries server_version and pulse_oidc_issuer.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from dcc_chat_gateway import __version__


def _make_settings(**kwargs) -> MagicMock:
    """Return a Settings-alike mock with the given fields."""
    s = MagicMock()
    s.pulse_instance_mode = kwargs.get("pulse_instance_mode", "self-host")
    s.pulse_instance_id = kwargs.get("pulse_instance_id", 0)
    s.pulse_oidc_issuer = kwargs.get("pulse_oidc_issuer", "https://howispulse.com")
    return s


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_server_info_self_host_no_instance_id(client, _isolate_chat_settings):
    """Self-host mode, pulse_instance_id=0 → instance_id is null."""
    mock_settings = _make_settings(pulse_instance_mode="self-host", pulse_instance_id=0)
    with patch("dcc_chat_gateway.routes.server_info.get_settings", return_value=mock_settings):
        resp = await client.get("/.well-known/pulse-server-info")

    assert resp.status_code == 200
    data = resp.json()
    assert data["instance_id"] is None


@pytest.mark.asyncio
async def test_server_info_self_host_with_instance_id(client, _isolate_chat_settings):
    """Self-host mode with a real Snowflake-ID → instance_id as string."""
    mock_settings = _make_settings(pulse_instance_mode="self-host", pulse_instance_id=123456789)
    with patch("dcc_chat_gateway.routes.server_info.get_settings", return_value=mock_settings):
        resp = await client.get("/.well-known/pulse-server-info")

    assert resp.status_code == 200
    data = resp.json()
    assert data["instance_id"] == "123456789"


@pytest.mark.asyncio
async def test_server_info_cloud_mode(client, _isolate_chat_settings):
    """Cloud mode → instance_id always null."""
    mock_settings = _make_settings(pulse_instance_mode="cloud", pulse_instance_id=999)
    with patch("dcc_chat_gateway.routes.server_info.get_settings", return_value=mock_settings):
        resp = await client.get("/.well-known/pulse-server-info")

    assert resp.status_code == 200
    data = resp.json()
    assert data["instance_id"] is None


@pytest.mark.asyncio
async def test_server_info_version_and_issuer(client, _isolate_chat_settings):
    """server_version and pulse_oidc_issuer are present."""
    resp = await client.get("/.well-known/pulse-server-info")
    assert resp.status_code == 200
    data = resp.json()
    assert data["server_version"] == __version__
    assert "howispulse.com" in data["pulse_oidc_issuer"]
    assert data["capabilities"] == []
