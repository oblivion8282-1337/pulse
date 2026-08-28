"""Das Geraete-Schluesselverzeichnis."""

from __future__ import annotations

import asyncio
import base64
import json
import random
import time

import jwt as pyjwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast

# ---------------------------------------------------------------------------
# Nachweis-Helfer — bauen ein echtes Ed25519-Geraetepaar und ein echtes,
# RS256-signiertes Identitaets-Zertifikat, wie ``test_cert_login.py`` /
# ``test_credential_validator.py`` es tun. Kein eigener Mechanismus.
# ---------------------------------------------------------------------------

_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-schluessel-key-1"


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
    """Legt die JWKS unter dem Cloud-Cache-Key ab (``cloud_mode`` in Benutzung)."""
    await app.state.redis.set("auth:jwks:cached", _jwks_json())


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung. Postgres (Prod) erzwingt das ohnehin — dieselbe Falle wie
    in ``services/auth/tests/test_account_delete.py``. Die Test-Engine nutzt
    ``StaticPool`` (eine geteilte In-Memory-Verbindung), deshalb genuegt ein
    einmaliges PRAGMA auf dieser einen Verbindung, ohne Dispose+Neuanlage.
    """
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_ein_geraet_hat_hoechstens_ein_buendel(session_factory):
    """Zweimal dasselbe Geraet darf keine zweite Zeile anlegen.

    Sonst hielte das Verzeichnis zwei Identitaeten fuer dasselbe Geraet, und
    welche ein Absender bekaeme, entschiede die Zeilenreihenfolge.
    """
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy.exc import IntegrityError

    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=next_id(), user_id=1, device_pubkey="AAA", curve25519="BBB",
            signatur="CCC", cert_id="c1",
        ))
        await s.commit()

    with pytest.raises(IntegrityError):
        async with session_factory() as s:
            s.add(DeviceKeyBundle(
                id=next_id(), user_id=1, device_pubkey="AAA", curve25519="XXX",
                signatur="YYY", cert_id="c2",
            ))
            await s.commit()


@pytest.mark.asyncio
async def test_einmalschluessel_verschwinden_mit_ihrem_buendel(session_factory):
    """Ein Geraet abmelden heisst: sein Vorrat ist weg, nicht verwaist."""
    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import delete, select

    bid = next_id()
    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=bid, user_id=2, device_pubkey="DDD", curve25519="EEE",
            signatur="FFF", cert_id="c3",
        ))
        s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel="k1"))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DeviceKeyBundle).where(DeviceKeyBundle.id == bid))
        await s.commit()

    async with session_factory() as s:
        uebrig = (await s.execute(
            select(DeviceOneTimeKey).where(DeviceOneTimeKey.bundle_id == bid)
        )).scalars().all()
        assert uebrig == []


# ---------------------------------------------------------------------------
# Task 2 — Veroeffentlichen mit Nachweis
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_buendel_veroeffentlichen_und_wieder_abrufen(
    client, app, cloud_mode, access_token
):
    """Der Normalfall: Geraet legt Zertifikat und Unterschrift bei."""
    token, uid = access_token
    await _seed_jwks(app)
    priv, pubkey = _make_device()
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    nutzlast = baue_nutzlast("buendel", "curve-pub", "")
    sig = _sign(priv, nutzlast)

    r = await client.put(
        "/keys/bundle",
        json={"cert": cert, "signatur": sig, "curve25519": "curve-pub"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 204, r.text

    r = await client.get(
        "/keys/onetime/count",
        params={"device_pubkey": pubkey},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"vorrat": 0}


@pytest.mark.asyncio
async def test_falsche_unterschrift_wird_abgewiesen(client, app, cloud_mode, access_token):
    """Ohne diese Pruefung koennte jeder fuer jedes fremde Geraet einen
    Schluessel hinterlegen und saemtliche Nachrichten an dieses Geraet
    mitlesen. Das ist die Stelle, an der das ganze Verfahren haengt."""
    token, uid = access_token
    await _seed_jwks(app)
    priv, pubkey = _make_device()
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    # Unterschrift ueber eine ANDERE Nutzlast als die im Rumpf behauptete.
    falsche_nutzlast = baue_nutzlast("buendel", "anderer-schluessel", "")
    sig = _sign(priv, falsche_nutzlast)

    r = await client.put(
        "/keys/bundle",
        json={"cert": cert, "signatur": sig, "curve25519": "curve-pub"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_fremdes_zertifikat_wird_abgewiesen(client, app, cloud_mode, access_token):
    """Ein gueltiges Zertifikat eines ANDEREN Kontos darf nicht genuegen."""
    token, uid = access_token
    await _seed_jwks(app)
    priv, pubkey = _make_device()
    # Zertifikat lautet auf ein fremdes Konto, nicht auf den angemeldeten Nutzer.
    cert = _make_cert(user_id=str(uid + 1), device_pubkey=pubkey)
    nutzlast = baue_nutzlast("buendel", "curve-pub", "")
    sig = _sign(priv, nutzlast)

    r = await client.put(
        "/keys/bundle",
        json={"cert": cert, "signatur": sig, "curve25519": "curve-pub"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_erneutes_veroeffentlichen_ersetzt_statt_zu_haeufen(
    client, app, session_factory, cloud_mode, access_token
):
    """Dasselbe Geraet nach einer Zertifikatserneuerung: eine Zeile, nicht zwei."""
    from dcc_chat_gateway.models import DeviceKeyBundle
    from sqlalchemy import select

    token, uid = access_token
    await _seed_jwks(app)
    priv, pubkey = _make_device()

    for curve in ("erste-runde", "zweite-runde"):
        cert = _make_cert(user_id=str(uid), device_pubkey=pubkey, cert_id=f"cert-{curve}")
        nutzlast = baue_nutzlast("buendel", curve, "")
        sig = _sign(priv, nutzlast)
        r = await client.put(
            "/keys/bundle",
            json={"cert": cert, "signatur": sig, "curve25519": curve},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 204, r.text

    async with session_factory() as s:
        zeilen = (
            await s.execute(
                select(DeviceKeyBundle).where(DeviceKeyBundle.device_pubkey == pubkey)
            )
        ).scalars().all()
        assert len(zeilen) == 1
        assert zeilen[0].curve25519 == "zweite-runde"


# ---------------------------------------------------------------------------
# Task 3 — Abholen: einmal ist einmal
# ---------------------------------------------------------------------------


def _register(_auth_signer) -> tuple[str, int]:
    """Wie in ``test_dm_friend_gate.py`` / ``test_dropbox_races.py``: kein
    echtes ``/register``, nur ein ausgestelltes Access-Token fuer eine
    synthetische Nutzer-ID."""
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _buendel_seeden(
    session_factory,
    *,
    user_id: int,
    device_pubkey: str = "pub-empfaenger",
    cert_id: str = "cert-empfaenger",
    rueckfallschluessel: str | None = None,
    einmalschluessel: list[str] = (),
) -> int:
    """Legt ein Buendel direkt in die DB, ohne den Nachweis-Umweg — Task 3
    prueft das ABHOLEN, nicht das Veroeffentlichen; das ist bereits in
    Task 2 abgedeckt."""
    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id

    bid = next_id()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=bid,
                user_id=user_id,
                device_pubkey=device_pubkey,
                curve25519="curve-empfaenger",
                signatur="sig-empfaenger",
                rueckfallschluessel=rueckfallschluessel,
                cert_id=cert_id,
            )
        )
        for schl in einmalschluessel:
            s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel=schl))
        await s.commit()
    return bid


@pytest.mark.asyncio
async def test_abholen_verbraucht_den_einmalschluessel(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Zweimal abholen darf nie denselben Schluessel liefern."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-1",
        einmalschluessel=["otk-1"],
    )

    r1 = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r1.status_code == 200, r1.text
    b1 = r1.json()[str(empf_uid)][0]
    assert b1["einmalschluessel"] == "otk-1"
    assert b1["rueckfallschluessel"] is None

    r2 = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r2.status_code == 200, r2.text
    b2 = r2.json()[str(empf_uid)][0]
    # Vorrat ist leer -> Rueckfall, NICHT derselbe (oder irgendein) Einmalschluessel.
    assert b2["einmalschluessel"] is None
    assert b2["rueckfallschluessel"] == "rueckfall-1"


@pytest.mark.asyncio
async def test_zwei_gleichzeitige_abholungen_bekommen_verschiedene(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Der Kern der Sache. Zwei Abholungen gleichzeitig (asyncio.gather)
    duerfen NIE denselben Einmalschluessel liefern — sonst benutzen zwei
    Absender dasselbe Geheimnis. Ein blosses SELECT-dann-DELETE hat genau
    dieses Loch, und es faellt in keinem seriellen Test auf.

    **Wie hier echte Nebenlaeufigkeit entsteht:** zwei ``client.post``-Aufrufe
    werden ueber ``asyncio.gather`` gestartet, nicht nacheinander erwartet.
    Jede Anfrage bekommt ueber ``SessionDep`` eine EIGENE ``AsyncSession``
    (s. ``app``-Fixture: ``get_session`` liefert bei jedem Aufruf eine neue
    Sitzung aus ``session_factory``) — es sind zwei unabhaengige Koroutinen,
    die um denselben Vorrat konkurrieren, kein sequenzieller Anruf, der nur
    wie ein Rennen aussieht. Dasselbe Muster benutzt bereits
    ``test_tamagotchi_state.py::test_concurrent_feeds_are_serialised``.

    **Ehrlich zur Grenze:** die Test-DB ist ein einziges SQLite-``:memory:``
    an einem ``StaticPool`` (eine geteilte Verbindung, s.
    ``test_dropbox_races.py``) — echte parallele Schreibzugriffe auf zwei
    Verbindungen finden hier nicht statt. Was ECHT nebenlaeufig ist: die
    beiden Koroutinen werden vom Event-Loop verzahnt ausgefuehrt, und
    zwischen dem SELECT und dem bedingten DELETE in
    ``_einmalschluessel_holen`` liegt ein ``await`` — genau das Fenster, in
    dem die andere Koroutine dieselbe Zeile sehen und zuerst loeschen kann.
    Das bedingte DELETE (rowcount-Pruefung + Retry-Schleife) ist exakt der
    Code, der dieses Fenster schliesst; ein simples ungeschuetztes
    SELECT-dann-DELETE wuerde hier reproduzierbar denselben Schluessel an
    beide Anfragen ausliefern, weil beide Koroutinen dieselbe Zeile lesen,
    bevor irgendeine sie loescht."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        rueckfallschluessel="rueckfall-race",
        einmalschluessel=["otk-a", "otk-b"],
    )

    async def _abholen() -> str | None:
        r = await client.post(
            "/keys/claim",
            json={"user_ids": [str(empf_uid)]},
            headers={"Authorization": f"Bearer {sender_token}"},
        )
        assert r.status_code == 200, r.text
        return r.json()[str(empf_uid)][0]["einmalschluessel"]

    ergebnis_a, ergebnis_b = await asyncio.gather(_abholen(), _abholen())

    assert ergebnis_a is not None
    assert ergebnis_b is not None
    assert ergebnis_a != ergebnis_b
    assert {ergebnis_a, ergebnis_b} == {"otk-a", "otk-b"}


@pytest.mark.asyncio
async def test_leerer_vorrat_liefert_den_rueckfallschluessel(
    client, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Sonst koennte niemand mehr an ein laenger ausgeschaltetes Geraet
    schreiben. Der Rueckfallschluessel wird NICHT verbraucht."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory, user_id=empf_uid, rueckfallschluessel="rueckfall-dauerhaft"
    )

    for _ in range(3):
        r = await client.post(
            "/keys/claim",
            json={"user_ids": [str(empf_uid)]},
            headers={"Authorization": f"Bearer {sender_token}"},
        )
        assert r.status_code == 200, r.text
        buendel = r.json()[str(empf_uid)][0]
        assert buendel["einmalschluessel"] is None
        assert buendel["rueckfallschluessel"] == "rueckfall-dauerhaft"


@pytest.mark.asyncio
async def test_widerrufenes_geraet_wird_nicht_geliefert(
    client, app, session_factory, cloud_mode, _auth_signer, friend_pair
):
    """Ein gestohlenes, gesperrtes Geraet darf keine neuen Nachrichten mehr
    bekommen — sonst waere der Widerruf wirkungslos."""
    from dcc_chat_gateway.credential_validator import REDIS_REVOKED_SET

    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)
    await _buendel_seeden(
        session_factory,
        user_id=empf_uid,
        cert_id="cert-widerrufen",
        rueckfallschluessel="rueckfall-widerrufen",
        einmalschluessel=["otk-widerrufen"],
    )
    await app.state.redis.sadd(REDIS_REVOKED_SET, "cert-widerrufen")

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()[str(empf_uid)] == []


@pytest.mark.asyncio
async def test_nutzer_ohne_geraete_liefert_leer_statt_fehler(
    client, cloud_mode, _auth_signer, friend_pair
):
    """Jemand, der die App nie installiert hat. Das ist der Normalfall der
    Koexistenz-Regel, kein Fehlerfall."""
    sender_token, sender_uid = _register(_auth_signer)
    _, empf_uid = _register(_auth_signer)
    await friend_pair(sender_uid, empf_uid)

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(empf_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {str(empf_uid): []}


@pytest.mark.asyncio
async def test_nicht_erreichbares_ziel_liefert_leer_statt_403(
    client, session_factory, cloud_mode, _auth_signer
):
    """Wer darf abholen? Dieselbe Regel wie beim DM-Anlegen
    (``routes/dms.py::create_or_get_dm_channel``): ohne Freundschaft (und ohne
    Sperre) darf man nicht mit jemandem schreiben — und deshalb auch keine
    Schluessel fuer ihn abholen. Anders als beim DM-Anlegen gibt es dafuer
    KEINE 403: die Liste bleibt leer, wie beim Nutzer ohne Geraete — sonst
    wuerde ein einzelnes unzulaessiges Ziel in einer Mehrfachanfrage
    (``user_ids``) die anderen, zulaessigen Ziele mit zu Fall bringen."""
    sender_token, sender_uid = _register(_auth_signer)
    _, fremd_uid = _register(_auth_signer)
    # Bewusst KEIN friend_pair — die beiden sind einander fremd.
    await _buendel_seeden(session_factory, user_id=fremd_uid, einmalschluessel=["otk-fremd"])

    r = await client.post(
        "/keys/claim",
        json={"user_ids": [str(fremd_uid)]},
        headers={"Authorization": f"Bearer {sender_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {str(fremd_uid): []}
