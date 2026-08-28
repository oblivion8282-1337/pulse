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


def _b64_unpadded(data: bytes) -> str:
    """Wie der Krypto-Kern kodiert (vodozemacs ``STANDARD_NO_PAD``, s.
    Modul-Docstring von ``krypto/pulse-krypto``) — OHNE Fuellzeichen.

    Bughunt 2026-08-28, FIX 2: alle bisherigen ``daten``-Werte dieser Datei
    kamen aus Pythons EIGENEM, gepolstertem ``base64.b64encode`` — und trafen
    dabei zufaellig immer eine Byte-Laenge, die durch drei teilbar ist (bei
    ``b"olm-umschlag"`` und der 36 Byte langen Grossnutzlast), also nie einen
    Fall, in dem Padding ueberhaupt fehlt. Ein Test, der seine Eingabe selbst
    (falsch) erzeugt, prueft nur die eigene Kodierung, nie die der
    Gegenseite — genau diese Kodierung erzeugt jetzt EHRLICH unpolsterte
    Nutzlasten, wie sie der Klient wirklich schickt."""
    return base64.b64encode(data).rstrip(b"=").decode()


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


@pytest_asyncio.fixture(autouse=True)
async def _redis_fixture_daten_aufraeumen(app):
    """``_seed_jwks`` schreibt unter dem ECHTEN Produktions-Key
    ``auth:jwks:cached`` in ein reales Redis — dasselbe ``dcc_night_redis``,
    das auch der lokale Dev-Stack und die Playwright-E2E-Suite benutzen (s.
    CLAUDE.md „Port-Mapping"). Ohne Aufraeumen ueberlebt die Fixture-JWKS den
    Testlauf: jeder echte Aufrufer, der denselben Redis-Index trifft, sieht
    danach ``test-postfach-key-1`` statt der echten Cloud-JWKS und jedes echte
    Zertifikat schlaegt mit 403 fehl."""
    yield
    await app.state.redis.delete("auth:jwks:cached")


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


async def _einliefern_mit_geraet(
    client, app, *, token: str, uid: int, channel_id: str,
    nutzlasten: list[dict], priv: Ed25519PrivateKey, pubkey: str,
):
    """Wie ``_einliefern``, aber mit einem VORGEGEBENEN Sendegeraet statt
    einem frisch erzeugten je Aufruf — noetig, um mehrere Einlieferungen
    DESSELBEN Absendegeraets nachzustellen (FIX 3: die Fairness-Grenze
    haengt am Sendegeraet, nicht an der Anfrage)."""
    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    daten_liste = [n["daten"] for n in nutzlasten]
    sig = _sign(priv, baue_nutzlast("postfach", str(channel_id), *daten_liste))
    return await client.post(
        "/postfach",
        json={
            "channel_id": str(channel_id), "cert": cert, "signatur": sig,
            "nutzlasten": nutzlasten,
        },
        headers=_auth(token),
    )


async def _abholen(
    client, app, *, token: str, uid: int, priv: Ed25519PrivateKey, pubkey: str
):
    """Baut Zertifikat + Unterschrift des ABHOLENDEN Geraets und ruft ab."""
    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    sig = _sign(priv, baue_nutzlast("postfach-abholen"))
    return await client.post(
        "/postfach/abholen", json={"cert": cert, "signatur": sig}, headers=_auth(token)
    )


async def _quittieren(
    client, app, *, token: str, uid: int, priv: Ed25519PrivateKey, pubkey: str,
    zustellung_ids: list[str],
):
    """Baut Zertifikat + Unterschrift des QUITTIERENDEN Geraets und quittiert."""
    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    sig = _sign(
        priv, baue_nutzlast("postfach-quittung", *[str(i) for i in zustellung_ids])
    )
    return await client.post(
        "/postfach/quittung",
        json={
            "cert": cert, "signatur": sig,
            "zustellung_ids": [str(i) for i in zustellung_ids],
        },
        headers=_auth(token),
    )


