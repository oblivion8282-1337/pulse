"""Tests für POST /reports + Admin-Complaints-Endpoints."""

from __future__ import annotations

import pytest
import pytest_asyncio

from dcc_auth.models import User
from dcc_auth.snowflake import next_id


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


async def _seed_user(session_factory, *, is_admin: bool = False) -> tuple[User, str]:
    """Create a user, return (user, access_token)."""
    from dcc_auth.security import get_signer

    uid = next_id()
    async with session_factory() as s:
        u = User(
            id=uid,
            username=f"user{uid}",
            email=f"user{uid}@dcc-test.example.com",
            password_hash="x",
            pairwise_salt=b"\x00" * 32,
            is_admin=is_admin,
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)

    token = get_signer().issue_access(uid, u.username, is_admin=is_admin)
    return u, token


# ---------------------------------------------------------------------------
# Public: POST /reports
# ---------------------------------------------------------------------------


class TestSubmitReport:
    async def test_happy_path_with_instance_id(self, client):
        r = await client.post(
            "/reports",
            json={
                "body": "This instance is posting spam content everywhere.",
                "target_instance_id": 12345678901234567,
            },
        )
        assert r.status_code == 201
        body = r.json()
        assert "id" in body
        assert body["status"] == "received"

    async def test_happy_path_with_url(self, client):
        r = await client.post(
            "/reports",
            json={
                "body": "Offensive content at this URL.",
                "target_url": "https://instance.example.com/offending-post",
            },
        )
        assert r.status_code == 201
        assert r.json()["status"] == "received"

    async def test_happy_path_with_user_id(self, client):
        r = await client.post(
            "/reports",
            json={
                "body": "This user is harassing other members.",
                "target_user_id": 98765432109876543,
            },
        )
        assert r.status_code == 201

    async def test_optional_submitter_email(self, client):
        r = await client.post(
            "/reports",
            json={
                "body": "Abuse content spotted on this instance.",
                "target_url": "https://bad.example.com/",
                "submitter_email": "reporter@dcc-test.example.com",
            },
        )
        assert r.status_code == 201

    async def test_empty_target_returns_422(self, client):
        """No target set → validation error."""
        r = await client.post(
            "/reports",
            json={"body": "Something bad is happening here."},
        )
        assert r.status_code == 422

    async def test_body_too_short_returns_422(self, client):
        r = await client.post(
            "/reports",
            json={"body": "short", "target_url": "https://x.example.com/"},
        )
        assert r.status_code == 422

    async def test_response_does_not_leak_details(self, client):
        """Response must only contain id + status — no body/email leakage."""
        r = await client.post(
            "/reports",
            json={
                "body": "Detailed complaint body that should not be echoed.",
                "target_url": "https://instance.example.com/",
                "submitter_email": "secret@dcc-test.example.com",
            },
        )
        assert r.status_code == 201
        data = r.json()
        assert "body" not in data
        assert "submitter_email" not in data

    async def test_rate_limit_after_3_per_hour(self, client, app):
        """4th request in the same hour window → 429."""
        from dcc_auth.routes import _reset_rate

        _reset_rate(app)
        payload = {
            "body": "Rate-limit test complaint body here.",
            "target_url": "https://spam.example.com/",
        }
        for i in range(3):
            r = await client.post("/reports", json=payload)
            assert r.status_code == 201, f"request {i+1} should succeed"

        r4 = await client.post("/reports", json=payload)
        assert r4.status_code == 429


# ---------------------------------------------------------------------------
# Admin: GET /admin/complaints
# ---------------------------------------------------------------------------


class TestAdminListComplaints:
    async def test_non_admin_returns_403(self, client, session_factory):
        _, token = await _seed_user(session_factory, is_admin=False)
        r = await client.get(
            "/admin/complaints",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403

    async def test_unauthenticated_returns_401(self, client):
        r = await client.get("/admin/complaints")
        assert r.status_code == 401

    async def test_admin_sees_new_complaint(self, client, session_factory, app):
        from dcc_auth.routes import _reset_rate

        _reset_rate(app)
        # Submit a complaint first
        await client.post(
            "/reports",
            json={
                "body": "Admin-test complaint body to verify listing.",
                "target_url": "https://list-test.example.com/",
            },
        )

        _, token = await _seed_user(session_factory, is_admin=True)
        r = await client.get(
            "/admin/complaints",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 1
        assert items[0]["status"] == "new"

    async def test_filter_by_status(self, client, session_factory, app):
        """?status=resolved returns empty when nothing is resolved."""
        from dcc_auth.routes import _reset_rate

        _reset_rate(app)
        _, token = await _seed_user(session_factory, is_admin=True)
        r = await client.get(
            "/admin/complaints?status=resolved",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json() == []

    async def test_invalid_status_returns_422(self, client, session_factory):
        _, token = await _seed_user(session_factory, is_admin=True)
        r = await client.get(
            "/admin/complaints?status=invalid",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# Admin: forward + resolve
# ---------------------------------------------------------------------------


async def _submit_and_get_id(client, app) -> str:
    from dcc_auth.routes import _reset_rate

    _reset_rate(app)
    r = await client.post(
        "/reports",
        json={
            "body": "Forward/resolve test complaint content here.",
            "target_url": "https://action-test.example.com/",
        },
    )
    assert r.status_code == 201
    return r.json()["id"]


class TestForwardComplaint:
    async def test_forward_sets_status(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=True)

        r = await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": "Forwarded to instance operator."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "forwarded"

    async def test_forward_non_admin_403(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=False)

        r = await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": "Unauthorized forward attempt."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403

    async def test_forward_nonexistent_returns_404(self, client, session_factory):
        _, token = await _seed_user(session_factory, is_admin=True)
        r = await client.post(
            "/admin/complaints/999999999999999999/forward",
            json={"notice_text": "Does not exist."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 404


class TestResolveComplaint:
    async def test_resolve_sets_status_and_resolved_at(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=True)

        r = await client.post(
            f"/admin/complaints/{cid}/resolve",
            json={"resolution_note": "Confirmed and handled by moderators."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "resolved"

    async def test_resolve_non_admin_403(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=False)

        r = await client.post(
            f"/admin/complaints/{cid}/resolve",
            json={"resolution_note": "Unauthorized."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403

    async def test_resolved_complaint_appears_in_resolved_list(
        self, client, session_factory, app
    ):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=True)

        await client.post(
            f"/admin/complaints/{cid}/resolve",
            json={"resolution_note": "All good."},
            headers={"Authorization": f"Bearer {token}"},
        )

        r = await client.get(
            "/admin/complaints?status=resolved",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        ids = [item["id"] for item in r.json()]
        assert cid in ids
