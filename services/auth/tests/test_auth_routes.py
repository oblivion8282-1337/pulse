"""Route-level tests for the auth service."""

from __future__ import annotations

import jwt
import pytest


REG_PAYLOAD = {
    "username": "alice",
    "email": "alice@example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_register_returns_tokens(client):
    r = await client.post("/register", json=REG_PAYLOAD)
    assert r.status_code == 201, r.text
    body = r.json()
    assert "access_token" in body and "refresh_token" in body
    assert body["token_type"] == "bearer"
    assert body["access_token"].count(".") == 2


@pytest.mark.asyncio
async def test_first_user_becomes_admin(client):
    """Bootstrap: the very first user on a fresh deploy gets is_admin
    set so the server operator can reach /app/admin without an SQL
    promotion. Subsequent users do not."""
    r1 = await client.post("/register", json=REG_PAYLOAD)
    assert r1.status_code == 201
    claims1 = jwt.decode(
        r1.json()["access_token"], options={"verify_signature": False}
    )
    assert claims1.get("admin") is True

    r2 = await client.post(
        "/register",
        json={**REG_PAYLOAD, "username": "bob", "email": "bob@example.com"},
    )
    assert r2.status_code == 201
    claims2 = jwt.decode(
        r2.json()["access_token"], options={"verify_signature": False}
    )
    # JwtSigner only stamps ``admin`` when True — absent == false.
    assert "admin" not in claims2


@pytest.mark.asyncio
async def test_register_rejects_duplicate(client):
    r1 = await client.post("/register", json=REG_PAYLOAD)
    assert r1.status_code == 201
    r2 = await client.post("/register", json=REG_PAYLOAD)
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_register_username_taken_returns_suggestions(client):
    """Username collision → 409 with detail={error, suggestions}.
    Suggestions are free, fit the username pattern, start with the
    requested base, and there's at least one."""
    r1 = await client.post("/register", json=REG_PAYLOAD)
    assert r1.status_code == 201
    # Same username, different email so only username collides.
    r2 = await client.post(
        "/register",
        json={**REG_PAYLOAD, "email": "other@dcc-test.example.com"},
    )
    assert r2.status_code == 409
    detail = r2.json()["detail"]
    assert detail["error"] == "username_taken"
    suggestions = detail["suggestions"]
    assert isinstance(suggestions, list)
    assert len(suggestions) >= 1
    base = REG_PAYLOAD["username"]
    import re

    pat = re.compile(r"^[a-zA-Z0-9_.-]{3,32}$")
    for s in suggestions:
        assert s.startswith(base)
        assert pat.match(s), s


@pytest.mark.asyncio
async def test_register_email_taken_returns_error(client):
    """Email collision (different username) → 409 with error=email_taken,
    no suggestions (those are for the username case)."""
    r1 = await client.post("/register", json=REG_PAYLOAD)
    assert r1.status_code == 201
    r2 = await client.post(
        "/register",
        json={**REG_PAYLOAD, "username": "different_handle"},
    )
    assert r2.status_code == 409
    detail = r2.json()["detail"]
    assert detail["error"] == "email_taken"
    assert "suggestions" not in detail


@pytest.mark.asyncio
async def test_register_rejects_invalid_username(client):
    bad = {**REG_PAYLOAD, "username": "a"}  # too short
    r = await client.post("/register", json=bad)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_register_rejects_short_password(client):
    bad = {**REG_PAYLOAD, "password": "1234567"}
    r = await client.post("/register", json=bad)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_login_with_email(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/login",
        json={"email_or_username": REG_PAYLOAD["email"], "password": REG_PAYLOAD["password"]},
    )
    assert r.status_code == 200
    assert r.json()["access_token"]


@pytest.mark.asyncio
async def test_login_with_username(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/login",
        json={"email_or_username": REG_PAYLOAD["username"], "password": REG_PAYLOAD["password"]},
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_login_invalid_password(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/login",
        json={"email_or_username": REG_PAYLOAD["email"], "password": "wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_unknown_user(client):
    r = await client.post(
        "/login",
        json={"email_or_username": "ghost@nowhere", "password": "12345678"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_requires_bearer(client):
    r = await client.get("/me")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_returns_user(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    r = await client.get("/me", headers={"Authorization": f"Bearer {reg['access_token']}"})
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == REG_PAYLOAD["username"]
    assert body["email"] == REG_PAYLOAD["email"]
    # id must be string-serialized
    assert isinstance(body["id"], str)
    assert body["id"].isdigit()


@pytest.mark.asyncio
async def test_me_rejects_invalid_token(client):
    r = await client.get("/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_jwks_endpoint(client):
    r = await client.get("/.well-known/jwks.json")
    assert r.status_code == 200
    body = r.json()
    assert "keys" in body and len(body["keys"]) == 1
    k = body["keys"][0]
    assert k["kty"] == "RSA"
    assert k["alg"] == "RS256"
    assert "n" in k and "e" in k


@pytest.mark.asyncio
async def test_access_token_payload(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    # Decode without verification just to look at claims.
    payload = jwt.decode(tokens["access_token"], options={"verify_signature": False})
    assert payload["typ"] == "access"
    assert payload["username"] == REG_PAYLOAD["username"]
    assert payload["aud"] == "dcc"


@pytest.mark.asyncio
async def test_refresh_rotation(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    old_refresh = tokens["refresh_token"]

    r = await client.post("/refresh", json={"refresh_token": old_refresh})
    assert r.status_code == 200
    new_tokens = r.json()
    assert new_tokens["refresh_token"] != old_refresh

    # Der alte Token dreht nicht ein zweites Mal: er gibt denselben Nachfolger
    # heraus, den er schon herausgegeben hat. Was daran haengt — und warum er
    # ueberhaupt noch etwas herausgibt statt die Sitzung zu beenden — steht in
    # ``test_refresh_familie.py``.
    r2 = await client.post("/refresh", json={"refresh_token": old_refresh})
    assert r2.status_code == 200
    assert r2.json()["refresh_token"] == new_tokens["refresh_token"]


@pytest.mark.asyncio
async def test_refresh_rejects_access_token(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    r = await client.post("/refresh", json={"refresh_token": tokens["access_token"]})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_logout_revokes_refresh(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    r = await client.post("/logout", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 200
    # subsequent refresh fails
    r2 = await client.post("/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r2.status_code == 401


@pytest.mark.asyncio
async def test_logout_is_idempotent(client):
    r = await client.post("/logout", json={"refresh_token": "garbage"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_rate_limit_register(client):
    # rule = 5/minute by default
    for i in range(5):
        payload = {**REG_PAYLOAD, "username": f"alice{i}", "email": f"a{i}@ex.com"}
        r = await client.post("/register", json=payload)
        assert r.status_code == 201, f"iter {i}: {r.text}"
    over = {**REG_PAYLOAD, "username": "alice5", "email": "a5@ex.com"}
    r = await client.post("/register", json=over)
    assert r.status_code == 429


# ---- GET /users (batch lookup) -------------------------------------------


@pytest.mark.asyncio
async def test_batch_users_requires_auth(client):
    r = await client.get("/users?ids=123")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_batch_users_returns_known_ids(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    # /me to get our own id
    me = (await client.get("/me", headers={"Authorization": f"Bearer {token}"})).json()
    own_id = me["id"]

    r = await client.get(f"/users?ids={own_id}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["id"] == own_id
    assert body[0]["username"] == REG_PAYLOAD["username"]
    # email must NOT appear in UserSummary
    assert "email" not in body[0]


@pytest.mark.asyncio
async def test_batch_users_unknown_id_omitted(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    r = await client.get("/users?ids=999999999999", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_batch_users_too_many_ids(client):
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    ids = ",".join(str(i) for i in range(101))
    r = await client.get(f"/users?ids={ids}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_batch_users_rate_limited(client):
    # Security-Scan 2026-09-18: /users?ids= war ungedrosselt — Snowflake-
    # Walking hätte das Nutzerverzeichnis en masse harvesten können.
    # 30/min pro IP wie user_search; der 429 darf auch vom engeren
    # per-Account-Bucket (rate_limit_per_account, 10/min) kommen.
    reg = (await client.post("/register", json=REG_PAYLOAD)).json()
    token = reg["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    r = None
    for _ in range(31):
        r = await client.get("/users?ids=1", headers=headers)
        if r.status_code == 429:
            break
    assert r is not None and r.status_code == 429


@pytest.mark.asyncio
async def test_batch_users_no_email_in_response(client):
    # Register two users, look up the second from the first's perspective.
    r1 = (await client.post("/register", json=REG_PAYLOAD)).json()
    r2 = (await client.post(
        "/register",
        json={**REG_PAYLOAD, "username": "bob", "email": "bob@dcc-test.example.com"},
    )).json()
    token1 = r1["access_token"]
    token2 = r2["access_token"]
    me2 = (await client.get("/me", headers={"Authorization": f"Bearer {token2}"})).json()
    id2 = me2["id"]

    r = await client.get(f"/users?ids={id2}", headers={"Authorization": f"Bearer {token1}"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert "email" not in body[0]


# --- Refresh-Cookie (Security-Audit 2026-09-16) -----------------------------
# Der 30-Tage-Refresh-Token reist im HttpOnly-``pulse_rt``-Cookie statt im
# localStorage des Browsers. Geprüft: Cookie bei Anmeldung gesetzt, /refresh
# akzeptiert ihn als Credential (Token im Koerper bleibt dann LEER — nichts
# Exfiltrierbares in der Antwort), tote Kette löscht den Cookie, Logout ohne
# Body-Token widerruft die Cookie-Kette.


@pytest.mark.asyncio
async def test_login_setzt_refresh_cookie(client):
    tokens = (await client.post("/register", json=REG_PAYLOAD)).json()
    # Register schließt den Login ein — der Cookie muss am Response hängen.
    # (Der Test-Client läuft http://,Secure-Cookies werden also nicht automatisch
    # mitgeschickt — deshalb überall der explizite Cookie-Header wie bei den
    # pulse_session-Tests.)
    setc = client.cookies.get("pulse_rt", "")
    assert setc, "pulse_rt-Cookie fehlt nach der Anmeldung"
    # Und der Cookie ist genau der Token aus dem Koerper (dieser Pfad liefert
    # ihn noch aus — Alt-Klienten-Migration).
    assert setc == tokens["refresh_token"]


def _cookie_header(client, name: str) -> dict[str, str]:
    wert = client.cookies.get(name, "")
    return {"Cookie": f"{name}={wert}"} if wert else {}


@pytest.mark.asyncio
async def test_refresh_mit_cookie_ohne_body_token(client):
    await client.post("/register", json=REG_PAYLOAD)
    cookie_token = client.cookies.get("pulse_rt")
    assert cookie_token

    r = await client.post("/refresh", json={}, headers=_cookie_header(client, "pulse_rt"))
    assert r.status_code == 200, r.text
    data = r.json()
    # Cookie-Weg: der neue Token steht NUR im (rotierten) Cookie, nicht im
    # Koerper — ein XSS kann ihn aus der Antwort nicht abgreifen.
    assert data["refresh_token"] == ""
    assert data["access_token"]
    # Der Cookie wurde rotiert: der alte Wert ist als Credential verbraucht.
    neu = client.cookies.get("pulse_rt")
    assert neu not in (None, "", cookie_token)
    # Ein zweiter Versuch mit dem ALTEN Wert im Body ist die Wiedervorlage-
    # Logik (Nachreichen desselben Nachfolgers) — KEIN frischer Doppelzugriff.
    r2 = await client.post("/refresh", json={"refresh_token": cookie_token})
    assert r2.status_code == 200
    assert r2.json()["refresh_token"] == client.cookies.get("pulse_rt")


@pytest.mark.asyncio
async def test_refresh_ohne_alles_401(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post("/refresh", json={})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_logout_ohne_body_widerruft_cookie_kette(client):
    await client.post("/register", json=REG_PAYLOAD)
    cookie_token = client.cookies.get("pulse_rt")
    assert cookie_token

    r = await client.post("/logout", json={}, headers=_cookie_header(client, "pulse_rt"))
    assert r.status_code == 200
    # Cookie weg ...
    assert not client.cookies.get("pulse_rt")
    # ... und die Kette hinter dem Cookie ist tot: der Token aus dem Cookie
    # (im Body vorgelegt, wie ein Dieb es täte) kommt nicht mehr durch.
    r2 = await client.post("/refresh", json={"refresh_token": cookie_token})
    assert r2.status_code == 401


@pytest.mark.asyncio
async def test_refresh_kaputter_cookie_loescht_cookie(client):
    await client.post("/register", json=REG_PAYLOAD)
    r = await client.post(
        "/refresh", json={}, headers={"Cookie": "pulse_rt=kein.jwt"}
    )
    assert r.status_code == 401
    # Der Server fordert den Browser per Max-Age=0 zum Löschen auf.
    alle = r.headers.get_list("set-cookie") if hasattr(r.headers, "get_list") else [r.headers.get("set-cookie", "")]
    assert any("pulse_rt" in h and ("Max-Age=0" in h or "max-age=0" in h) for h in alle), alle
