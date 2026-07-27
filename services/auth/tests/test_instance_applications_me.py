"""Tests für /me/instance-applications + /me/instances (Phase 2.2)."""

from __future__ import annotations

import secrets

import pytest
import pytest_asyncio

from sqlalchemy import update

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership

# ---------------------------------------------------------------------------
# Shared test credentials
# ---------------------------------------------------------------------------

_REG_A = {
    "username": "inst_alice",
    "email": "inst_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}
_REG_B = {
    "username": "inst_bob",
    "email": "inst_bob@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Bob",
}
_LOGIN_A = {"email_or_username": _REG_A["email"], "password": _REG_A["password"]}
_LOGIN_B = {"email_or_username": _REG_B["email"], "password": _REG_B["password"]}

_VALID_APP = {
    "hostname": "pulse.example.com",
    "purpose": "privat",
    "expected_users": 5,
    "contact_email": "alice@dcc-test.example.com",
    "notes": "Kleines Team",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _reg_and_login(client, reg: dict, login: dict) -> str:
    """Register + login, return cookie header string."""
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid, "pulse_session cookie fehlt"
    return f"pulse_session={sid}"


async def _enable_self_host(session_factory, client, cookie: str) -> None:
    """④-Gate: die Credential-Endpunkte (env-file, bootstrap-token) verlangen
    self_host_enabled. Diese Datei testet die Instanz-Workflows, nicht das Gate,
    also schalten die Fixtures es frei (das Gate selbst deckt test_self_host_gate ab)."""
    r = await client.get("/me", headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    uid = int(r.json()["id"])
    async with session_factory() as session:
        await session.execute(
            update(User).where(User.id == uid).values(self_host_enabled=True)
        )
        await session.commit()


@pytest_asyncio.fixture
async def alice_cookie(session_factory, client) -> str:
    cookie = await _reg_and_login(client, _REG_A, _LOGIN_A)
    await _enable_self_host(session_factory, client, cookie)
    return cookie


@pytest_asyncio.fixture
async def bob_cookie(session_factory, client) -> str:
    cookie = await _reg_and_login(client, _REG_B, _LOGIN_B)
    await _enable_self_host(session_factory, client, cookie)
    return cookie


@pytest_asyncio.fixture
async def alice_instance(session_factory, alice_cookie, client) -> RegisteredInstance:
    """Seed a RegisteredInstance for Alice plus her Owner-Membership."""
    # Wir brauchen Alice's User-ID. Wir holen sie aus dem /me-Endpoint.
    r = await client.get("/me", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    alice_id = r.json()["id"]

    async with session_factory() as session:
        inst = RegisteredInstance(
            id=10000000000000001,
            hostname="alice-instance.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret="$argon2id$v=19$m=65536,t=3,p=4$fakehash",
            worker_id_chat=100,
            worker_id_voice=101,
            worker_id_media=102,
            status="active",
            registered_by=int(alice_id),
        )
        session.add(inst)
        await session.commit()
        await session.refresh(inst)
        # Membership anlegen, damit GET /me/instances die Instanz via JOIN findet
        # (Migration 0037, Account-basierte Server-Liste statt Vault).
        session.add(
            UserInstanceMembership(
                user_id=int(alice_id),
                instance_id=inst.id,
                role="owner",
            )
        )
        await session.commit()
    return inst


# ---------------------------------------------------------------------------
# Auth-Required-Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_application_requires_cookie(client):
    r = await client.post("/me/instance-applications", json=_VALID_APP)
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_applications_requires_cookie(client):
    r = await client.get("/me/instance-applications")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_instances_requires_cookie(client):
    r = await client.get("/me/instances")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_snippet_requires_cookie(client):
    r = await client.post("/me/instances/12345/env-file")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# POST /me/instance-applications — Happy Path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_application_happy_path(client, alice_cookie):
    r = await client.post(
        "/me/instance-applications",
        json=_VALID_APP,
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["hostname"] == "pulse.example.com"
    assert data["purpose"] == "privat"
    assert data["status"] == "pending"
    assert data["expected_users"] == 5
    # ID muss als String kommen (Snowflake-String-API)
    assert isinstance(data["id"], str)
    assert isinstance(data["applicant_user_id"], str)
    # Kein secret im Body
    assert "client_secret" not in data


@pytest.mark.asyncio
async def test_post_application_hostname_only_derives_email(client, alice_cookie):
    """Das schlanke Formular schickt nur den Hostname — contact_email leitet das
    Backend aus dem eingeloggten User ab, purpose/expected_users bekommen Defaults."""
    r = await client.post(
        "/me/instance-applications",
        json={"hostname": "minimal.example.com"},
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["hostname"] == "minimal.example.com"
    assert data["contact_email"] == "inst_alice@dcc-test.example.com"
    assert data["status"] == "pending"


# ---------------------------------------------------------------------------
# Hostname-Validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "hostname",
    [
        "localhost",          # Single-label
        "example",            # Single-label ohne TLD
        "192.168.1.1",        # IPv4
        "2001:db8::1",        # IPv6-artig
        "-invalid.com",       # Bindestrich am Labelanfang
        "invalid-.com",       # Bindestrich am Labelende
        "a",                  # zu kurz (< 4 Zeichen)
        "",                   # leer
    ],
)
async def test_post_application_invalid_hostname(client, alice_cookie, hostname):
    payload = {**_VALID_APP, "hostname": hostname}
    r = await client.post(
        "/me/instance-applications",
        json=payload,
        headers={"Cookie": alice_cookie},
    )
    # 422 von Pydantic (zu kurz/leer) oder vom FQDN-Check
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_post_application_uppercase_normalized(client, alice_cookie):
    """Uppercase-Hostnames werden zu lowercase normalisiert und akzeptiert."""
    r = await client.post(
        "/me/instance-applications",
        json={**_VALID_APP, "hostname": "PULSE.EXAMPLE.COM"},
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 201, r.text
    assert r.json()["hostname"] == "pulse.example.com"


@pytest.mark.asyncio
async def test_post_application_valid_fqdn_accepted(client, alice_cookie):
    """Gültige FQDNs werden akzeptiert."""
    payload = {**_VALID_APP, "hostname": "sub.domain.co.uk"}
    r = await client.post(
        "/me/instance-applications",
        json=payload,
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 201, r.text


# ---------------------------------------------------------------------------
# Duplicate-Check: pending-Antrag für denselben Hostname → 409
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_application_duplicate_pending_409(client, alice_cookie):
    # Erster Antrag
    r1 = await client.post(
        "/me/instance-applications",
        json=_VALID_APP,
        headers={"Cookie": alice_cookie},
    )
    assert r1.status_code == 201, r1.text

    # Zweiter Antrag für denselben Hostname → 409
    r2 = await client.post(
        "/me/instance-applications",
        json=_VALID_APP,
        headers={"Cookie": alice_cookie},
    )
    assert r2.status_code == 409, r2.text


@pytest.mark.asyncio
async def test_post_application_different_hostname_ok(client, alice_cookie):
    """Zwei Anträge für verschiedene Hostnames sind erlaubt."""
    r1 = await client.post(
        "/me/instance-applications",
        json={**_VALID_APP, "hostname": "host1.example.com"},
        headers={"Cookie": alice_cookie},
    )
    assert r1.status_code == 201, r1.text

    r2 = await client.post(
        "/me/instance-applications",
        json={**_VALID_APP, "hostname": "host2.example.com"},
        headers={"Cookie": alice_cookie},
    )
    assert r2.status_code == 201, r2.text


@pytest.mark.asyncio
async def test_post_application_hostname_conflict_with_instance(
    client, alice_cookie, alice_instance
):
    """Hostname der bereits in registered_instances existiert → 409."""
    r = await client.post(
        "/me/instance-applications",
        json={**_VALID_APP, "hostname": alice_instance.hostname},
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 409, r.text


# ---------------------------------------------------------------------------
# GET /me/instance-applications — nur eigene Applications
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_applications_only_own(client, alice_cookie, bob_cookie):
    # Alice reicht Antrag ein
    await client.post(
        "/me/instance-applications",
        json=_VALID_APP,
        headers={"Cookie": alice_cookie},
    )

    # Bob reicht Antrag für anderen Hostname ein
    await client.post(
        "/me/instance-applications",
        json={**_VALID_APP, "hostname": "bob.example.com"},
        headers={"Cookie": bob_cookie},
    )

    # Alice sieht nur ihren eigenen Antrag
    r_alice = await client.get(
        "/me/instance-applications",
        headers={"Cookie": alice_cookie},
    )
    assert r_alice.status_code == 200, r_alice.text
    alice_apps = r_alice.json()
    assert len(alice_apps) == 1
    assert alice_apps[0]["hostname"] == "pulse.example.com"

    # Bob sieht nur seinen eigenen Antrag
    r_bob = await client.get(
        "/me/instance-applications",
        headers={"Cookie": bob_cookie},
    )
    assert r_bob.status_code == 200, r_bob.text
    bob_apps = r_bob.json()
    assert len(bob_apps) == 1
    assert bob_apps[0]["hostname"] == "bob.example.com"


@pytest.mark.asyncio
async def test_get_applications_status_filter(client, alice_cookie):
    """?status=pending filtert korrekt."""
    await client.post(
        "/me/instance-applications",
        json=_VALID_APP,
        headers={"Cookie": alice_cookie},
    )
    # pending-Filter
    r = await client.get(
        "/me/instance-applications?status=pending",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 200
    apps = r.json()
    assert len(apps) == 1

    # rejected-Filter → leer (keine rejected)
    r2 = await client.get(
        "/me/instance-applications?status=rejected",
        headers={"Cookie": alice_cookie},
    )
    assert r2.status_code == 200
    assert len(r2.json()) == 0


# ---------------------------------------------------------------------------
# GET /me/instances — nur eigene Instanzen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_instances_empty(client, alice_cookie):
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_get_instances_only_own(client, alice_cookie, bob_cookie, alice_instance):
    """Alice sieht ihre Instanz, Bob sieht eine leere Liste."""
    r_alice = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r_alice.status_code == 200
    alice_insts = r_alice.json()
    assert len(alice_insts) == 1
    data = alice_insts[0]
    assert data["hostname"] == "alice-instance.example.com"
    assert data["id"] == str(alice_instance.id)
    # client_secret darf NICHT im Response erscheinen
    assert "client_secret" not in data

    r_bob = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert r_bob.status_code == 200
    assert r_bob.json() == []


# ---------------------------------------------------------------------------
# POST /me/instances/{id}/env-file
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_snippet_happy_path(client, alice_cookie, alice_instance):
    r = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 200
    assert "text/plain" in r.headers["content-type"]
    body = r.text
    # Var-Namen MÜSSEN exakt die sein, die der allinone-Container liest
    # (10-check-cloud-creds.sh / 07-render-env.sh) — sonst startet er nicht.
    assert f"PULSE_INSTANCE_ID={alice_instance.id}" in body
    assert f"PULSE_CLOUD_CLIENT_ID={alice_instance.client_id}" in body
    assert f"PULSE_INSTANCE_OWNER_ID={alice_instance.registered_by}" in body
    assert f"PULSE_HOSTNAME={alice_instance.hostname}" in body
    # Der alte (kaputte) INSTANCE_CLIENT-Name darf NICHT mehr vorkommen.
    assert "PULSE_INSTANCE_CLIENT_ID" not in body
    # Worker-IDs ignoriert der Single-Container → nicht mehr im Snippet.
    assert "WORKER_ID_CHAT" not in body
    # Frisches Secret ist gesetzt — KEIN Platzhalter mehr.
    assert "PULSE_CLOUD_CLIENT_SECRET=<...>" not in body
    secret_line = next(
        ln for ln in body.splitlines() if ln.startswith("PULSE_CLOUD_CLIENT_SECRET=")
    )
    secret = secret_line.split("=", 1)[1]
    assert len(secret) >= 20
    # Admin-Mail ist befüllt (keine offenen Platzhalter mehr).
    assert "PULSE_ADMIN_EMAIL=" in body
    assert "<...>" not in body


@pytest.mark.asyncio
async def test_env_file_blocked_after_first_download(
    client, alice_cookie, alice_instance
):
    """One-shot: zweiter Download → 403 mit Hinweis auf neuen Antrag."""
    r1 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r1.status_code == 200

    r2 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r2.status_code == 403, r2.text
    assert "bereits heruntergeladen" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_env_file_reissue_liefert_neues_secret(
    client, alice_cookie, alice_instance
):
    """``reset=true`` hebt die One-Shot-Sperre auf und rotiert das Secret.

    Der Recovery-Pfad bei verlorener Datei (2026-07-27). Wichtig ist nicht nur,
    DASS ein zweiter Download klappt, sondern dass er ein ANDERES Secret
    liefert — sonst waere die Rotation kaputt und zwei Server koennten
    gleichzeitig mit demselben Geheimnis laufen.
    """

    def secret_of(resp) -> str:
        line = next(
            ln
            for ln in resp.text.splitlines()
            if ln.startswith("PULSE_CLOUD_CLIENT_SECRET=")
        )
        return line.split("=", 1)[1]

    r1 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r1.status_code == 200

    r2 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
        json={"reset": True},
    )
    assert r2.status_code == 200, r2.text
    assert secret_of(r2) != secret_of(r1)

    # Ohne das Flag bleibt es gesperrt — der Reset ist ein bewusster Schritt,
    # kein Zustand, in den die Instanz nach einmal Reset dauerhaft faellt.
    r3 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r3.status_code == 403, r3.text


@pytest.mark.asyncio
async def test_env_file_reissue_false_bleibt_gesperrt(
    client, alice_cookie, alice_instance
):
    """``reset=false`` explizit im Body darf die Sperre NICHT aufheben."""
    r1 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r1.status_code == 200
    r2 = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
        json={"reset": False},
    )
    assert r2.status_code == 403, r2.text


@pytest.mark.asyncio
async def test_env_file_reissue_nur_fuer_owner(client, bob_cookie, alice_instance):
    """Der Reset darf kein Schlupfloch um den Owner-Check sein — Bob bekommt
    404 wie ueberall sonst (Existence-Leak-Schutz)."""
    r = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": bob_cookie},
        json={"reset": True},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_snippet_404_for_other_user(client, bob_cookie, alice_instance):
    """Bob bekommt 404 für Alices Instanz (kein 403 wegen Existence-Leak)."""
    r = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_snippet_404_nonexistent(client, alice_cookie):
    r = await client.post(
        "/me/instances/9999999999999/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_snippet_invalid_id_404(client, alice_cookie):
    """Ungültige (nicht-numerische) ID → 404."""
    r = await client.post(
        "/me/instances/not-a-number/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# POST/DELETE /me/instances/{id}/membership — eingeladene Nicht-Owner-User
# (Phase 4-6: Self-Host-Server taucht auch im Browser/auf anderen Geräten auf)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_join_membership_makes_instance_visible(
    client, bob_cookie, alice_instance
):
    """Bob ist nicht Owner → sieht Alices Instanz erst NACH dem Membership-Join."""
    before = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert before.status_code == 200
    assert before.json() == []

    join = await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert join.status_code == 204, join.text

    after = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert after.status_code == 200
    ids = [i["id"] for i in after.json()]
    assert str(alice_instance.id) in ids


@pytest.mark.asyncio
async def test_join_membership_idempotent(client, bob_cookie, alice_instance):
    """Zweimal joinen ändert nichts (kein 409, eine Zeile)."""
    for _ in range(2):
        r = await client.post(
            f"/me/instances/{alice_instance.id}/membership",
            headers={"Cookie": bob_cookie},
        )
        assert r.status_code == 204, r.text
    after = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert [i["id"] for i in after.json()] == [str(alice_instance.id)]


@pytest.mark.asyncio
async def test_join_membership_does_not_downgrade_owner(
    session_factory, client, alice_cookie, alice_instance
):
    """Ein Join des Owners lässt seine ``owner``-Rolle unverändert."""
    r = await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 204, r.text
    async with session_factory() as session:
        row = await session.get(
            UserInstanceMembership,
            (int(alice_instance.registered_by), alice_instance.id),
        )
        assert row is not None and row.role == "owner"


@pytest.mark.asyncio
async def test_join_membership_404_nonexistent(client, bob_cookie):
    r = await client.post(
        "/me/instances/9999999999999/membership",
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_join_membership_requires_cookie(client, alice_instance):
    r = await client.post(f"/me/instances/{alice_instance.id}/membership")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_leave_membership_hides_instance(client, bob_cookie, alice_instance):
    """Nach dem Austritt verschwindet die Instanz wieder aus Bobs Liste."""
    await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    leave = await client.delete(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert leave.status_code == 204, leave.text
    after = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert after.json() == []


@pytest.mark.asyncio
async def test_leave_membership_idempotent_when_absent(
    client, bob_cookie, alice_instance
):
    """Austreten ohne Membership → 204 (idempotent), kein Fehler."""
    r = await client.delete(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_leave_membership_owner_forbidden(client, alice_cookie, alice_instance):
    """Der Owner kann seine Membership nicht per Austritt wegwerfen → 403."""
    r = await client.delete(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# PATCH /me/instances/{id}/preferences — geräteübergreifende Präferenzen
# (Label + Notification-Modus aus user_instance_memberships)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_instance_out_defaults_for_owner(client, alice_cookie, alice_instance):
    """Frische Membership → user_label None, notification_mode 'mentions'."""
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200
    inst = next(i for i in r.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] is None
    assert inst["notification_mode"] == "mentions"


@pytest.mark.asyncio
async def test_patch_preferences_label_and_mode_roundtrip(
    client, alice_cookie, alice_instance
):
    """Label + Modus setzen → tauchen in GET /me/instances auf (geräteübergreifend)."""
    r = await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "Mein Server", "notification_mode": "none"},
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 204, r.text
    got = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    inst = next(i for i in got.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] == "Mein Server"
    assert inst["notification_mode"] == "none"


@pytest.mark.asyncio
async def test_patch_preferences_partial_keeps_other_field(
    client, alice_cookie, alice_instance
):
    """Nur den Modus patchen lässt ein zuvor gesetztes Label stehen."""
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "Behalten"},
        headers={"Cookie": alice_cookie},
    )
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"notification_mode": "all"},
        headers={"Cookie": alice_cookie},
    )
    got = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    inst = next(i for i in got.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] == "Behalten"
    assert inst["notification_mode"] == "all"


@pytest.mark.asyncio
async def test_patch_preferences_label_null_clears(
    client, alice_cookie, alice_instance
):
    """label=null setzt den Anzeigenamen explizit zurück (Hostname anzeigen)."""
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "Temp"},
        headers={"Cookie": alice_cookie},
    )
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": None},
        headers={"Cookie": alice_cookie},
    )
    got = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    inst = next(i for i in got.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] is None


@pytest.mark.asyncio
async def test_patch_preferences_404_without_membership(
    client, bob_cookie, alice_instance
):
    """Ohne eigene Membership → 404 (kein fremdes Schreiben)."""
    r = await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "fremd"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_patch_preferences_requires_cookie(client, alice_instance):
    r = await client.patch(
        f"/me/instances/{alice_instance.id}/preferences", json={"label": "x"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_instances_prefers_relay_subdomain(
    client, alice_cookie, alice_instance, session_factory
):
    """App-Host-Instanzen: der Client muss die ERREICHBARE Adresse bekommen.

    ``hostname`` ist bei ihnen ein synthetischer Platzhalter (``app-<id>.…``,
    existiert nicht im DNS); erreichbar sind sie erst unter der beim Pairing
    vergebenen Relay-Subdomain. Ohne diesen Vorrang baut der Client seine
    Server-URL aus dem Platzhalter, landet auf einem toten Host und der
    Cert-Login scheitert mit 401 (``cert_invalid``).
    """
    async with session_factory() as session:
        inst = await session.get(RegisteredInstance, alice_instance.id)
        inst.hostname = f"app-{alice_instance.id}.relay.example.com"
        inst.origin = "app_host"
        inst.relay_subdomain = "calm-thistle-98e3.relay.example.com"
        await session.commit()

    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    assert r.json()[0]["hostname"] == "calm-thistle-98e3.relay.example.com"


@pytest.mark.asyncio
async def test_me_instances_falls_back_to_hostname_without_subdomain(
    client, alice_cookie, alice_instance
):
    """VPS-Instanzen (kein relay_subdomain) behalten ihren echten Hostname."""
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    assert r.json()[0]["hostname"] == "alice-instance.example.com"
