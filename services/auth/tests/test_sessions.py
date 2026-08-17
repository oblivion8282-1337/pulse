"""Tests for the ``/sessions`` routes (active-session management)."""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import pytest

from dcc_auth.models import UserSession

REG_PAYLOAD = {
    "username": "alice",
    "email": "alice@example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


async def _register(client, **overrides) -> dict:
    payload = {**REG_PAYLOAD, **overrides}
    r = await client.post("/register", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


async def _login_response(client, *, user_agent: str | None = None):
    headers = {"User-Agent": user_agent} if user_agent else {}
    r = await client.post(
        "/login",
        json={
            "email_or_username": REG_PAYLOAD["email"],
            "password": REG_PAYLOAD["password"],
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r


async def _login(client, *, user_agent: str | None = None) -> dict:
    return (await _login_response(client, user_agent=user_agent)).json()


async def _cookie_alive(client, sid: str) -> bool:
    """Lebt das Browser-Session-Cookie noch? (cookie-only ``GET /me``)"""
    r = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    assert r.status_code in (200, 401), r.text
    return r.status_code == 200


async def _session_id_for_ua(client, access: str, user_agent: str) -> str:
    rows = (
        await client.get("/sessions", headers={"Authorization": f"Bearer {access}"})
    ).json()
    hits = [row["id"] for row in rows if row["user_agent"] == user_agent]
    assert len(hits) == 1, f"expected exactly one row for {user_agent}: {rows}"
    return hits[0]


@pytest.mark.asyncio
async def test_list_sessions_requires_auth(client):
    r = await client.get("/sessions")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_sessions_returns_active_only(client):
    # Register seeds one refresh token; two follow-up logins add two more.
    tokens = await _register(client)
    access = tokens["access_token"]
    await _login(client)
    await _login(client)

    # Revoke one of the three via /logout (uses one of the refresh tokens
    # we still hold). We hold the very first one from /register.
    r_logout = await client.post(
        "/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    assert r_logout.status_code == 200

    r = await client.get(
        "/sessions", headers={"Authorization": f"Bearer {access}"}
    )
    assert r.status_code == 200
    body = r.json()
    # 3 issued total, 1 revoked -> 2 active remain.
    assert len(body) == 2
    for row in body:
        assert isinstance(row["id"], str)
        assert "user_agent" in row
        assert "created_at" in row
        assert "last_used_at" in row
        assert "is_current" in row
        assert "ip_hash_prefix" in row


@pytest.mark.asyncio
async def test_list_sessions_marks_current(client):
    """is_current must hit for exactly the session whose UA matches the
    incoming request's UA (same IP since httpx ASGITransport is local)."""
    await _register(client)
    # The /register call above happened without a custom UA. Log in twice
    # with two different UAs so we can disambiguate.
    foo = await _login(client, user_agent="Foo/1.0")

    # Listing with UA=Foo should mark exactly one row as current.
    r = await client.get(
        "/sessions",
        headers={
            "Authorization": f"Bearer {foo['access_token']}",
            "User-Agent": "Foo/1.0",
        },
    )
    assert r.status_code == 200
    rows = r.json()
    current_rows = [row for row in rows if row["is_current"]]
    assert len(current_rows) == 1
    assert current_rows[0]["user_agent"] == "Foo/1.0"


@pytest.mark.asyncio
async def test_delete_session_revokes_only_that_token(client):
    tokens = await _register(client)
    access = tokens["access_token"]
    await _login(client)
    await _login(client)

    listed = await client.get(
        "/sessions", headers={"Authorization": f"Bearer {access}"}
    )
    rows = listed.json()
    assert len(rows) == 3

    target_id = rows[0]["id"]
    r_del = await client.delete(
        f"/sessions/{target_id}", headers={"Authorization": f"Bearer {access}"}
    )
    assert r_del.status_code == 204

    listed2 = await client.get(
        "/sessions", headers={"Authorization": f"Bearer {access}"}
    )
    remaining_ids = {row["id"] for row in listed2.json()}
    assert target_id not in remaining_ids
    assert len(remaining_ids) == 2


@pytest.mark.asyncio
async def test_delete_session_404_if_not_owner(client):
    # Alice registers + has one active refresh token.
    alice_tokens = await _register(client)
    listed = await client.get(
        "/sessions",
        headers={"Authorization": f"Bearer {alice_tokens['access_token']}"},
    )
    alice_session_id = listed.json()[0]["id"]

    # Bob registers; tries to delete Alice's session via Bob's token.
    bob_tokens = await _register(
        client, username="bob", email="bob@example.com"
    )
    r = await client.delete(
        f"/sessions/{alice_session_id}",
        headers={"Authorization": f"Bearer {bob_tokens['access_token']}"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_all_revokes_all_except_current(client):
    """Three active sessions; DELETE /sessions sweeps two, leaves the
    current one (matching IP-hash + UA) intact."""
    await _register(client)
    # Two side-sessions on different UAs.
    await _login(client, user_agent="OtherDevice/1")
    await _login(client, user_agent="OtherDevice/2")
    # Current session: log in with the UA we'll send on the DELETE call.
    current = await _login(client, user_agent="CurrentDevice/1")

    headers = {
        "Authorization": f"Bearer {current['access_token']}",
        "User-Agent": "CurrentDevice/1",
    }

    # Sanity: list should show 4 active (1 from register + 3 logins).
    listed_before = await client.get("/sessions", headers=headers)
    assert len(listed_before.json()) == 4

    r = await client.delete("/sessions", headers=headers)
    assert r.status_code == 200
    body = r.json()
    # 4 active, 1 current -> 3 swept.
    assert body == {"revoked_count": 3}

    listed_after = await client.get("/sessions", headers=headers)
    rows = listed_after.json()
    assert len(rows) == 1
    assert rows[0]["is_current"] is True
    assert rows[0]["user_agent"] == "CurrentDevice/1"


@pytest.mark.asyncio
async def test_refresh_updates_last_used_at(client):
    """After a refresh the newly-issued row carries a fresh last_used_at;
    the rotated-out row keeps its own timestamp (audit trail)."""
    tokens = await _register(client)
    access = tokens["access_token"]
    refresh = tokens["refresh_token"]

    before = (
        await client.get(
            "/sessions", headers={"Authorization": f"Bearer {access}"}
        )
    ).json()
    assert len(before) == 1
    initial_last_used = before[0]["last_used_at"]
    initial_id = before[0]["id"]

    # Rotate.
    r_refresh = await client.post(
        "/refresh", json={"refresh_token": refresh}
    )
    assert r_refresh.status_code == 200
    new_access = r_refresh.json()["access_token"]

    after = (
        await client.get(
            "/sessions", headers={"Authorization": f"Bearer {new_access}"}
        )
    ).json()
    # Old row revoked, only the new row is active.
    assert len(after) == 1
    new_row = after[0]
    assert new_row["id"] != initial_id
    assert new_row["last_used_at"] is not None
    # The new row's last_used_at should be >= the original.
    assert new_row["last_used_at"] >= initial_last_used


# ---------------------------------------------------------------------------
# Eine Sitzung sind ZWEI Berechtigungen: Refresh-Token + pulse_session-Cookie.
# Die Tests hier halten die Zusage der Oberflaeche fest ("Sitzung beenden"),
# die vorher nur die Haelfte einloeste — das entfernte Geraet blieb ueber sein
# Cookie angemeldet und durfte damit weiter Geraete-Zertifikate ausstellen.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_session_also_kills_the_browser_cookie(client):
    """Einzel-Widerruf beendet auch das Cookie derselben Anmeldung."""
    own = await client.post("/register", json=REG_PAYLOAD)
    assert own.status_code == 201, own.text
    own_sid = own.cookies["pulse_session"]
    access = own.json()["access_token"]

    other = await _login_response(client, user_agent="OtherDevice/1")
    other_sid = other.cookies["pulse_session"]
    assert await _cookie_alive(client, other_sid)

    target = await _session_id_for_ua(client, access, "OtherDevice/1")
    r = await client.delete(
        f"/sessions/{target}", headers={"Authorization": f"Bearer {access}"}
    )
    assert r.status_code == 204, r.text

    assert not await _cookie_alive(client, other_sid), (
        "das Cookie des beendeten Geraets muss sofort tot sein"
    )
    assert await _cookie_alive(client, own_sid), (
        "die Sitzung des Aufrufers darf der Widerruf nicht mitnehmen"
    )


@pytest.mark.asyncio
async def test_ended_session_cannot_issue_a_device_certificate(client):
    """Der Kern der Zusage: nach dem Widerruf stellt das Geraet nichts mehr aus.

    ``/credentials/issue`` authentifiziert ausschliesslich ueber das Cookie —
    ueberlebt es den Widerruf, kann sich ein gekapertes Geraet weiter frische
    Identitaets-Zertifikate ziehen.
    """
    own = await client.post("/register", json=REG_PAYLOAD)
    access = own.json()["access_token"]
    other = await _login_response(client, user_agent="OtherDevice/1")
    other_sid = other.cookies["pulse_session"]

    target = await _session_id_for_ua(client, access, "OtherDevice/1")
    assert (
        await client.delete(
            f"/sessions/{target}", headers={"Authorization": f"Bearer {access}"}
        )
    ).status_code == 204

    r = await client.post(
        "/credentials/issue",
        json={
            "device_pubkey": base64.b64encode(b"\x07" * 32).decode(),
            "device_label": "gekapert",
        },
        headers={"Cookie": f"pulse_session={other_sid}"},
    )
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_delete_all_sessions_kills_other_cookies_only(client):
    """"Alle anderen beenden" nimmt die fremden Cookies mit, das eigene nicht."""
    await client.post("/register", json=REG_PAYLOAD)
    other = await _login_response(client, user_agent="OtherDevice/1")
    other_sid = other.cookies["pulse_session"]
    mine = await _login_response(client, user_agent="CurrentDevice/1")
    my_sid = mine.cookies["pulse_session"]

    r = await client.delete(
        "/sessions",
        headers={
            "Authorization": f"Bearer {mine.json()['access_token']}",
            "User-Agent": "CurrentDevice/1",
            "Cookie": f"pulse_session={my_sid}",
        },
    )
    assert r.status_code == 200, r.text

    assert not await _cookie_alive(client, other_sid)
    assert await _cookie_alive(client, my_sid)


@pytest.mark.asyncio
async def test_logout_with_refresh_token_kills_the_linked_cookie(client):
    """Abmelden ohne Cookie (Desktop) beendet trotzdem das Cookie der Sitzung."""
    await client.post("/register", json=REG_PAYLOAD)
    device = await _login_response(client, user_agent="Desktop/1")
    sid = device.cookies["pulse_session"]

    r = await client.post(
        "/logout", json={"refresh_token": device.json()["refresh_token"]}
    )
    assert r.status_code == 200, r.text
    assert not await _cookie_alive(client, sid)


@pytest.mark.asyncio
async def test_link_survives_refresh_rotation(client):
    """Nach der Token-Rotation trifft der Widerruf weiterhin beide Haelften."""
    own = await client.post("/register", json=REG_PAYLOAD)
    access = own.json()["access_token"]
    device = await _login_response(client, user_agent="Roaming/1")
    sid = device.cookies["pulse_session"]

    rotated = await client.post(
        "/refresh",
        json={"refresh_token": device.json()["refresh_token"]},
        headers={"User-Agent": "Roaming/1"},
    )
    assert rotated.status_code == 200, rotated.text

    target = await _session_id_for_ua(client, access, "Roaming/1")
    assert (
        await client.delete(
            f"/sessions/{target}", headers={"Authorization": f"Bearer {access}"}
        )
    ).status_code == 204
    assert not await _cookie_alive(client, sid)


@pytest.mark.asyncio
async def test_link_follows_session_renew(client, session_factory):
    """``/session/renew`` haengt die Token auf das neue Cookie um.

    Der Fall der Desktop-App: beim Start liegt nur der Zugriffstoken vor, das
    Cookie ist laengst abgelaufen. Ohne das Umhaengen zeigte die Verknuepfung
    danach auf die tote Vorgaenger-Zeile — und "Sitzung beenden" liefe genau
    fuer die Geraete ins Leere, die am haeufigsten erneuern.
    """
    own = await client.post("/register", json=REG_PAYLOAD)
    access = own.json()["access_token"]
    device = await _login_response(client, user_agent="Desktop/2")

    # Der Ausgangszustand des Falls: das Cookie ist abgelaufen, nur der
    # Zugriffstoken lebt noch. (Ein Gerät, das sein Cookie noch hat, schickt es
    # mit — dann greift der genaue Weg über die Vorgängerkennung.)
    async with session_factory() as db:
        row = await db.get(UserSession, device.cookies["pulse_session"])
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()

    renewed = await client.post(
        "/session/renew",
        headers={
            "Authorization": f"Bearer {device.json()['access_token']}",
            "User-Agent": "Desktop/2",
        },
    )
    assert renewed.status_code == 204, renewed.text
    fresh_sid = renewed.cookies["pulse_session"]
    assert await _cookie_alive(client, fresh_sid)

    target = await _session_id_for_ua(client, access, "Desktop/2")
    assert (
        await client.delete(
            f"/sessions/{target}", headers={"Authorization": f"Bearer {access}"}
        )
    ).status_code == 204
    assert not await _cookie_alive(client, fresh_sid), (
        "das beim Erneuern entstandene Cookie muss mit der Sitzung sterben"
    )


@pytest.mark.asyncio
async def test_refresh_token_reuse_also_kills_the_cookies(client):
    """Wiederverwendung = Diebstahlverdacht: die Cookies der Familie fallen mit."""
    reg = await client.post("/register", json=REG_PAYLOAD)
    device = await _login_response(client, user_agent="Stolen/1")
    sid = device.cookies["pulse_session"]
    reg_sid = reg.cookies["pulse_session"]

    first = await client.post(
        "/refresh", json={"refresh_token": device.json()["refresh_token"]}
    )
    assert first.status_code == 200
    # Zweite Vorlage desselben (bereits rotierten) Tokens -> Familien-Widerruf.
    replay = await client.post(
        "/refresh", json={"refresh_token": device.json()["refresh_token"]}
    )
    assert replay.status_code == 401

    assert not await _cookie_alive(client, sid)
    assert not await _cookie_alive(client, reg_sid)
