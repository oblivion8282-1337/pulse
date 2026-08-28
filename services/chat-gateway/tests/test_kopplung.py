"""Geraete-Kopplung und Verlaufsumzug (Etappe F).

Die drei verbindlichen Gegenproben des Auftrags stehen hier namentlich:

* ``test_code_laesst_sich_nicht_zweimal_einloesen``
* ``test_abgelaufener_code_wird_abgewiesen``
* ``test_abgebrochener_umzug_setzt_fort``

Nachweis-Helfer wie in ``test_postfach.py``: ein echtes Ed25519-Geraetepaar
und ein echtes, RS256-signiertes Identitaets-Zertifikat — kein Patchen von
``pruefe_geraet``, sonst prueft der Test die eigene Attrappe statt der
Rechte.
"""

from __future__ import annotations

import base64
import hashlib
import json
import random
import time
from datetime import UTC, datetime, timedelta

import jwt as pyjwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast

pytestmark = pytest.mark.usefixtures("cloud_mode")

_RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-kopplung-key-1"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64_unpadded(data: bytes) -> str:
    """Wie der Klient kodiert — OHNE Fuellzeichen (s. ``test_postfach.py``)."""
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


def _code_hash(code: str) -> str:
    """Wie der Klient rechnet (``web/src/lib/kopplung/codeHash.ts``)."""
    return _b64url(hashlib.sha256(b"pulse-kopplung-v1\x00" + code.encode()).digest())


async def _seed_jwks(app) -> None:
    await app.state.redis.set("auth:jwks:cached", _jwks_json())


@pytest_asyncio.fixture(autouse=True)
async def _redis_fixture_daten_aufraeumen(app):
    """S. ``test_postfach.py``: die Fixture-JWKS liegt unter dem ECHTEN
    Produktions-Key in einem realen Redis und muss wieder weg."""
    yield
    await app.state.redis.delete("auth:jwks:cached")


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class Geraet:
    """Ein Testgeraet — Schluesselpaar, Pubkey und Zertifikat in einem."""

    def __init__(self, uid: int, cert_id: str):
        self.priv, self.pubkey = _make_device()
        self.cert = _make_cert(user_id=str(uid), device_pubkey=self.pubkey, cert_id=cert_id)

    def rumpf(self, zweck: str, *teile: str, **felder) -> dict:
        return {
            "cert": self.cert,
            "signatur": _sign(self.priv, baue_nutzlast(zweck, *teile)),
            **felder,
        }


async def _anlegen(client, app, geraet: Geraet, token: str, code: str):
    await _seed_jwks(app)
    ch = _code_hash(code)
    return await client.post(
        "/kopplung", json=geraet.rumpf("kopplung", ch, code_hash=ch), headers=_auth(token)
    )


async def _einloesen(client, app, geraet: Geraet, token: str, code: str):
    await _seed_jwks(app)
    ch = _code_hash(code)
    return await client.post(
        "/kopplung/einloesen",
        json=geraet.rumpf("kopplung-einloesen", ch, code_hash=ch),
        headers=_auth(token),
    )


async def _stand(client, app, geraet: Geraet, token: str, kid: str):
    await _seed_jwks(app)
    return await client.post(
        "/kopplung/stand",
        json=geraet.rumpf("kopplung-stand", str(kid), kopplung_id=str(kid)),
        headers=_auth(token),
    )


async def _stueck(client, app, geraet: Geraet, token: str, kid: str, folge: int, daten: str):
    await _seed_jwks(app)
    return await client.post(
        "/kopplung/stueck",
        json=geraet.rumpf(
            "kopplung-stueck", str(kid), str(folge), daten,
            kopplung_id=str(kid), folge=folge, daten=daten,
        ),
        headers=_auth(token),
    )


async def _stueck_holen(client, app, geraet: Geraet, token: str, kid: str, folge: int):
    await _seed_jwks(app)
    return await client.post(
        "/kopplung/stueck/holen",
        json=geraet.rumpf(
            "kopplung-stueck-holen", str(kid), str(folge),
            kopplung_id=str(kid), folge=folge,
        ),
        headers=_auth(token),
    )


async def _fertig(client, app, geraet: Geraet, token: str, kid: str, gesamt: int):
    await _seed_jwks(app)
    return await client.post(
        "/kopplung/fertig",
        json=geraet.rumpf(
            "kopplung-fertig", str(kid), str(gesamt),
            kopplung_id=str(kid), gesamt_stuecke=gesamt,
        ),
        headers=_auth(token),
    )


