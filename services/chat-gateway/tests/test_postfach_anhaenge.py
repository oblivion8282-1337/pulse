"""Verschluesselte Anhaenge (Etappe E) — Hochladen, Abrufen, Fegen.

Der Nachweis-Helferteil ist derselbe wie in ``test_postfach.py``: ein echtes
Ed25519-Geraetepaar und ein echtes, RS256-signiertes Identitaets-Zertifikat.
Bewusst kopiert statt importiert — Testmodule laufen unter
``--import-mode=importlib`` und sind untereinander nicht verlaesslich
importierbar (``test_schluessel.py`` und ``test_postfach.py`` fuehren
dieselben Helfer aus demselben Grund je eigen).
"""

from __future__ import annotations

import base64
import json
import random
import time
from datetime import UTC, datetime, timedelta

import jwt as pyjwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import select

from dcc_chat_gateway import s3 as s3_mod
from dcc_chat_gateway.models import DmAnhangBezug, DmNutzlast, MessageAttachment
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast

pytestmark = pytest.mark.usefixtures("cloud_mode")

_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-anhaenge-key-1"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64_unpadded(data: bytes) -> str:
    """Wie der Krypto-Kern kodiert (``STANDARD_NO_PAD``) — ohne Fuellzeichen."""
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


def _make_cert(*, user_id: str, device_pubkey: str) -> str:
    now = int(time.time())
    return pyjwt.encode(
        {
            "iss": "https://howispulse.com",
            "aud": "dcc",
            "typ": "credential",
            "cert_id": "cert-1",
            "user_id": user_id,
            "device_pubkey": device_pubkey,
            "device_label": "Testgeraet",
            "pairwise_seed": _b64url(b"\xab" * 32),
            "amr": ["pwd"],
            "acr": "1",
            "iat": now,
            "exp": now + 3600,
        },
        _RSA_KEY,
        algorithm="RS256",
        headers={"kid": _KID},
    )


def _sign(priv: Ed25519PrivateKey, nutzlast: bytes) -> str:
    return _b64url(priv.sign(nutzlast))


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _seed_jwks(app) -> None:
    await app.state.redis.set("auth:jwks:cached", _jwks_json())


