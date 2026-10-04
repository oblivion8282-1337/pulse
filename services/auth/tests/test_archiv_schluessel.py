"""Tests für die Archiv-Schlüssel-Endpunkte (Übergabe 2026-10-04 §5):
Erstanlage (PUT), Lesen (GET), Re-Wrap (PATCH), Reset-Re-Wrap und den
internen Public-Key-Weg für chat-gateway."""

from __future__ import annotations

import base64
import random

import pytest
from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_SCHRANK = base64.b64encode(b"schrank-geheimnis-32-bytes!!!!!!").decode()
_PRIV = X25519PrivateKey.generate()
_PRIV_RAW = _PRIV.private_bytes_raw()
_PUB_RAW = _PRIV.public_key().public_bytes_raw()
_SALT = b"0123456789abcdef"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


async def _register_and_login(client) -> tuple[dict[str, str], str, str]:
    """Registriert ein Konto, meldet an → (Bearer-Header, E-Mail, Passwort)."""
    uid = random.randint(1, 1_000_000)
    email = f"archiv{uid}@dcc-test.example.com"
    passwort = "richtig gutes passwort 42"
    await client.post(
        "/register",
        json={
            "username": f"archiv{uid}",
            "email": email,
            "password": passwort,
            "display_name": "Archiv Tester",
        },
    )
    r = await client.post("/login", json={"email_or_username": email, "password": passwort})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, email, passwort


def _wrap_kdf(password: str, salt: bytes = _SALT) -> bytes:
    """So wickelt der Klient — exakt dieselben Argon2id-Parameter, die der
    Server beim Reset-Re-Wrap verwenden muss (t=3, 64 MiB, p=1, 32 Bytes)."""
    kek = hash_secret_raw(
        secret=password.encode(),
        salt=salt,
        time_cost=3,
        memory_cost=64 * 1024,
        parallelism=1,
        hash_len=32,
        type=Type.ID,
    )
    nonce = b"A" * 12
    return nonce + AESGCM(kek).encrypt(nonce, _PRIV_RAW, b"pulse-archiv-kdf")


def _anlage(passwort: str) -> dict[str, str]:
    return {
        "pubkey_b64": _b64(_PUB_RAW),
        "kdf_salt_b64": _b64(_SALT),
        "wrap_kdf_b64": _b64(_wrap_kdf(passwort)),
        "privkey_b64": _b64(_PRIV_RAW),
    }


@pytest.fixture
def schrank_an(_isolate_settings):
    _isolate_settings.archiv_schrank_secret = _SCHRANK
    return _isolate_settings


@pytest.mark.asyncio
async def test_anlage_lesen_409_bei_doppelt(client, schrank_an):
    heads, _, passwort = await _register_and_login(client)
    r = await client.put("/me/archiv-schluessel", json=_anlage(passwort), headers=heads)
    assert r.status_code == 204, r.text

    r = await client.get("/me/archiv-schluessel", headers=heads)
    assert r.status_code == 200
    body = r.json()
    assert body["pubkey_b64"] == _b64(_PUB_RAW)
    # Der private Schlüssel und der Schrank-Wrap gehen NICHT raus.
    assert "privkey" not in body and "wrap_schrank" not in body

    # Zweite Anlage = 409 (Public-Key ist unveränderlich ohne Re-Wrap).
    r = await client.put("/me/archiv-schluessel", json=_anlage(passwort), headers=heads)
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_anlage_ohne_schrank_geheimnis_503(client, _isolate_settings):
    _isolate_settings.archiv_schrank_secret = None
    heads, _, passwort = await _register_and_login(client)
    r = await client.put("/me/archiv-schluessel", json=_anlage(passwort), headers=heads)
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_rewrap_taucht_passwort_wrap(client, schrank_an):
    heads, _, passwort = await _register_and_login(client)
    await client.put("/me/archiv-schluessel", json=_anlage(passwort), headers=heads)
    neues_salt = b"ffffffffffffffff"
    r = await client.patch(
        "/me/archiv-schluessel",
        json={
            "kdf_salt_b64": _b64(neues_salt),
            "wrap_kdf_b64": _b64(_wrap_kdf("neu-passwort", neues_salt)),
        },
        headers=heads,
    )
    assert r.status_code == 204
    body = (await client.get("/me/archiv-schluessel", headers=heads)).json()
    assert body["kdf_salt_b64"] == _b64(neues_salt)