async def _abschliessen(client, app, geraet: Geraet, token: str, kid: str):
    await _seed_jwks(app)
    return await client.post(
        "/kopplung/abschliessen",
        json=geraet.rumpf("kopplung-abschliessen", str(kid), kopplung_id=str(kid)),
        headers=_auth(token),
    )


async def _gekoppelt(client, app, _auth_signer) -> tuple[str, Geraet, Geraet, str]:
    """Konto mit zwei Geraeten und einer eingeloesten Kopplung."""
    token, uid = await _register(_auth_signer)
    alt = Geraet(uid, "cert-alt")
    neu = Geraet(uid, "cert-neu")
    r = await _anlegen(client, app, alt, token, "ABCDE-FGHJK-MNPQR-STVWX")
    assert r.status_code == 200, r.text
    kid = r.json()["id"]
    r = await _einloesen(client, app, neu, token, "ABCDE-FGHJK-MNPQR-STVWX")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == kid
    return token, alt, neu, kid


# ---------------------------------------------------------------------------
# Kopplung
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kopplung_anlegen_und_einloesen(client, app, _auth_signer):
    token, alt, neu, kid = await _gekoppelt(client, app, _auth_signer)
    r = await _stand(client, app, alt, token, kid)
    assert r.status_code == 200, r.text
    assert r.json()["eingeloest"] is True
    assert r.json()["neu_device_pubkey"] == neu.pubkey


@pytest.mark.asyncio
async def test_code_laesst_sich_nicht_zweimal_einloesen(client, app, _auth_signer):
    """Gegenprobe 1 des Auftrags. Ohne den ``eingeloest_am IS NULL``-Guard im
    UPDATE bekaeme das dritte Geraet ebenfalls 200 und duerfte danach die
    Stuecke abholen — ein Kopplungscode waere ein Mehrfachschluessel."""
    token, uid = await _register(_auth_signer)
    alt = Geraet(uid, "cert-alt")
    neu = Geraet(uid, "cert-neu")
    dritt = Geraet(uid, "cert-dritt")
    code = "11111-22222-33333-44444"

    assert (await _anlegen(client, app, alt, token, code)).status_code == 200
    assert (await _einloesen(client, app, neu, token, code)).status_code == 200

    r = await _einloesen(client, app, dritt, token, code)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "kopplung_schon_eingeloest"


@pytest.mark.asyncio
async def test_abgelaufener_code_wird_abgewiesen(
    client, app, session_factory, _auth_signer, monkeypatch
):
    """Gegenprobe 2 des Auftrags. Ohne die Frist-Bedingung im UPDATE waere ein
    einmal gezeigter Code unbegrenzt gueltig — ein Generalschluessel zum
    Konto (s. Modulkopf ``routes/kopplung.py``)."""
    from dcc_chat_gateway import config as chat_config

    token, uid = await _register(_auth_signer)
    alt = Geraet(uid, "cert-alt")
    neu = Geraet(uid, "cert-neu")
    code = "AAAAA-BBBBB-CCCCC-DDDDD"

    settings = chat_config.get_settings()
    monkeypatch.setattr(settings, "kopplung_code_gueltig_minuten", 0)
    r = await _anlegen(client, app, alt, token, code)
    assert r.status_code == 200, r.text

    # Der Code lief in derselben Sekunde ab; um nicht auf die Uhr zu warten,
    # wird die Zeile zusaetzlich in die Vergangenheit gesetzt.
    from dcc_chat_gateway.models import Kopplung
    from sqlalchemy import update as sa_update

    async with session_factory() as s:
        await s.execute(
            sa_update(Kopplung)
            .where(Kopplung.id == int(r.json()["id"]))
            .values(verfaellt_am=datetime.now(UTC) - timedelta(minutes=1))
        )
        await s.commit()

    r2 = await _einloesen(client, app, neu, token, code)
    assert r2.status_code == 410, r2.text
    assert r2.json()["detail"] == "kopplung_abgelaufen"


@pytest.mark.asyncio
async def test_selbes_geraet_kann_sich_nicht_koppeln(client, app, _auth_signer):
    token, uid = await _register(_auth_signer)
    alt = Geraet(uid, "cert-alt")
    code = "ZZZZZ-YYYYY-XXXXX-WWWWW"
    assert (await _anlegen(client, app, alt, token, code)).status_code == 200
    r = await _einloesen(client, app, alt, token, code)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "kopplung_selbes_geraet"