async def _bundel_seeden_echtes_geraet(
    session_factory, *, user_id: int
) -> tuple[Ed25519PrivateKey, str]:
    """Wie ``_bundel_seeden``, aber mit einem echten Ed25519-Schluesselpaar —
    fuer Tests, die als dieses Geraet spaeter selbst signieren muessen
    (Abholen/Quittieren), statt nur eine Zeichenkette als Pubkey zu haben."""
    priv, pubkey = _make_device()
    await _bundel_seeden(session_factory, user_id=user_id, device_pubkey=pubkey)
    return priv, pubkey


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

    # UNPOLSTERTE Kodierung + eine Byte-Laenge, die NICHT durch drei teilbar
    # ist (13 Bytes) — der einzige Fall, in dem der Nachweis eines fehlenden
    # ``+= "=="`` in ``_envelope_groesse`` ueberhaupt greifen kann (FIX 2).
    daten = _b64_unpadded(b"olm-umschlag1")
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{
            "art": 1, "daten": daten,
            "empfaenger": ["empf-0", "empf-1", "empf-2"],
        }],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 3
    assert body["uebersprungene_empfaenger"] == []
    assert body["verworfene_nutzlasten"] == 0

    async with session_factory() as s:
        nutzlasten = (await s.execute(select(DmNutzlast))).scalars().all()
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(nutzlasten) == 1
        # Die unpolsterte Eingabe muss trotzdem auf die ECHTE Byte-Laenge
        # decodieren — nur so entlarvt dieser Test einen fehlenden
        # Polsterungs-Nachtrag in ``_envelope_groesse`` (FIX 2).
        assert nutzlasten[0].groesse == len(b"olm-umschlag1")
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

    # Unpolstert und eine Byte-Laenge, die NICHT durch drei teilbar ist —
    # dieselbe Begruendung wie beim Accept-Fall oben (FIX 2): nur dann
    # deckt dieser Test einen fehlenden Polsterungs-Nachtrag in
    # ``_envelope_groesse`` ueberhaupt auf.
    daten = _b64_unpadded(b"das ist deutlich mehr als vier bytes!")
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
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 1
    assert body["uebersprungene_empfaenger"] == ["empf-unbekannt"]
    assert body["verworfene_nutzlasten"] == 0

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
        assert r.status_code == 200, r.text

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


@pytest.mark.asyncio
async def test_zustellung_an_ein_kanalfremdes_geraet_wird_abgewiesen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Die Kanalpruefung belegt, WO geschrieben werden darf — nicht, an WEN.

    Die Empfaengerkennungen kommen aus dem Anfrage-Rumpf. Ohne diese Pruefung
    koennte jeder mit einer einzigen legitimen DM Umschlaege in das Postfach
    JEDES Geraets JEDES Nutzers legen — auch von Leuten, die ihn geblockt
    haben — und dabei deren Kontingent vollschreiben. Gemeldet von der
    Sicherheitspruefung am 2026-08-28.

    Kein stilles Ueberspringen wie beim unbekannten Geraet: ein fremdes Geraet
    ist kein Alltagsfall, sondern ein Klientenfehler oder ein Angriff.
    """
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Ein Geraet des Gespraechspartners und eines eines voellig Unbeteiligten.
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-ok")
    await _bundel_seeden(session_factory, user_id=uid_fremd, device_pubkey="empf-fremd")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-ok", "empf-fremd"]}],
    )
    assert r.status_code == 403, r.text
    assert "empfaenger_nicht_im_kanal" in r.text

    # Und nichts davon darf geschrieben worden sein — auch nicht die
    # zulaessige Haelfte derselben Anfrage.
    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []
        assert (await s.execute(select(DmZustellung))).scalars().all() == []


@pytest.mark.asyncio
async def test_alle_empfaenger_uebersprungen_wird_gemeldet_statt_still_204(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings, monkeypatch
):
    """FIX 1. Sind ALLE angefragten Empfaenger einer Nutzlast uebersprungen
    (hier: Kontingent voll), entsteht nirgends eine Zeile — ein unbedingtes
    ``204`` liesse den Absender glauben, die Nachricht sei zugestellt. Die
    Antwort muss das ehrlich melden."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from sqlalchemy import select

    monkeypatch.setattr(_isolate_chat_settings, "postfach_max_offene_zustellungen_je_geraet", 0)

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey="empf-voll")

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-voll"]}],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zustellungen_angelegt"] == 0
    assert body["uebersprungene_empfaenger"] == ["empf-voll"]
    assert body["verworfene_nutzlasten"] == 1

    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []
        assert (await s.execute(select(DmZustellung))).scalars().all() == []