@pytest_asyncio.fixture(autouse=True)
async def _redis_fixture_daten_aufraeumen(app):
    """Wie in ``test_postfach.py``: die Fixture-JWKS steht unter dem ECHTEN
    Produktionsschluessel in einem realen Redis und darf den Testlauf nicht
    ueberleben."""
    yield
    await app.state.redis.delete("auth:jwks:cached")


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite kaskadiert ``ON DELETE`` nur mit ``PRAGMA foreign_keys=ON``.
    Ohne das faellt ``DmAnhangBezug`` beim Loeschen einer Nutzlast nicht mit,
    und der Anhang saehe nie verwaist aus."""
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


class _S3Mock:
    def __init__(self) -> None:
        self.put_calls: list[dict] = []
        self.get_calls: list[dict] = []
        self.deleted: list[str] = []

    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        self.put_calls.append(
            {"key": key, "content_type": content_type, "content_length": content_length}
        )
        return f"https://mock/{key}?put-sig"

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        self.get_calls.append({"key": key, "filename": filename, "inline": inline})
        return f"https://mock/{key}?get-sig"

    async def delete_object(self, key):
        self.deleted.append(key)


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    return m


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _dm_erstellen(client, token_a: str, uid_b: int) -> str:
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _bundel_seeden(session_factory, *, user_id: int) -> tuple[Ed25519PrivateKey, str]:
    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    priv, pubkey = _make_device()
    async with session_factory() as s:
        s.add(
            DeviceKeyBundle(
                id=next_id(), user_id=user_id, device_pubkey=pubkey,
                curve25519="curve-" + pubkey, signatur="sig-" + pubkey,
                cert_id="cert-" + pubkey,
            )
        )
        await s.commit()
    return priv, pubkey


async def _anhang_hochladen(client, *, token: str, channel_id: str, size: int = 4096):
    return await client.post(
        "/postfach/anhaenge/upload-url",
        json={"channel_id": str(channel_id), "size": size},
        headers=_auth(token),
    )


async def _einliefern(
    client, app, *, token: str, uid: int, channel_id: str,
    empfaenger: list[str], anhaenge: list[str] | None = None,
    daten: str | None = None,
):
    """Liefert EINEN Umschlag ein, wahlweise mit Anhaengen."""
    await _seed_jwks(app)
    priv, pubkey = _make_device()
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    daten = daten or _b64_unpadded(b"olm-umschlag1")
    teile = [str(channel_id), daten]
    if anhaenge:
        teile.extend(["anhaenge", *anhaenge])
    sig = _sign(priv, baue_nutzlast("postfach", *teile))
    rumpf = {
        "channel_id": str(channel_id), "cert": cert, "signatur": sig,
        "nutzlasten": [{"art": 1, "daten": daten, "empfaenger": empfaenger}],
    }
    if anhaenge is not None:
        rumpf["anhaenge"] = anhaenge
    return await client.post("/postfach", json=rumpf, headers=_auth(token))


async def _abrufadresse(
    client, app, *, token: str, uid: int, anhang_id: str,
    priv: Ed25519PrivateKey, pubkey: str,
):
    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    sig = _sign(priv, baue_nutzlast("postfach-anhang", str(anhang_id)))
    return await client.post(
        f"/postfach/anhaenge/{anhang_id}/abrufadresse",
        json={"cert": cert, "signatur": sig},
        headers=_auth(token),
    )


async def _quittieren(
    client, app, *, token: str, uid: int, priv: Ed25519PrivateKey, pubkey: str,
    zustellung_ids: list[str],
):
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


async def _abholen(client, app, *, token: str, uid: int, priv, pubkey: str):
    await _seed_jwks(app)
    cert = _make_cert(user_id=str(uid), device_pubkey=pubkey)
    sig = _sign(priv, baue_nutzlast("postfach-abholen"))
    return await client.post(
        "/postfach/abholen", json={"cert": cert, "signatur": sig}, headers=_auth(token)
    )


async def _aufbau(client, session_factory, _auth_signer, friend_pair):
    """A und B befreundet, DM-Kanal, ein Buendel je Seite."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, token_a, uid_b)
    priv_b, pub_b = await _bundel_seeden(session_factory, user_id=uid_b)
    return token_a, uid_a, token_b, uid_b, dm_id, priv_b, pub_b


