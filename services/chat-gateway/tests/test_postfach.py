"""Das Postfach: Nutzlast und Zustellung getrennt."""

from __future__ import annotations

import base64
import json
import random
import time

import jwt as pyjwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dcc_chat_gateway.pubsub_channels import CHANNEL_KEY
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast

pytestmark = pytest.mark.usefixtures("cloud_mode")

# ---------------------------------------------------------------------------
# Nachweis-Helfer — derselbe Weg wie test_schluessel.py: ein echtes
# Ed25519-Geraetepaar und ein echtes, RS256-signiertes Identitaets-Zertifikat.
# ---------------------------------------------------------------------------

_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-postfach-key-1"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _jwks_json() -> str:
    nums = _RSA_KEY.public_key().public_numbers()

    def _b64(n: int) -> str:
        bl = (n.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(n.to_bytes(bl, "big")).rstrip(b"=").decode()

    return json.dumps({
        "keys": [{
            "kty": "RSA", "use": "sig", "alg": "RS256", "kid": _KID,
            "n": _b64(nums.n), "e": _b64(nums.e),
        }]
    })


def _make_device() -> tuple[Ed25519PrivateKey, str]:
    priv = Ed25519PrivateKey.generate()
    return priv, _b64url(priv.public_key().public_bytes_raw())


def _make_cert(*, user_id: str, device_pubkey: str, cert_id: str = "cert-1") -> str:
    now = int(time.time())
    payload = {
        "iss": "https://howispulse.com",
        "aud": "dcc",
        "typ": "credential",
        "cert_id": cert_id,
        "user_id": user_id,
        "device_pubkey": device_pubkey,
        "device_label": "Testgeraet",
        "pairwise_seed": _b64url(b"\xab" * 32),
        "amr": ["pwd"],
        "acr": "1",
        "iat": now,
        "exp": now + 3600,
    }
    return pyjwt.encode(payload, _RSA_KEY, algorithm="RS256", headers={"kid": _KID})


def _sign(priv: Ed25519PrivateKey, nutzlast: bytes) -> str:
    return _b64url(priv.sign(nutzlast))


async def _seed_jwks(app) -> None:
    await app.state.redis.set("auth:jwks:cached", _jwks_json())


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _dm_erstellen(client, token_a: str, uid_b: int) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _bundel_seeden(session_factory, *, user_id: int, device_pubkey: str) -> None:
    """Legt ein Empfaenger-Buendel direkt in die DB — Task 2 prueft das
    EINLIEFERN, nicht das Veroeffentlichen (Task 2 der Etappe B)."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=next_id(), user_id=user_id, device_pubkey=device_pubkey,
                curve25519="curve-" + device_pubkey, signatur="sig-" + device_pubkey,
                cert_id="cert-" + device_pubkey,
            )
        )
        await s.commit()


async def _einliefern(
    client, app, *, token: str, uid: int, channel_id: str,
    nutzlasten: list[dict],
):
    """Baut Zertifikat + Unterschrift des Sendegeraets und liefert ein."""
    await _seed_jwks(app)
    priv, pubkey = _make_device()
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    daten_liste = [n["daten"] for n in nutzlasten]
    sig = _sign(priv, baue_nutzlast("postfach", str(channel_id), *daten_liste))
    r = await client.post(
        "/postfach",
        json={
            "channel_id": str(channel_id), "cert": cert, "signatur": sig,
            "nutzlasten": nutzlasten,
        },
        headers=_auth(token),
    )
    return r


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung — derselbe Weg wie in ``test_schluessel.py``. Die
    Test-Engine nutzt ``StaticPool`` (eine geteilte In-Memory-Verbindung),
    deshalb genuegt ein einmaliges PRAGMA auf dieser einen Verbindung.
    """
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_eine_nutzlast_traegt_mehrere_zustellungen(session_factory):
    """Der Gruppenfall. Megolm verschluesselt EINMAL fuer alle — ohne diese
    Trennung muesste derselbe Umschlag je Geraet kopiert werden, und bei
    zwanzig Mitgliedern mit je zwei Geraeten waeren das vierzig Kopien
    derselben Bytes.
    """
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import select

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="umschlag", groesse=8,
        ))
        for pubkey in ("G1", "G2", "G3"):
            s.add(DmZustellung(
                id=next_id(), nutzlast_id=nid,
                empfaenger_device_pubkey=pubkey, empfaenger_user_id=2,
            ))
        await s.commit()

    async with session_factory() as s:
        zustellungen = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert len(zustellungen) == 3