@pytest.mark.asyncio
async def test_fremdes_konto_sieht_den_code_nicht(client, app, _auth_signer):
    """Ein Code eines anderen Kontos ist ununterscheidbar von einem erfundenen
    — sonst waere die Fehlermeldung ein Orakel."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    code = "QQQQQ-QQQQQ-QQQQQ-QQQQQ"
    assert (await _anlegen(client, app, Geraet(uid_a, "c-a"), token_a, code)).status_code == 200

    r = await _einloesen(client, app, Geraet(uid_b, "c-b"), token_b, code)
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "kopplung_unbekannt"


@pytest.mark.asyncio
async def test_zu_viele_offene_kopplungen(client, app, _auth_signer, monkeypatch):
    from dcc_chat_gateway import config as chat_config

    token, uid = await _register(_auth_signer)
    alt = Geraet(uid, "cert-alt")
    monkeypatch.setattr(chat_config.get_settings(), "kopplung_max_offen_je_konto", 1)

    assert (await _anlegen(client, app, alt, token, "AAAAA")).status_code == 200
    r = await _anlegen(client, app, alt, token, "BBBBB")
    assert r.status_code == 429, r.text


# ---------------------------------------------------------------------------
# Umzug
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stueck_schieben_und_holen(client, app, _auth_signer):
    token, alt, neu, kid = await _gekoppelt(client, app, _auth_signer)
    daten = _b64_unpadded(b"verschluesseltes-stueck-0")

    assert (await _stueck(client, app, alt, token, kid, 0, daten)).status_code == 204
    assert (await _fertig(client, app, alt, token, kid, 1)).status_code == 204

    r = await _stueck_holen(client, app, neu, token, kid, 0)
    assert r.status_code == 200, r.text
    assert r.json()["daten"] == daten

    r = await _stand(client, app, neu, token, kid)
    assert r.json()["gesamt_stuecke"] == 1
    assert r.json()["vorhandene_stuecke"] == [0]


@pytest.mark.asyncio
async def test_abgebrochener_umzug_setzt_fort(client, app, _auth_signer):
    """Gegenprobe 3 des Auftrags.

    Nachgestellt wird ein Abriss nach dem dritten von fuenf Stuecken. Der
    Sender fragt danach den Stand ab und schiebt GENAU die fehlenden — ohne
    ``vorhandene_stuecke`` in der Stand-Antwort haette er keine Grundlage
    dafuer und muesste bei 0 beginnen.
    """
    token, alt, neu, kid = await _gekoppelt(client, app, _auth_signer)
    stuecke = [_b64_unpadded(f"stueck-{i}".encode()) for i in range(5)]

    for folge in range(3):
        assert (
            await _stueck(client, app, alt, token, kid, folge, stuecke[folge])
        ).status_code == 204

    stand = (await _stand(client, app, alt, token, kid)).json()
    assert stand["vorhandene_stuecke"] == [0, 1, 2]

    fehlend = [i for i in range(5) if i not in stand["vorhandene_stuecke"]]
    assert fehlend == [3, 4]
    for folge in fehlend:
        assert (
            await _stueck(client, app, alt, token, kid, folge, stuecke[folge])
        ).status_code == 204
    assert (await _fertig(client, app, alt, token, kid, 5)).status_code == 204

    geholt = []
    for folge in range(5):
        r = await _stueck_holen(client, app, neu, token, kid, folge)
        assert r.status_code == 200, r.text
        geholt.append(r.json()["daten"])
    assert geholt == stuecke


@pytest.mark.asyncio
async def test_wiederholtes_stueck_ersetzt_statt_zu_verdoppeln(client, app, _auth_signer):
    """Der Sender darf blind wiederholen — auch eine Position, die doch schon
    liegt (die Antwort auf den ersten Versuch ging verloren)."""
    token, alt, neu, kid = await _gekoppelt(client, app, _auth_signer)
    erst = _b64_unpadded(b"erster-versuch")
    zweit = _b64_unpadded(b"zweiter-versuch")

    assert (await _stueck(client, app, alt, token, kid, 7, erst)).status_code == 204
    assert (await _stueck(client, app, alt, token, kid, 7, zweit)).status_code == 204

    assert (await _stand(client, app, alt, token, kid)).json()["vorhandene_stuecke"] == [7]
    r = await _stueck_holen(client, app, neu, token, kid, 7)
    assert r.json()["daten"] == zweit


@pytest.mark.asyncio
async def test_drittes_geraet_darf_nicht_holen(client, app, _auth_signer):
    """Die Rollenpruefung (``kopplung_zugriff.py``) ist der Punkt, den man
    beim Nachbauen vergisst: ohne sie duerfte JEDES Geraet des Kontos die
    Stuecke abholen."""
    token, alt, _neu, kid = await _gekoppelt(client, app, _auth_signer)
    uid = int(pyjwt.decode(alt.cert, options={"verify_signature": False})["user_id"])
    dritt = Geraet(uid, "cert-dritt")
    daten = _b64_unpadded(b"geheim")
    assert (await _stueck(client, app, alt, token, kid, 0, daten)).status_code == 204

    r = await _stueck_holen(client, app, dritt, token, kid, 0)
    assert r.status_code == 404, r.text
    r = await _stueck(client, app, dritt, token, kid, 1, daten)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_neues_geraet_darf_nicht_schieben(client, app, _auth_signer):
    """Auch die Gegenrichtung ist gesperrt: ``neu`` holt, schiebt aber nicht."""
    token, _alt, neu, kid = await _gekoppelt(client, app, _auth_signer)
    r = await _stueck(client, app, neu, token, kid, 0, _b64_unpadded(b"x"))
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_stueck_zu_gross(client, app, _auth_signer, monkeypatch):
    from dcc_chat_gateway import config as chat_config

    token, alt, _neu, kid = await _gekoppelt(client, app, _auth_signer)
    monkeypatch.setattr(chat_config.get_settings(), "umzug_max_stueck_bytes", 8)
    r = await _stueck(client, app, alt, token, kid, 0, _b64_unpadded(b"x" * 64))
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "stueck_zu_gross"


@pytest.mark.asyncio
async def test_abschliessen_raeumt_stuecke_weg(client, app, session_factory, _auth_signer):
    from dcc_chat_gateway.models import Kopplung, UmzugStueck
    from sqlalchemy import func, select

    token, alt, neu, kid = await _gekoppelt(client, app, _auth_signer)
    assert (
        await _stueck(client, app, alt, token, kid, 0, _b64_unpadded(b"a"))
    ).status_code == 204

    assert (await _abschliessen(client, app, neu, token, kid)).status_code == 204

    async with session_factory() as s:
        assert (
            await s.execute(
                select(func.count()).select_from(Kopplung).where(Kopplung.id == int(kid))
            )
        ).scalar_one() == 0
        assert (
            await s.execute(
                select(func.count())
                .select_from(UmzugStueck)
                .where(UmzugStueck.kopplung_id == int(kid))
            )
        ).scalar_one() == 0

    # Wiederholtes Abschliessen kostet nichts — s. Docstring der Route.
    assert (await _abschliessen(client, app, neu, token, kid)).status_code == 204


@pytest.mark.asyncio
async def test_verfallslauf_raeumt_kopplung_und_stuecke(
    client, app, session_factory, _auth_signer
):
    from dcc_chat_gateway.kopplung_pflege import sweep_verfallene_kopplungen
    from dcc_chat_gateway.models import Kopplung, UmzugStueck
    from sqlalchemy import func, select
    from sqlalchemy import update as sa_update

    token, alt, _neu, kid = await _gekoppelt(client, app, _auth_signer)
    assert (
        await _stueck(client, app, alt, token, kid, 0, _b64_unpadded(b"a"))
    ).status_code == 204

    async with session_factory() as s:
        await s.execute(
            sa_update(Kopplung)
            .where(Kopplung.id == int(kid))
            .values(verfaellt_am=datetime.now(UTC) - timedelta(hours=1))
        )
        await s.commit()

    async with session_factory() as s:
        assert await sweep_verfallene_kopplungen(s) == 1

    async with session_factory() as s:
        # CASCADE: das Stueck faellt mit der Kopplung, nicht in einem
        # zweiten Lauf (s. ``kopplung_pflege.py``).
        assert (
            await s.execute(
                select(func.count())
                .select_from(UmzugStueck)
                .where(UmzugStueck.kopplung_id == int(kid))
            )
        ).scalar_one() == 0
