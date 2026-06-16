"""Tests für POST /reports + Admin-Complaints-Endpoints."""

from __future__ import annotations

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


async def _seed_instance_with_operator(
    session_factory, *, contact_email: str = "operator@dcc-test.example.com"
) -> tuple[int, str, str]:
    """Seed a RegisteredInstance + its approved InstanceApplication.

    Returns ``(instance_id, hostname, contact_email)``. The operator address
    lives on the application, which is how forward_complaint resolves it.
    """
    from dcc_auth.models_instances import InstanceApplication, RegisteredInstance

    inst_id = next_id()
    hostname = f"host-{inst_id}.example.com"
    async with session_factory() as s:
        registrar = User(
            id=next_id(),
            username=f"op{inst_id}",
            email=f"op{inst_id}@dcc-test.example.com",
            password_hash="x",
            pairwise_salt=b"\x00" * 32,
        )
        s.add(registrar)
        await s.flush()
        s.add(
            RegisteredInstance(
                id=inst_id,
                hostname=hostname,
                client_id=f"cid-{inst_id}",
                client_secret="x",
                worker_id_chat=101,
                worker_id_voice=102,
                worker_id_media=103,
                status="active",
                registered_by=registrar.id,
            )
        )
        s.add(
            InstanceApplication(
                id=next_id(),
                applicant_user_id=registrar.id,
                hostname=hostname,
                purpose="privat",
                expected_users=5,
                contact_email=contact_email,
                status="approved",
                approved_instance_id=inst_id,
            )
        )
        await s.commit()
    return inst_id, hostname, contact_email


def _patch_smtp_send(monkeypatch) -> list[dict]:
    """Make forward_complaint think SMTP is configured + capture the send.

    Returns the list that fake send_email appends each dispatch to.
    """
    import dcc_auth.routes_complaints as rc

    sent: list[dict] = []

    async def fake_send(to, subject, body, session=None):
        sent.append({"to": to, "subject": subject, "body": body})

    async def fake_cfg(session=None):
        return object()  # any non-None → "SMTP configured"

    monkeypatch.setattr(rc, "send_email", fake_send)
    monkeypatch.setattr(rc, "resolve_smtp_config", fake_cfg)
    return sent


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


# ---------------------------------------------------------------------------
# Admin: acknowledge
# ---------------------------------------------------------------------------