@pytest.mark.asyncio
async def test_zustellungen_verschwinden_mit_ihrer_nutzlast(session_factory):
    """Eine Zustellung ohne Nutzlast ist ein Zeiger ins Leere."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import delete, select

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid,
            empfaenger_device_pubkey="G1", empfaenger_user_id=2,
        ))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DmNutzlast).where(DmNutzlast.id == nid))
        await s.commit()

    async with session_factory() as s:
        rest = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert rest == []


# ---------------------------------------------------------------------------
# Task 2 — Einliefern
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_einliefern_legt_je_empfaenger_eine_zustellung_an(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Eine Nutzlast, drei Empfaengergeraete -> drei Zustellungen."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    for i in range(3):
        await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=f"empf-{i}")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{
            "art": 1, "daten": daten,
            "empfaenger": ["empf-0", "empf-1", "empf-2"],
        }],
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        nutzlasten = (await s.execute(select(DmNutzlast))).scalars().all()
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(nutzlasten) == 1
        assert len(zustellungen) == 3
        assert {z.empfaenger_device_pubkey for z in zustellungen} == {
            "empf-0", "empf-1", "empf-2",
        }


@pytest.mark.asyncio
async def test_fremder_kanal_wird_abgewiesen(client, app, _auth_signer):
    """Wer im Kanal nichts zu suchen hat, liefert auch nichts ein.
    Dieselbe Regel wie beim Klartext-Senden — NICHT eine neue erfinden."""
    token_a, uid_a = await _register(_auth_signer)
    fremder_kanal = "999999999999999999"

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=fremder_kanal,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["irgendein-geraet"]}],
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_zu_grosser_umschlag_wird_abgewiesen(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings,
    monkeypatch,
):
    """Ohne Obergrenze ist das Postfach ein kostenloser Dateispeicher, und
    zwar einer, dessen Inhalt niemand pruefen kann."""
    # ``monkeypatch`` statt Direktzuweisung: die Einstellung ist ein
    # Modul-Singleton (``_TEST_SETTINGS``) und wuerde sonst in die naechsten
    # Tests dieser Datei durchsickern.
    monkeypatch.setattr(_isolate_chat_settings, "postfach_max_umschlag_bytes", 4)

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-gross")

    daten = base64.b64encode(b"das ist deutlich mehr als vier bytes").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-gross"]}],
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_unbekanntes_empfaengergeraet_wird_uebergangen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Ein Pubkey ohne Buendel im Verzeichnis erzeugt keine Zustellung —
    aber auch keinen Fehler fuer die uebrigen Empfaenger. Ein Geraet kann
    zwischen Abholen der Schluessel und Absenden abgemeldet worden sein;
    das ist Alltag, kein Fehler."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-bekannt")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{
            "art": 1, "daten": daten,
            "empfaenger": ["empf-bekannt", "empf-unbekannt"],
        }],
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(zustellungen) == 1
        assert zustellungen[0].empfaenger_device_pubkey == "empf-bekannt"


@pytest.mark.asyncio
async def test_einliefern_weckt_die_empfaenger(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Ohne Weckruf merkt ein offener Klient nichts, bis er zufaellig
    nachsieht."""
    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-weckruf")

    pubsub = app.state.redis.pubsub()
    await pubsub.subscribe(CHANNEL_KEY.format(channel_id=dm_id))
    try:
        daten = base64.b64encode(b"olm-umschlag").decode()
        r = await _einliefern(
            client, app, token=token_a, uid=uid_a, channel_id=dm_id,
            nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-weckruf"]}],
        )
        assert r.status_code == 204, r.text

        empfangen = None
        for _ in range(20):
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg is not None:
                empfangen = json.loads(msg["data"])
                break
        assert empfangen is not None, "kein Weckruf empfangen"
        assert empfangen["op"] == "postfach_neu"
        assert empfangen["channel_id"] == str(dm_id)
        assert empfangen["anzahl"] == 1
        # Nie einen Umschlag im Weckruf — sonst laege der Inhalt in Redis.
        assert "daten" not in empfangen and "nutzlasten" not in empfangen
    finally:
        await pubsub.unsubscribe(CHANNEL_KEY.format(channel_id=dm_id))
        await pubsub.aclose()