# ---------------------------------------------------------------------------
# Was der Server NICHT speichert
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kein_name_kein_typ_keine_masse(
    client, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Zu einem verschluesselten Anhang steht weder Name noch Typ noch Maß in
    der Datenbank — und keine Nachrichtenzeile haengt daran."""
    token_a, _uid_a, _tb, uid_b, dm_id, _priv_b, _pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    r = await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    assert r.status_code == 201, r.text
    anhang_id = int(r.json()["id"])

    async with session_factory() as s:
        zeile = await s.get(MessageAttachment, anhang_id)
        assert zeile is not None
        assert zeile.filename is None
        assert zeile.mime is None
        assert zeile.width is None and zeile.height is None
        assert zeile.thumb_width is None and zeile.thumb_height is None
        assert zeile.message_id is None
        assert zeile.postfach_gebunden_am is None  # noch nicht eingeliefert

    # Auch der Objektspeicher bekommt keinen Typ genannt, nur undurchsichtige
    # Bytes.
    assert mock_s3.put_calls[-1]["content_type"] == "application/octet-stream"


@pytest.mark.asyncio
async def test_verschluesselter_weg_haengt_nicht_am_klartext_schalter(
    client, session_factory, _auth_signer, friend_pair, mock_s3, cloud_mode
):
    """``cloud_dm_attachments_enabled`` schaltet den UNVERSCHLUESSELTEN Weg
    ab und bleibt aus — der verschluesselte Weg hat sein eigenes Kriterium."""
    assert cloud_mode.cloud_dm_attachments_enabled is False
    token_a, _uid_a, _tb, _uid_b, dm_id, _p, _pk = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )

    klartext = await client.post(
        f"/channels/{dm_id}/attachments/upload-url",
        json={"filename": "a.png", "mime": "image/png", "size": 10},
        headers=_auth(token_a),
    )
    assert klartext.status_code == 403

    verschluesselt = await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    assert verschluesselt.status_code == 201


# ---------------------------------------------------------------------------
# Berechtigung
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_nur_wer_eine_zustellung_hat_bekommt_eine_abrufadresse(
    client, app, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Drei Anfragen auf denselben Anhang: das belieferte Geraet bekommt eine
    Adresse, ein zweites Geraet desselben Kontos ohne Zustellung nicht, und
    ein voellig Fremder auch nicht."""
    token_a, uid_a, token_b, uid_b, dm_id, priv_b, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        empfaenger=[pub_b], anhaenge=[anhang_id],
    )
    assert r.status_code == 200, r.text
    assert r.json()["zustellungen_angelegt"] == 1

    ok = await _abrufadresse(
        client, app, token=token_b, uid=uid_b, anhang_id=anhang_id,
        priv=priv_b, pubkey=pub_b,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["url"].startswith("https://mock/")

    # Zweites Geraet von B — angemeldet, im selben Gespraech, aber ohne
    # Zustellung zu diesem Anhang.
    priv_b2, pub_b2 = await _bundel_seeden(session_factory, user_id=uid_b)
    ohne = await _abrufadresse(
        client, app, token=token_b, uid=uid_b, anhang_id=anhang_id,
        priv=priv_b2, pubkey=pub_b2,
    )
    assert ohne.status_code == 404

    # Fremdes Konto, eigenes Geraet, kennt nur die Kennung.
    token_c, uid_c = await _register(_auth_signer)
    priv_c, pub_c = await _bundel_seeden(session_factory, user_id=uid_c)
    fremd = await _abrufadresse(
        client, app, token=token_c, uid=uid_c, anhang_id=anhang_id,
        priv=priv_c, pubkey=pub_c,
    )
    assert fremd.status_code == 404


@pytest.mark.asyncio
async def test_eingelieferter_anhang_kommt_in_keine_klartext_nachricht(
    client, app, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Die Gegenrichtung: ein Anhang, der an einem Umschlag haengt, darf
    nicht zusaetzlich an einer Nachricht haengen.

    Sonst faellt er mit seinem letzten Umschlag, waehrend eine
    Klartext-Nachricht weiter auf ihn zeigt — und er waere ueber die
    Rechtepruefung des Klartext-Wegs erreichbar, an der Zustellung vorbei.
    """
    token_a, uid_a, _token_b, _uid_b, dm_id, _priv_b, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        empfaenger=[pub_b], anhaenge=[anhang_id],
    )
    assert r.status_code == 200, r.text

    nachricht = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "harmlos", "attachment_ids": [anhang_id]},
        headers=_auth(token_a),
    )
    assert nachricht.status_code == 400
    async with session_factory() as s:
        assert (await s.get(MessageAttachment, int(anhang_id))).message_id is None


@pytest.mark.asyncio
async def test_fremder_anhang_laesst_sich_nicht_binden(
    client, app, session_factory, _auth_signer, friend_pair, mock_s3
):
    """B laedt in denselben Kanal hoch, A versucht ihn mitzuschicken."""
    token_a, uid_a, token_b, _uid_b, dm_id, _priv_b, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    fremder = (
        await _anhang_hochladen(client, token=token_b, channel_id=dm_id)
    ).json()["id"]

    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        empfaenger=[pub_b], anhaenge=[fremder],
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "anhang_nicht_verwendbar"
    async with session_factory() as s:
        assert (await s.execute(select(DmNutzlast))).scalars().all() == []


# ---------------------------------------------------------------------------
# Fegen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anhang_faellt_mit_der_letzten_zustellung(
    client, app, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Zwei Empfaengergeraete, zwei Umschlaege, ein Anhang. Nach der ERSTEN
    Quittung lebt er weiter, nach der zweiten faellt er — Zeile und Klumpen."""
    from dcc_chat_gateway.postfach_pflege import (
        sweep_verwaiste_anhaenge,
        sweep_verwaiste_nutzlasten,
    )

    token_a, uid_a, token_b, uid_b, dm_id, priv_b1, pub_b1 = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    priv_b2, pub_b2 = await _bundel_seeden(session_factory, user_id=uid_b)
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]

    # Zwei Einlieferungen — Olm verschluesselt je Empfaengergeraet einzeln,
    # der Klient schickt also zwei Umschlaege fuer dieselbe Nachricht.
    for pubkey, daten in ((pub_b1, b"fuer-geraet-eins"), (pub_b2, b"fuer-zwei")):
        r = await _einliefern(
            client, app, token=token_a, uid=uid_a, channel_id=dm_id,
            empfaenger=[pubkey], anhaenge=[anhang_id],
            daten=_b64_unpadded(daten),
        )
        assert r.status_code == 200, r.text

    async with session_factory() as s:
        bezuege = (await s.execute(select(DmAnhangBezug))).scalars().all()
        assert len(bezuege) == 2
        assert (await s.get(MessageAttachment, int(anhang_id))).postfach_gebunden_am

    zustellungen = (
        await _abholen(client, app, token=token_b, uid=uid_b, priv=priv_b1, pubkey=pub_b1)
    ).json()
    assert len(zustellungen) == 1
    q = await _quittieren(
        client, app, token=token_b, uid=uid_b, priv=priv_b1, pubkey=pub_b1,
        zustellung_ids=[zustellungen[0]["id"]],
    )
    assert q.status_code == 204
    async with session_factory() as s:
        assert await sweep_verwaiste_anhaenge(s) == 0
        assert await s.get(MessageAttachment, int(anhang_id)) is not None
    assert mock_s3.deleted == []

    zustellungen = (
        await _abholen(client, app, token=token_b, uid=uid_b, priv=priv_b2, pubkey=pub_b2)
    ).json()
    assert len(zustellungen) == 1
    q = await _quittieren(
        client, app, token=token_b, uid=uid_b, priv=priv_b2, pubkey=pub_b2,
        zustellung_ids=[zustellungen[0]["id"]],
    )
    assert q.status_code == 204

    async with session_factory() as s:
        await sweep_verwaiste_nutzlasten(s)
        assert await sweep_verwaiste_anhaenge(s) == 1
        assert await s.get(MessageAttachment, int(anhang_id)) is None
    assert len(mock_s3.deleted) == 1


@pytest.mark.asyncio
async def test_reaper_verschont_einen_eingelieferten_anhang(
    client, app, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Der Anhang-Reaper raeumt Zeilen ohne Nachricht nach einer Stunde weg.
    Ein verschluesselter Anhang hat fuer immer keine Nachricht — ohne die
    Ausnahme loeschte der Reaper ihn, waehrend sein Umschlag noch wartet."""
    from dcc_chat_gateway.routes import attachments as att_mod

    token_a, uid_a, _tb, _uid_b, dm_id, _priv_b, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    gebunden = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        empfaenger=[pub_b], anhaenge=[gebunden],
    )
    assert r.status_code == 200, r.text
    # Zweiter Anhang: hochgeladen, nie eingeliefert — der bleibt Beute des
    # Reapers, sonst waere der Test auch mit einem abgeschalteten Reaper gruen.
    verwaist = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]

    alt = datetime.now(UTC) - timedelta(hours=2)
    async with session_factory() as s:
        for kennung in (gebunden, verwaist):
            (await s.get(MessageAttachment, int(kennung))).created_at = alt
        await s.commit()

    original = att_mod.SessionLocal
    att_mod.SessionLocal = session_factory
    try:
        assert await att_mod._reap_once() == 1
    finally:
        att_mod.SessionLocal = original

    async with session_factory() as s:
        assert await s.get(MessageAttachment, int(gebunden)) is not None
        assert await s.get(MessageAttachment, int(verwaist)) is None


@pytest.mark.asyncio
async def test_kontoloeschung_raeumt_den_anhang_mit(
    client, app, session_factory, _auth_signer, friend_pair, mock_s3
):
    """Der Konto-Purge loescht die Zustellungen des Kontos, damit die
    Nutzlasten — und damit muss der Anhang fallen."""
    from dcc_chat_gateway.user_purge_postfach import purge_postfach

    token_a, uid_a, _token_b, uid_b, dm_id, _priv_b, pub_b = await _aufbau(
        client, session_factory, _auth_signer, friend_pair
    )
    anhang_id = (
        await _anhang_hochladen(client, token=token_a, channel_id=dm_id)
    ).json()["id"]
    r = await _einliefern(
        client, app, token=token_a, uid=uid_a, channel_id=dm_id,
        empfaenger=[pub_b], anhaenge=[anhang_id],
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        await purge_postfach(s, uid_b)
        await s.commit()
        assert await s.get(MessageAttachment, int(anhang_id)) is None
    assert len(mock_s3.deleted) == 1
