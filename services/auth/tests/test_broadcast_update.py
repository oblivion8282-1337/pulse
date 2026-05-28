"""Tests für POST /admin/instances/_broadcast-update.

HTTP-Aufrufe an externe Instanzen werden via unittest.mock.patch + AsyncMock
gemockt — kein externes Netzwerk, keine respx-Dependency erforderlich.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.snowflake import next_id


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _seed_admin(session_factory) -> tuple[User, str]:
    from dcc_auth.security import get_signer

    uid = next_id()
    async with session_factory() as s:
        u = User(
            id=uid,
            username=f"admin{uid}",
            email=f"admin{uid}@dcc-test.example.com",
            password_hash="x",
            pairwise_salt=b"\x00" * 32,
            is_admin=True,
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
    token = get_signer().issue_access(uid, u.username, is_admin=True)
    return u, token


async def _seed_instance(session_factory, admin_id: int, *, hostname: str) -> int:
    iid = next_id()
    async with session_factory() as s:
        inst = RegisteredInstance(
            id=iid,
            hostname=hostname,
            client_id=f"cid-{iid}",
            client_secret="hash",
            worker_id_chat=iid % 900 + 10,
            worker_id_voice=iid % 900 + 11,
            worker_id_media=iid % 900 + 12,
            status="active",
            registered_by=admin_id,
        )
        s.add(inst)
        await s.commit()
    return iid


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestBroadcastUpdateAuth:
    async def test_missing_secret_returns_401(self, client, _isolate_settings):
        """No Authorization header → 401."""
        # Ensure internal_service_secret is set so we get to the header check
        _isolate_settings.internal_service_secret = "test-internal-secret"
        r = await client.post("/admin/instances/_broadcast-update")
        assert r.status_code == 401

    async def test_wrong_secret_returns_401(self, client, _isolate_settings):
        _isolate_settings.internal_service_secret = "test-internal-secret"
        r = await client.post(
            "/admin/instances/_broadcast-update",
            headers={"Authorization": "Bearer wrong-secret"},
        )
        assert r.status_code == 401

    async def test_no_configured_secret_returns_503(self, client, _isolate_settings):
        """INTERNAL_SERVICE_SECRET not set → 503."""
        _isolate_settings.internal_service_secret = None
        r = await client.post(
            "/admin/instances/_broadcast-update",
            headers={"Authorization": "Bearer anything"},
        )
        assert r.status_code == 503

    async def test_correct_secret_passes_auth(self, client, _isolate_settings):
        """Valid secret with no active instances → 200 with empty lists."""
        _isolate_settings.internal_service_secret = "test-internal-secret"
        r = await client.post(
            "/admin/instances/_broadcast-update",
            headers={"Authorization": "Bearer test-internal-secret"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] == []
        assert data["failed"] == []


class TestBroadcastUpdateDispatch:
    async def test_successful_notify(self, client, session_factory, _isolate_settings):
        """Mock HTTP response 200 → hostname appears in ok list."""
        _isolate_settings.internal_service_secret = "test-internal-secret"
        admin, _ = await _seed_admin(session_factory)
        await _seed_instance(session_factory, admin.id, hostname="good.example.com")

        mock_response = MagicMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("dcc_auth.routes_suspended_instances.httpx.AsyncClient", return_value=mock_client):
            r = await client.post(
                "/admin/instances/_broadcast-update",
                headers={"Authorization": "Bearer test-internal-secret"},
            )

        assert r.status_code == 200
        data = r.json()
        assert "good.example.com" in data["ok"]
        assert data["failed"] == []

    async def test_failed_notify_appears_in_failed_list(
        self, client, session_factory, _isolate_settings
    ):
        """Mock HTTP 500 → hostname appears in failed list."""
        _isolate_settings.internal_service_secret = "test-internal-secret"
        admin, _ = await _seed_admin(session_factory)
        await _seed_instance(session_factory, admin.id, hostname="bad.example.com")

        mock_response = MagicMock()
        mock_response.status_code = 500

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("dcc_auth.routes_suspended_instances.httpx.AsyncClient", return_value=mock_client):
            r = await client.post(
                "/admin/instances/_broadcast-update",
                headers={"Authorization": "Bearer test-internal-secret"},
            )

        assert r.status_code == 200
        data = r.json()
        assert data["ok"] == []
        assert len(data["failed"]) == 1
        assert data["failed"][0]["hostname"] == "bad.example.com"

    async def test_network_error_appears_in_failed_list(
        self, client, session_factory, _isolate_settings
    ):
        """Connection refused → appears in failed list with reason string."""
        _isolate_settings.internal_service_secret = "test-internal-secret"
        admin, _ = await _seed_admin(session_factory)
        await _seed_instance(session_factory, admin.id, hostname="unreachable.example.com")

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(side_effect=ConnectionRefusedError("connection refused"))

        with patch("dcc_auth.routes_suspended_instances.httpx.AsyncClient", return_value=mock_client):
            r = await client.post(
                "/admin/instances/_broadcast-update",
                headers={"Authorization": "Bearer test-internal-secret"},
            )

        assert r.status_code == 200
        data = r.json()
        assert data["ok"] == []
        failed = data["failed"]
        assert len(failed) == 1
        assert failed[0]["hostname"] == "unreachable.example.com"
        assert "reason" in failed[0]

    async def test_jwt_sent_in_bearer_header(
        self, client, session_factory, _isolate_settings
    ):
        """Verify that a JWT Bearer token is sent to the instance endpoint."""
        _isolate_settings.internal_service_secret = "test-internal-secret"
        admin, _ = await _seed_admin(session_factory)
        await _seed_instance(session_factory, admin.id, hostname="jwt-check.example.com")

        captured_headers: dict = {}
        mock_response = MagicMock()
        mock_response.status_code = 200

        async def _capture_post(url, *, headers, **kw):
            captured_headers.update(headers)
            return mock_response

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = _capture_post

        with patch("dcc_auth.routes_suspended_instances.httpx.AsyncClient", return_value=mock_client):
            r = await client.post(
                "/admin/instances/_broadcast-update",
                headers={"Authorization": "Bearer test-internal-secret"},
            )

        assert r.status_code == 200
        assert "Authorization" in captured_headers
        auth_hdr = captured_headers["Authorization"]
        assert auth_hdr.startswith("Bearer ")
        # JWT has 3 dot-separated parts
        tok = auth_hdr.split(" ", 1)[1]
        assert tok.count(".") == 2