@pytest.mark.asyncio
async def test_reset_rewickelt_auf_neues_passwort(client, schrank_an, monkeypatch):
    """Der E-Mail-Reset wickelt serverseitig neu: danach öffnet das NEUE
    Passwort den wrap_kdf (Argon2id, dieselben Parameter) und der private
    Schlüssel ist unverändert — nichts verloren (§5.3)."""
    heads, email, passwort = await _register_and_login(client)
    await client.put("/me/archiv-schluessel", json=_anlage(passwort), headers=heads)

    from dcc_auth import routes_recovery

    erfasst: dict[str, str] = {}
    echt_compose = routes_recovery.compose_password_reset_email

    def _spy_compose(to, url):
        erfasst["url"] = url
        return echt_compose(to, url)

    monkeypatch.setattr(routes_recovery, "compose_password_reset_email", _spy_compose)
    await client.post("/password/forgot", json={"email_or_username": email})
    assert "url" in erfasst, "keine Reset-Mail gebaut"
    neues_pw = "archiv reset passwort 2"
    r = await client.post(
        "/password/reset",
        json={"token": erfasst["url"].rsplit("/", 1)[1], "new_password": neues_pw},
    )
    assert r.status_code == 200, r.text

    # Mit dem neuen Passwort anmelden und den Stand holen.
    r = await client.post("/login", json={"email_or_username": email, "password": neues_pw})
    assert r.status_code == 200, r.text
    heads = {"Authorization": f"Bearer {r.json()['access_token']}"}
    body = (await client.get("/me/archiv-schluessel", headers=heads)).json()

    # Der neue Wrap öffnet mit dem NEUEN Passwort und ergibt denselben
    # privaten Schlüssel.
    salt = base64.b64decode(body["kdf_salt_b64"])
    wrap = base64.b64decode(body["wrap_kdf_b64"])
    kek = hash_secret_raw(
        secret=neues_pw.encode(),
        salt=salt,
        time_cost=3,
        memory_cost=64 * 1024,
        parallelism=1,
        hash_len=32,
        type=Type.ID,
    )
    priv = AESGCM(kek).decrypt(wrap[:12], wrap[12:], b"pulse-archiv-kdf")
    assert priv == _PRIV_RAW


@pytest.mark.asyncio
async def test_interner_pubkey_weg(client, schrank_an, _isolate_settings):
    _isolate_settings.internal_service_secret = "intern-test"
    heads, _, passwort = await _register_and_login(client)
    await client.put("/me/archiv-schluessel", json=_anlage(passwort), headers=heads)

    me = (await client.get("/me", headers=heads)).json()
    eigene_id = str(me["id"])
    kopf = {"X-Pulse-Internal-Secret": "intern-test"}

    r = await client.get(f"/internal/archiv-schluessel/pubkey/{eigene_id}", headers=kopf)
    assert r.status_code == 200
    assert r.json()["pubkey_b64"] == _b64(_PUB_RAW)

    # Konto ohne Archiv → 200 mit null (chat-gateway gated die Partnerschaft).
    r = await client.get("/internal/archiv-schluessel/pubkey/999999999", headers=kopf)
    assert r.status_code == 200
    assert r.json()["pubkey_b64"] is None

    # Ohne internes Geheimnis: 401.
    r = await client.get(f"/internal/archiv-schluessel/pubkey/{eigene_id}")
    assert r.status_code == 401