@pytest.mark.asyncio
async def test_kollidierender_pubkey_unter_fremdem_konto_bricht_die_anfrage_nicht(
    client, app, session_factory, _auth_signer, friend_pair
):
    """FIX 2. Die DB-Eindeutigkeit ist das Paar ``(user_id, device_pubkey)``
    (``UniqueConstraint`` in ``models/geraete_schluessel.py``), NICHT der
    Pubkey allein — zwei Konten koennen theoretisch denselben Pubkey fuehren,
    z. B. ein geloeschtes und neu registriertes Konto mit demselben lokal
    gespeicherten Geraeteschluessel. Eine ungescopte Suche wirft dann
    ``MultipleResultsFound`` und reisst die ganze Anfrage mit sich — auch die
    Zustellung an einen voellig unbeteiligten, echten Empfaenger im selben
    Kanal."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    _, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    pubkey = "kollidierend"
    await _bundel_seeden(session_factory, user_id=uid_b, device_pubkey=pubkey)
    await _bundel_seeden(session_factory, user_id=uid_fremd, device_pubkey=pubkey)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pubkey]}],
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        zustellungen = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(zustellungen) == 1
        assert zustellungen[0].empfaenger_user_id == uid_b


@pytest.mark.asyncio
async def test_zu_viele_empfaenger_je_nutzlast_wird_abgelehnt(client, app, _auth_signer):
    """FIX 4, defence in depth. ``empfaenger`` hatte keine Obergrenze —
    anders als ``nutzlasten`` (settings-gepruefte 100 je Anfrage). Analog zu
    ``user_ids`` (``schemas.py``, max_length=64)."""
    token_a, _ = await _register(_auth_signer)
    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await client.post(
        "/postfach",
        json={
            "channel_id": "1", "cert": "x", "signatur": "y",
            "nutzlasten": [{
                "art": 1, "daten": daten,
                "empfaenger": [f"pub-{i}" for i in range(65)],
            }],
        },
        headers=_auth(token_a),
    )
    assert r.status_code == 422, r.text


def test_envelope_groesse_verlangt_den_polsterungs_nachtrag() -> None:
    """FIX 2 (Bughunt 2026-08-28). Ein direkter Nachweis auf
    ``_envelope_groesse`` selbst — nicht ueber die Route —, weil genau HIER
    der Fehler sass, den die uebrigen Tests dieser Datei nie sehen konnten:
    sie bauen ihre ``daten`` alle mit Pythons EIGENEM, GEPOLSTERTEM
    ``b64encode`` (statt dem unpolsterten ``STANDARD_NO_PAD`` des
    Krypto-Kerns, s. Modul-Docstring ``krypto/pulse-krypto``) und trafen
    dabei zufaellig immer eine Byte-Laenge, die durch drei teilbar ist —
    also nie einen Fall, in dem ueberhaupt Padding fehlt.

    **Gegenprobe tatsaechlich gefahren:** den Anhang ``+ "=="`` in
    ``_envelope_groesse`` (``routes/postfach.py``) entfernt, nur diesen
    Test laufen lassen -> rot (``binascii.Error: Incorrect padding``);
    Anhang wiederhergestellt -> wieder gruen, und die restlichen 20 Tests
    dieser Datei blieben in BEIDEN Laeufen gruen, wie vom Hunter behauptet.
    """
    from dcc_chat_gateway.routes.postfach import _envelope_groesse

    roh = b"ein umschlag, der nicht durch drei teilbar ist"
    assert len(roh) % 3 != 0  # sonst entstuende gar kein Padding, s. o.
    unpolstert = base64.b64encode(roh).rstrip(b"=").decode()

    assert _envelope_groesse(unpolstert) == len(roh)


# ---------------------------------------------------------------------------
# Bughunt 2026-08-28 (Missbrauch) — Fairness je Absender (FIX 3)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ein_absender_verdraengt_nicht_die_anderen(
    client, app, session_factory, _auth_signer, friend_pair, _isolate_chat_settings,
):
    """Die Gesamt-Obergrenze je Empfaengergeraet zaehlt ueber ALLE Absender
    hinweg — ein einzelner angenommener Kontakt kann sie mit ein paar
    Anfragen allein fuellen und damit jeden ANDEREN Absender aussperren.
    Hier mit einer kuenstlich kleinen Absender-Grenze von 2 nachgestellt: A
    fuellt sein eigenes Kontingent, B darf trotzdem noch zustellen."""
    settings = _isolate_chat_settings
    settings.postfach_max_offene_zustellungen_je_absender_und_geraet = 2

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    _, uid_c = await _register(_auth_signer)
    await friend_pair(uid_a, uid_c)
    await friend_pair(uid_b, uid_c)
    dm_ac = await _dm_erstellen(client, token_a, uid_c)
    dm_bc = await _dm_erstellen(client, token_b, uid_c)
    await _bundel_seeden(session_factory, user_id=uid_c, device_pubkey="empf-fair")

    # A liefert drei Umschlaege VOM SELBEN GERAET an dasselbe Empfaenger-
    # geraet -- nur zwei duerfen ankommen, der dritte wird uebersprungen
    # (nicht die Anfrage abgewiesen). Dasselbe Sendegeraet ueber alle drei
    # Aufrufe: die Fairness-Grenze haengt am Sendegeraet (``_einliefern``
    # wuerde je Aufruf ein NEUES erzeugen und die Grenze so umgehen).
    priv_a, pubkey_a = _make_device()
    for i in range(2):
        daten = _b64_unpadded(f"umschlag-a-{i}-nicht-durch-drei".encode())
        r = await _einliefern_mit_geraet(
            client, app, token=token_a, uid=uid_a, channel_id=dm_ac,
            nutzlasten=[{"art": 1, "daten": daten, "empfaenger": ["empf-fair"]}],
            priv=priv_a, pubkey=pubkey_a,
        )
        assert r.status_code == 200, r.text
        assert r.json()["zustellungen_angelegt"] == 1, r.text

    daten_dritter = _b64_unpadded(b"dritter-umschlag-a-nicht-durch-drei")
    r = await _einliefern_mit_geraet(
        client, app, token=token_a, uid=uid_a, channel_id=dm_ac,
        nutzlasten=[{"art": 1, "daten": daten_dritter, "empfaenger": ["empf-fair"]}],
        priv=priv_a, pubkey=pubkey_a,
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 0
    assert r.json()["uebersprungene_empfaenger"] == ["empf-fair"]

    # B ist ein ANDERER Absender an dasselbe Geraet -- A's ausgeschoepftes
    # Kontingent darf B nicht betreffen.
    daten_b = _b64_unpadded(b"umschlag-b-nicht-durch-drei-teilbar")
    r = await _einliefern(
        client, app, token=token_b, uid=uid_b, channel_id=dm_bc,
        nutzlasten=[{"art": 1, "daten": daten_b, "empfaenger": ["empf-fair"]}],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 1, r.text


# ---------------------------------------------------------------------------
# Task 3 — Abholen und Quittieren
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_abholen_liefert_nur_die_eigenen(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Das Geraet eines anderen Nutzers darf nichts davon sehen — und das
    Geraet DESSELBEN Nutzers auch nicht: ein Umschlag ist fuer genau ein
    Geraet verschluesselt."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Zwei Geraete des Empfaengers — nur eines bekommt den Umschlag.
    priv_1, pub_1 = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)
    priv_2, pub_2 = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub_1]}],
    )
    assert r.status_code == 200, r.text

    # Das belieferte Geraet sieht genau eine Zustellung.
    r = await _abholen(client, app, token=token_b, uid=uid_b, priv=priv_1, pubkey=pub_1)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["daten"] == daten

    # Das ZWEITE Geraet DESSELBEN Nutzers sieht nichts.
    r = await _abholen(client, app, token=token_b, uid=uid_b, priv=priv_2, pubkey=pub_2)
    assert r.status_code == 200, r.text
    assert r.json() == []


@pytest.mark.asyncio
async def test_abholen_loescht_noch_nichts(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Zweimal abholen ohne Quittung liefert dasselbe. Wer beim Ausliefern
    loescht, verliert die Nachricht, wenn die Antwort unterwegs verlorengeht
    — und genau das passiert bei einem Handy im Funkloch staendig."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    priv, pub = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub]}],
    )
    assert r.status_code == 200, r.text

    erster = await _abholen(client, app, token=token_b, uid=uid_b, priv=priv, pubkey=pub)
    zweiter = await _abholen(client, app, token=token_b, uid=uid_b, priv=priv, pubkey=pub)
    assert [z["id"] for z in erster.json()] == [z["id"] for z in zweiter.json()]
    assert len(zweiter.json()) == 1


@pytest.mark.asyncio
async def test_quittung_loescht_die_zustellung(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Der Normalfall."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    priv, pub = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub]}],
    )
    assert r.status_code == 200, r.text

    abgeholt = await _abholen(client, app, token=token_b, uid=uid_b, priv=priv, pubkey=pub)
    zustellung_id = abgeholt.json()[0]["id"]

    r = await _quittieren(
        client, app, token=token_b, uid=uid_b, priv=priv, pubkey=pub,
        zustellung_ids=[zustellung_id],
    )
    assert r.status_code == 204, r.text

    rest = await _abholen(client, app, token=token_b, uid=uid_b, priv=priv, pubkey=pub)
    assert rest.json() == []


@pytest.mark.asyncio
async def test_letzte_quittung_raeumt_die_nutzlast_mit(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Eine Nutzlast, die niemand mehr abholen kann, ist Muell. Bei einer
    Gruppe faellt sie erst mit der LETZTEN Zustellung."""
    from dcc_chat_gateway.models import DmNutzlast
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Zwei Geraete desselben Empfaengers -> EINE Nutzlast, ZWEI Zustellungen
    # (der Gruppenfall im Kleinen, s. test_eine_nutzlast_traegt_mehrere_zustellungen).
    priv_1, pub_1 = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)
    priv_2, pub_2 = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub_1, pub_2]}],
    )
    assert r.status_code == 200, r.text

    async def _nutzlasten_anzahl() -> int:
        async with session_factory() as s:
            return len((await s.execute(select(DmNutzlast))).scalars().all())

    assert await _nutzlasten_anzahl() == 1

    id_1 = (await _abholen(
        client, app, token=token_b, uid=uid_b, priv=priv_1, pubkey=pub_1
    )).json()[0]["id"]
    id_2 = (await _abholen(
        client, app, token=token_b, uid=uid_b, priv=priv_2, pubkey=pub_2
    )).json()[0]["id"]

    # Erste Quittung: die Nutzlast bleibt (Geraet 2 hat noch nicht quittiert).
    r = await _quittieren(
        client, app, token=token_b, uid=uid_b, priv=priv_1, pubkey=pub_1,
        zustellung_ids=[id_1],
    )
    assert r.status_code == 204, r.text
    assert await _nutzlasten_anzahl() == 1

    # Zweite (letzte) Quittung: jetzt faellt auch die Nutzlast.
    r = await _quittieren(
        client, app, token=token_b, uid=uid_b, priv=priv_2, pubkey=pub_2,
        zustellung_ids=[id_2],
    )
    assert r.status_code == 204, r.text
    assert await _nutzlasten_anzahl() == 0


