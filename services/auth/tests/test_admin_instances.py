"""Tests for Phase 2.3 Admin-Instance-Management endpoints.

Pattern mirrors test_admin.py: register users via HTTP, promote via SQLAlchemy,
login to get fresh tokens, then exercise the endpoints.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import InstanceApplication, RegisteredInstance, SuspendedInstance
from dcc_auth.security import verify_password


# --------------------------------------------------------------------------- #
# Helpers                                                                       #
# --------------------------------------------------------------------------- #


async def _register(client, *, username: str, email: str) -> str:
    r = await client.post(
        "/register",
        json={"username": username, "email": email, "password": "correct horse battery staple"},
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


async def _promote(session_factory, username: str) -> None:
    async with session_factory() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one()
        user.is_admin = True
        await s.commit()


async def _login(client, *, username: str) -> str:
    r = await client.post(
        "/login",
        json={"email_or_username": username, "password": "correct horse battery staple"},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def _seed_application(session_factory, *, user_id: int, hostname: str) -> int:
    """Insert a pending InstanceApplication and return its id."""
    from dcc_auth.snowflake import next_id

    app_id = next_id()
    async with session_factory() as s:
        s.add(
            InstanceApplication(
                id=app_id,
                applicant_user_id=user_id,
                hostname=hostname,
                purpose="privat",
                expected_users=5,
                contact_email="op@dcc-test.example.com",
                notes=None,
            )
        )
        await s.commit()
    return app_id


async def _get_user_id(session_factory, username: str) -> int:
    async with session_factory() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one()
        return user.id


# --------------------------------------------------------------------------- #
# Fixtures                                                                      #
# --------------------------------------------------------------------------- #


@pytest.fixture
async def admin_token(client, session_factory):
    await _register(client, username="alice", email="alice@dcc-test.example.com")
    await _promote(session_factory, "alice")
    return await _login(client, username="alice")


@pytest.fixture
async def regular_token(client):
    # Burn the bootstrap-admin slot first
    await _register(client, username="bootstrap", email="bootstrap@dcc-test.example.com")
    return await _register(client, username="bob", email="bob@dcc-test.example.com")


@pytest.fixture
async def applicant_user_id(client, session_factory):
    """Register a throwaway user and return their id (for seeding applications)."""
    # bootstrap slot already consumed by now if admin_token fixture ran first;
    # we seed directly so we don't need to worry about order.
    await _register(client, username="operator", email="operator@dcc-test.example.com")
    return await _get_user_id(session_factory, "operator")


# --------------------------------------------------------------------------- #
# 1. Auth gate — all endpoints must 403 for non-admins                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_list_applications_403(client, regular_token):
    r = await client.get(
        "/admin/instance-applications",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_approve_403(client, regular_token):
    r = await client.post(
        "/admin/instance-applications/1/approve",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_reject_403(client, regular_token):
    r = await client.post(
        "/admin/instance-applications/1/reject",
        json={"rejection_reason": "nope"},
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_list_instances_403(client, regular_token):
    r = await client.get(
        "/admin/instances",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# 2. List applications                                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_list_applications_empty(client, admin_token):
    r = await client.get(
        "/admin/instance-applications",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_list_applications_pending(client, admin_token, session_factory, applicant_user_id):
    await _seed_application(session_factory, user_id=applicant_user_id, hostname="self1.example.com")
    r = await client.get(
        "/admin/instance-applications",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["hostname"] == "self1.example.com"
    assert data[0]["status"] == "pending"
    assert "applicant_username" in data[0]


# --------------------------------------------------------------------------- #
# 3. Approve happy path                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_approve_happy(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="self2.example.com"
    )
    r = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["hostname"] == "self2.example.com"
    assert "client_id" in data
    assert "client_secret" in data
    assert len(data["client_secret"]) > 20
    assert data["worker_id_chat"] >= 100
    assert data["worker_id_voice"] >= 100
    assert data["worker_id_media"] >= 100
    assert "warning" in data

    # Verify DB state
    async with session_factory() as s:
        app_row = await s.get(InstanceApplication, app_id)
        assert app_row.status == "approved"
        assert app_row.approved_instance_id is not None

        inst = await s.get(RegisteredInstance, app_row.approved_instance_id)
        assert inst is not None
        assert inst.hostname == "self2.example.com"
        # Secret must be hashed, not stored plaintext
        assert verify_password(data["client_secret"], inst.client_secret)


# --------------------------------------------------------------------------- #
# 4. Worker-ID allocation: two approvals → 6 distinct IDs, all >= 100          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_worker_id_allocation_two_approvals(
    client, admin_token, session_factory, applicant_user_id
):
    app1 = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="host-a.example.com"
    )
    app2 = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="host-b.example.com"
    )

    r1 = await client.post(
        f"/admin/instance-applications/{app1}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    r2 = await client.post(
        f"/admin/instance-applications/{app2}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text

    d1, d2 = r1.json(), r2.json()
    ids_1 = {d1["worker_id_chat"], d1["worker_id_voice"], d1["worker_id_media"]}
    ids_2 = {d2["worker_id_chat"], d2["worker_id_voice"], d2["worker_id_media"]}

    # All 6 must be >= 100
    for wid in ids_1 | ids_2:
        assert wid >= 100, f"worker_id {wid} below 100"

    # No overlap between the two instances
    assert ids_1.isdisjoint(ids_2), f"worker-id collision: {ids_1 & ids_2}"


# --------------------------------------------------------------------------- #
# 5. Approve idempotent: second call → 409, no secret in error body            #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_approve_idempotent(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="idem.example.com"
    )
    r1 = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r1.status_code == 200

    r2 = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r2.status_code == 409
    # Make sure no secret leaks in the error body
    assert "client_secret" not in r2.text


# --------------------------------------------------------------------------- #
# 6. Reject happy path + idempotent                                             #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_reject_happy(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="rej.example.com"
    )
    r = await client.post(
        f"/admin/instance-applications/{app_id}/reject",
        json={"rejection_reason": "spam operation"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204

    async with session_factory() as s:
        app_row = await s.get(InstanceApplication, app_id)
        assert app_row.status == "rejected"
        assert app_row.rejection_reason == "spam operation"
        assert app_row.reviewed_at is not None


@pytest.mark.asyncio
async def test_reject_idempotent(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="rej2.example.com"
    )
    r1 = await client.post(
        f"/admin/instance-applications/{app_id}/reject",
        json={"rejection_reason": "first"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r1.status_code == 204

    r2 = await client.post(
        f"/admin/instance-applications/{app_id}/reject",
        json={"rejection_reason": "second"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r2.status_code == 409


# --------------------------------------------------------------------------- #
# 7. List instances — no client_secret in response                              #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_list_instances_no_secret(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="sec-check.example.com"
    )
    await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    r = await client.get(
        "/admin/instances",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert len(data) >= 1
    for item in data:
        assert "client_secret" not in item


@pytest.mark.asyncio
async def test_list_instances_status_filter(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="filter-test.example.com"
    )
    await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    r_active = await client.get(
        "/admin/instances?status=active",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r_active.status_code == 200
    assert len(r_active.json()) >= 1

    r_suspended = await client.get(
        "/admin/instances?status=suspended",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r_suspended.status_code == 200
    assert r_suspended.json() == []


# --------------------------------------------------------------------------- #
# 8. Suspend → DB state                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_suspend_happy(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="suspend-me.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]

    r = await client.delete(
        f"/admin/instances/{inst_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id)
        assert inst.status == "suspended"
        susp = await s.get(SuspendedInstance, inst_id)
        assert susp is not None
        assert susp.instance_id == inst_id


@pytest.mark.asyncio
async def test_suspend_idempotent(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="suspend-idem.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]

    r1 = await client.delete(
        f"/admin/instances/{inst_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )
    r2 = await client.delete(
        f"/admin/instances/{inst_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert r1.status_code == 204
    assert r2.status_code == 204  # idempotent


# --------------------------------------------------------------------------- #
# 9. Unsuspend → row gone, status active                                        #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_unsuspend_happy(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-me.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]

    await client.delete(
        f"/admin/instances/{inst_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )

    r = await client.post(
        f"/admin/instances/{inst_id}/unsuspend",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id)
        assert inst.status == "active"
        susp = await s.get(SuspendedInstance, inst_id)
        assert susp is None


@pytest.mark.asyncio
async def test_unsuspend_idempotent(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-idem.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]

    # Not suspended yet — unsuspend should be a no-op
    r = await client.post(
        f"/admin/instances/{inst_id}/unsuspend",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204


# --------------------------------------------------------------------------- #
# 10. Rotate secret                                                              #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_rotate_secret(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="rotate-me.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]
    old_secret_plain = approval.json()["client_secret"]

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id)
        old_hash = inst.client_secret

    r = await client.post(
        f"/admin/instances/{inst_id}/rotate-secret",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "client_secret" in data
    assert len(data["client_secret"]) > 20
    assert data["client_secret"] != old_secret_plain
    assert "warning" in data

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id)
        new_hash = inst.client_secret
        # Hash changed
        assert new_hash != old_hash
        # Old plaintext no longer verifies
        assert not verify_password(old_secret_plain, new_hash)
        # New plaintext verifies
        assert verify_password(data["client_secret"], new_hash)