class TestAcknowledgeComplaint:
    async def test_acknowledge_sets_status(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=True)

        r = await client.post(
            f"/admin/complaints/{cid}/acknowledge",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "acknowledged"

        # ...and it now shows up under the acknowledged filter.
        r2 = await client.get(
            "/admin/complaints?status=acknowledged",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert cid in [item["id"] for item in r2.json()]

    async def test_acknowledge_non_admin_403(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=False)
        r = await client.post(
            f"/admin/complaints/{cid}/acknowledge",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403

    async def test_acknowledge_nonexistent_404(self, client, session_factory):
        _, token = await _seed_user(session_factory, is_admin=True)
        r = await client.post(
            "/admin/complaints/999999999999999999/acknowledge",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Admin: forward — email dispatch + audit trail
# ---------------------------------------------------------------------------


class TestForwardEmail:
    async def test_forward_sends_email_to_operator(
        self, client, session_factory, app, monkeypatch
    ):
        """Complaint against an instance → operator gets an email."""
        from dcc_auth.routes import _reset_rate

        inst_id, hostname, operator_email = await _seed_instance_with_operator(
            session_factory
        )
        sent = _patch_smtp_send(monkeypatch)

        _reset_rate(app)
        r = await client.post(
            "/reports",
            json={
                "body": "This instance hosts clearly illegal material right now.",
                "target_instance_id": inst_id,
            },
        )
        cid = r.json()["id"]

        _, token = await _seed_user(session_factory, is_admin=True)
        notice = "Bitte den gemeldeten Inhalt prüfen und entfernen."
        fr = await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": notice},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert fr.status_code == 200
        data = fr.json()
        assert data["status"] == "forwarded"
        assert data["email_sent"] is True
        assert data["email_error"] is None
        assert data["forwarded_to_email"] == operator_email

        # The email actually went to the operator and carries the context.
        assert len(sent) == 1
        assert sent[0]["to"] == operator_email
        assert hostname in sent[0]["subject"]
        assert notice in sent[0]["body"]
        assert "illegal material" in sent[0]["body"]

    async def test_forwarded_complaint_keeps_audit_trail(
        self, client, session_factory, app, monkeypatch
    ):
        from dcc_auth.routes import _reset_rate

        inst_id, _hostname, operator_email = await _seed_instance_with_operator(
            session_factory
        )
        _patch_smtp_send(monkeypatch)
        _reset_rate(app)
        cid = (
            await client.post(
                "/reports",
                json={"body": "Audit-trail complaint body here.", "target_instance_id": inst_id},
            )
        ).json()["id"]

        _, token = await _seed_user(session_factory, is_admin=True)
        await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": "Notice for the audit trail."},
            headers={"Authorization": f"Bearer {token}"},
        )

        item = (
            await client.get(
                "/admin/complaints?status=forwarded",
                headers={"Authorization": f"Bearer {token}"},
            )
        ).json()[0]
        assert item["forwarded_to_email"] == operator_email
        assert item["forward_notice"] == "Notice for the audit trail."
        assert item["forwarded_at"] is not None

    async def test_forward_without_operator_email_reports_reason(
        self, client, session_factory, app
    ):
        """URL-only complaint → no operator to email; status still advances."""
        cid = await _submit_and_get_id(client, app)  # target_url only
        _, token = await _seed_user(session_factory, is_admin=True)

        fr = await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": "Nowhere to send this."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert fr.status_code == 200
        data = fr.json()
        assert data["status"] == "forwarded"
        assert data["email_sent"] is False
        assert data["email_error"] == "no_operator_email"
        assert data["forwarded_to_email"] is None

    async def test_forward_with_operator_but_smtp_unconfigured(
        self, client, session_factory, app
    ):
        """Operator exists but SMTP isn't set up → flagged, not silently 'sent'."""
        from dcc_auth.routes import _reset_rate

        inst_id, _hostname, _email = await _seed_instance_with_operator(session_factory)
        _reset_rate(app)
        cid = (
            await client.post(
                "/reports",
                json={"body": "SMTP-unconfigured complaint body.", "target_instance_id": inst_id},
            )
        ).json()["id"]

        _, token = await _seed_user(session_factory, is_admin=True)
        fr = await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": "Would forward if SMTP were configured."},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert fr.status_code == 200
        data = fr.json()
        assert data["email_sent"] is False
        assert data["email_error"] == "smtp_not_configured"

    async def test_forward_empty_notice_422(self, client, session_factory, app):
        cid = await _submit_and_get_id(client, app)
        _, token = await _seed_user(session_factory, is_admin=True)
        r = await client.post(
            f"/admin/complaints/{cid}/forward",
            json={"notice_text": ""},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# Admin: list enrichment
# ---------------------------------------------------------------------------


class TestListEnrichment:
    async def test_instance_complaint_is_enriched(
        self, client, session_factory, app
    ):
        from dcc_auth.routes import _reset_rate

        inst_id, hostname, operator_email = await _seed_instance_with_operator(
            session_factory
        )
        _reset_rate(app)
        await client.post(
            "/reports",
            json={"body": "Enrichment test complaint body.", "target_instance_id": inst_id},
        )

        _, token = await _seed_user(session_factory, is_admin=True)
        items = (
            await client.get(
                "/admin/complaints?status=new",
                headers={"Authorization": f"Bearer {token}"},
            )
        ).json()
        match = next(i for i in items if i["target_instance_id"] == str(inst_id))
        assert match["target_instance_hostname"] == hostname
        assert match["operator_email"] == operator_email

    async def test_user_complaint_is_enriched(self, client, session_factory, app):
        from dcc_auth.routes import _reset_rate

        target, _tok = await _seed_user(session_factory)
        _reset_rate(app)
        await client.post(
            "/reports",
            json={"body": "User-target enrichment complaint.", "target_user_id": target.id},
        )

        _, token = await _seed_user(session_factory, is_admin=True)
        items = (
            await client.get(
                "/admin/complaints?status=new",
                headers={"Authorization": f"Bearer {token}"},
            )
        ).json()
        match = next(i for i in items if i["target_user_id"] == str(target.id))
        assert match["target_username"] == target.username