@pytest.mark.asyncio
async def test_fremde_zustellungs_id_quittiert_nichts(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Eine erratene ID darf nicht die Zustellung eines anderen loeschen.
    Die Quittung filtert auf das eigene Geraet, nicht nur auf die ID."""
    from dcc_chat_gateway.models import DmZustellung
    from sqlalchemy import select

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    token_fremd, uid_fremd = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    priv, pub = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)
    # Ein Geraet, das mit dieser Zustellung nichts zu tun hat.
    priv_fremd, pub_fremd = await _bundel_seeden_echtes_geraet(
        session_factory, user_id=uid_fremd
    )

    daten = base64.b64encode(b"olm-umschlag").decode()
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        nutzlasten=[{"art": 1, "daten": daten, "empfaenger": [pub]}],
    )
    assert r.status_code == 200, r.text
    async with session_factory() as s:
        zustellung_id = (
            (await s.execute(select(DmZustellung))).scalars().one().id
        )

    # Der Fremde reicht die (erratene oder abgelauschte) ID mit SEINEM
    # eigenen, nachgewiesenen Geraet ein.
    r = await _quittieren(
        client, app, token=token_fremd, uid=uid_fremd, priv=priv_fremd, pubkey=pub_fremd,
        zustellung_ids=[str(zustellung_id)],
    )
    assert r.status_code == 204, r.text  # stilles Uebergehen, kein Fehler

    async with session_factory() as s:
        rest = (await s.execute(select(DmZustellung))).scalars().all()
        assert len(rest) == 1
        assert rest[0].id == zustellung_id


@pytest.mark.asyncio
async def test_absender_user_id_zeigt_das_sendegeraet_auch_beim_eigenen_zweitgeraet(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Der Kern des Bugs, den die Etappe D2 offen liess: eine verschluesselte
    DM liefert denselben Umschlag auch an die EIGENEN anderen Geraete des
    Senders aus (so kommt eine vom Handy gesendete Nachricht auf dem
    Desktop an). `absender_user_id` muss in diesem Fall den SENDER
    zuschreiben — NICHT den Kanal-Gegenpart, den ein rein clientseitiger
    Kanal->User-Lookup faelschlich liefern wuerde."""
    token_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    # Sendegeraet UND Empfaengergeraet gehoeren BEIDE A — der Gegenpart des
    # Kanals ist B, aber der Absender dieser Zustellung ist A selbst.
    sender_priv, sender_pub = await _bundel_seeden_echtes_geraet(
        session_factory, user_id=uid_a
    )
    empf_priv, empf_pub = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_a)

    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid_a), device_pubkey=sender_pub)
    daten = base64.b64encode(b"olm-umschlag").decode()
    sig = _sign(sender_priv, baue_nutzlast("postfach", str(dm_id), daten))
    r = await client.post(
        "/postfach",
        json={
            "channel_id": str(dm_id), "cert": cert, "signatur": sig,
            "nutzlasten": [{"art": 1, "daten": daten, "empfaenger": [empf_pub]}],
        },
        headers=_auth(token_a),
    )
    assert r.status_code == 200, r.text

    r = await _abholen(client, app, token=token_a, uid=uid_a, priv=empf_priv, pubkey=empf_pub)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["absender_user_id"] == str(uid_a)


@pytest.mark.asyncio
async def test_absender_user_id_ist_null_wenn_sendegeraet_abgemeldet_ist(
    client, app, session_factory, _auth_signer, friend_pair
):
    """Das Sendegeraet kann sich zwischen Einliefern und Abholen abmelden —
    sein Schluessel-Buendel ist dann weg, und der OUTER Join findet nichts
    mehr. `absender_user_id` wird `None`, statt dass die Abholung crasht
    oder die Zustellung verschwindet (der Klient faellt in diesem Fall auf
    den Kanal-Gegenpart zurueck, s. `absenderErmitteln.ts`)."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import delete

    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)

    sender_priv, sender_pub = await _bundel_seeden_echtes_geraet(
        session_factory, user_id=uid_a
    )
    empf_priv, empf_pub = await _bundel_seeden_echtes_geraet(session_factory, user_id=uid_b)

    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid_a), device_pubkey=sender_pub)
    daten = base64.b64encode(b"olm-umschlag").decode()
    sig = _sign(sender_priv, baue_nutzlast("postfach", str(dm_id), daten))
    r = await client.post(
        "/postfach",
        json={
            "channel_id": str(dm_id), "cert": cert, "signatur": sig,
            "nutzlasten": [{"art": 1, "daten": daten, "empfaenger": [empf_pub]}],
        },
        headers=_auth(token_a),
    )
    assert r.status_code == 200, r.text

    # Das Sendegeraet meldet sich ab — sein Buendel verschwindet, die
    # Zustellung selbst bleibt unberuehrt liegen (kein Fremdschluessel
    # zwischen den beiden Tabellen, s. Modul-Docstring von models/postfach.py).
    async with session_factory() as s:
        await s.execute(
            delete(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == sender_pub)
        )
        await s.commit()

    r = await _abholen(client, app, token=token_b, uid=uid_b, priv=empf_priv, pubkey=empf_pub)
    assert r.status_code == 200, r.text
    zustellungen = r.json()
    assert len(zustellungen) == 1
    assert zustellungen[0]["absender_user_id"] is None


# ---------------------------------------------------------------------------
# Task 4 — Verfall
# ---------------------------------------------------------------------------


async def _nutzlast_mit_zustellung(
    session_factory, *, verfaellt_am, nutzlast_id=None
):
    """Legt eine Nutzlast mit genau einer Zustellung an und gibt beide IDs
    zurueck — Hilfsfunktion fuer die Task-4-Tests, die direkt auf der DB
    arbeiten (keine Route dafuer noetig, s. Vorbild Task 1)."""
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    nid = nutzlast_id if nutzlast_id is not None else next_id()
    zid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=zid, nutzlast_id=nid,
            empfaenger_device_pubkey="G1", empfaenger_user_id=2,
            verfaellt_am=verfaellt_am,
        ))
        await s.commit()
    return nid, zid


@pytest.mark.asyncio
async def test_verfallene_zustellung_wird_gefegt(session_factory):
    """Ein Geraet, das nie wiederkommt, darf den Server nicht dauerhaft
    belegen."""
    import datetime as dt

    from dcc_chat_gateway.models import DmZustellung
    from dcc_chat_gateway.postfach_pflege import sweep_verfallene_zustellungen
    from sqlalchemy import select

    _, zid = await _nutzlast_mit_zustellung(
        session_factory, verfaellt_am=dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    )

    async with session_factory() as s:
        anzahl = await sweep_verfallene_zustellungen(s)
    assert anzahl == 1

    async with session_factory() as s:
        rest = (await s.execute(select(DmZustellung).where(DmZustellung.id == zid))).scalar_one_or_none()
        assert rest is None


@pytest.mark.asyncio
async def test_nicht_verfallene_bleibt_stehen(session_factory):
    """Die Gegenprobe. Ohne sie faengt der Fegelauf im Zweifel alles weg,
    und das faellt erst auf, wenn Nachrichten verschwinden."""
    import datetime as dt

    from dcc_chat_gateway.models import DmZustellung
    from dcc_chat_gateway.postfach_pflege import sweep_verfallene_zustellungen
    from sqlalchemy import select

    _, zid = await _nutzlast_mit_zustellung(
        session_factory, verfaellt_am=dt.datetime.now(dt.UTC) + dt.timedelta(days=1)
    )

    async with session_factory() as s:
        anzahl = await sweep_verfallene_zustellungen(s)
    assert anzahl == 0

    async with session_factory() as s:
        rest = (await s.execute(select(DmZustellung).where(DmZustellung.id == zid))).scalar_one_or_none()
        assert rest is not None


@pytest.mark.asyncio
async def test_verwaiste_nutzlast_wird_gefegt(session_factory):
    """Eine Nutzlast, deren letzte Zustellung verfiel, ist unlesbar
    geworden — sie loescht sich nicht von selbst, weil der Verfall an der
    Zustellung haengt."""
    import datetime as dt

    from dcc_chat_gateway.models import DmNutzlast
    from dcc_chat_gateway.postfach_pflege import (
        sweep_verfallene_zustellungen,
        sweep_verwaiste_nutzlasten,
    )
    from sqlalchemy import select

    nid, _ = await _nutzlast_mit_zustellung(
        session_factory, verfaellt_am=dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    )

    async with session_factory() as s:
        assert await sweep_verfallene_zustellungen(s) == 1
        # Die Nutzlast selbst ist von diesem Lauf unberuehrt.
        assert (
            await s.execute(select(DmNutzlast).where(DmNutzlast.id == nid))
        ).scalar_one_or_none() is not None

    async with session_factory() as s:
        anzahl = await sweep_verwaiste_nutzlasten(s)
    assert anzahl == 1

    async with session_factory() as s:
        rest = (
            await s.execute(select(DmNutzlast).where(DmNutzlast.id == nid))
        ).scalar_one_or_none()
        assert rest is None
