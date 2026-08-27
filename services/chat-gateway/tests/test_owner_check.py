"""Tests fuer ``GET /.well-known/pulse-owner-check``.

Der Fall, um den es geht: Am 2026-08-27 konnte ein Self-Hoster auf seinem
eigenen Server keine Community anlegen. Grund war, dass seine Instanz ihn nicht
als Betreiber erkannte — und das war von aussen mit keinem Mittel feststellbar.
Die konfigurierte Owner-Kennung stand allein in seiner ``.env`` und in einer
Log-Zeile, an die nur jemand mit Zugriff auf die Maschine kam.

Dieser Endpunkt beantwortet die Frage aus der Ferne, ohne die Kennung
preiszugeben: die Cloud legt der Anfrage ein von ihr signiertes, kurzlebiges
Token bei, in dem die ERWARTETE Kennung steht, und bekommt drei Ja/Nein-Bits
zurueck. Ohne gueltige Cloud-Signatur antwortet er niemandem — sonst waere er
ein Orakel dafuer, welches Konto welchen Server betreibt.
"""

from __future__ import annotations

import json
import time

import jwt
import pytest

from dcc_chat_gateway.credential_validator import REDIS_CLOUD_JWKS_KEY, REDIS_JWKS_KEY
from dcc_chat_gateway.routes import owner_check

PFAD = "/.well-known/pulse-owner-check"
MEINE_INSTANZ = 86083174400004096
MEIN_KONTO = 73315227868860416
FREMDES_KONTO = 11111111111111111


async def _jwks_bereitstellen(app, signer) -> None:
    """Die Cloud-JWKS in den Cache legen, den der Poller sonst warm haelt.

    **Unter BEIDEN Schluesseln, und das ist kein Schlendrian.** Welchen der
    Pruefer liest, entscheidet er anhand der Betriebsart — die er aus der
    ECHTEN Umgebung liest (``credential_validator`` importiert
    ``get_settings`` beim Namen und haelt damit die LRU-gecachte
    Originalfunktion; das Test-Settings-Objekt geht daran vorbei). Allein
    gefahren steht sie auf ``self-host``, im Volllauf auf ``cloud`` — derselbe
    Test pruefte dann einmal die Signatur und einmal nur, dass ein leerer
    Cache abweist. Unter beiden Namen abgelegt, prueft er ueberall dasselbe.
    """
    jwks = json.dumps(signer.jwks())
    await app.state.redis.set(REDIS_CLOUD_JWKS_KEY, jwks)
    await app.state.redis.set(REDIS_JWKS_KEY, jwks)


def _kid(signer) -> str:
    """Der echte kid des Signers.

    Ein ausgedachter kid liesse jeden Test hier gruen werden, ohne dass je eine
    Signatur geprueft wurde — abgelehnt wuerde dann blosss der unbekannte
    Schluessel.
    """
    return signer.jwks()["keys"][0]["kid"]


def _cloud_token(
    signer,
    *,
    purpose: str = "owner-check",
    instance_id: int | str = MEINE_INSTANZ,
    owner_user_id: int | str = MEIN_KONTO,
    exp_delta: int = 60,
    iat_versatz: int = 0,
) -> str:
    """Ein Token, wie die Cloud es fuer die Erreichbarkeitspruefung ausstellt."""
    now = int(time.time())
    return jwt.encode(
        {
            "purpose": purpose,
            "instance_id": str(instance_id),
            "owner_user_id": str(owner_user_id),
            "iat": now + iat_versatz,
            "exp": now + exp_delta,
        },
        signer._private_key,
        algorithm="RS256",
        headers={"kid": _kid(signer)},
    )


def _kopf(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- Auskunft -------------------------------------------------------------


@pytest.mark.asyncio
async def test_treffer(client, app, _auth_signer, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = MEIN_KONTO
    await _jwks_bereitstellen(app, _auth_signer)

    antwort = await client.get(PFAD, headers=_kopf(_cloud_token(_auth_signer)))

    assert antwort.status_code == 200
    assert antwort.json() == {
        "modus_self_host": True,
        "owner_konfiguriert": True,
        "stimmt_ueberein": True,
    }


@pytest.mark.asyncio
async def test_andere_kennung(client, app, _auth_signer, _isolate_chat_settings):
    """Der haeufigste echte Fall: konfiguriert ist IRGENDEINE Kennung, nur nicht
    die des Fragenden — eine recycelte ``.env`` vom Vorgaengerserver etwa."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = FREMDES_KONTO
    await _jwks_bereitstellen(app, _auth_signer)

    antwort = await client.get(PFAD, headers=_kopf(_cloud_token(_auth_signer)))

    assert antwort.status_code == 200
    daten = antwort.json()
    assert daten["owner_konfiguriert"] is True
    assert daten["stimmt_ueberein"] is False


@pytest.mark.asyncio
async def test_ohne_owner_id(client, app, _auth_signer, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = 0
    await _jwks_bereitstellen(app, _auth_signer)

    antwort = await client.get(PFAD, headers=_kopf(_cloud_token(_auth_signer)))

    assert antwort.status_code == 200
    daten = antwort.json()
    assert daten["owner_konfiguriert"] is False
    assert daten["stimmt_ueberein"] is False


@pytest.mark.asyncio
async def test_cloud_modus_meldet_sich_als_solcher(
    client, app, _auth_signer, _isolate_chat_settings
):
    """``is_owner_admin`` haengt auch am Modus (``cert_login.py``): steht der
    nicht auf ``self-host``, wird niemand Admin, egal wie richtig die Kennung
    ist. Der Befund muss das trennen koennen."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = MEIN_KONTO
    _isolate_chat_settings.pulse_instance_mode = "cloud"
    await _jwks_bereitstellen(app, _auth_signer)

    antwort = await client.get(PFAD, headers=_kopf(_cloud_token(_auth_signer)))

    assert antwort.status_code == 200
    assert antwort.json()["modus_self_host"] is False


# --- Fail-closed ----------------------------------------------------------


@pytest.mark.asyncio
async def test_ohne_token(client, app, _auth_signer, _isolate_chat_settings):
    await _jwks_bereitstellen(app, _auth_signer)
    assert (await client.get(PFAD)).status_code == 401


@pytest.mark.asyncio
async def test_abgelaufenes_token(client, app, _auth_signer, _isolate_chat_settings):
    """Deutlich abgelaufen — jenseits jeder zugestandenen Uhr-Toleranz."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    await _jwks_bereitstellen(app, _auth_signer)

    token = _cloud_token(_auth_signer, exp_delta=-(owner_check.ZEITTOLERANZ_S + 30))

    assert (await client.get(PFAD, headers=_kopf(token))).status_code == 401


@pytest.mark.asyncio
async def test_nachgehende_serveruhr_verhindert_die_auskunft_nicht(
    client, app, _auth_signer, _isolate_chat_settings
):
    """Geht die Uhr dieses Servers nach, ist das Token aus SEINER Sicht knapp
    abgelaufen, obwohl die Cloud es gerade erst ausgestellt hat.

    Ohne Toleranz waere das Glied auf so einer Maschine dauerhaft tot — und der
    Befund zeigte auf „hat die Cloud nie erreicht" statt auf die Uhr.
    """
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = MEIN_KONTO
    await _jwks_bereitstellen(app, _auth_signer)

    token = _cloud_token(_auth_signer, exp_delta=-(owner_check.ZEITTOLERANZ_S // 2))

    antwort = await client.get(PFAD, headers=_kopf(token))
    assert antwort.status_code == 200
    assert antwort.json()["stimmt_ueberein"] is True


@pytest.mark.asyncio
async def test_vorgehende_serveruhr_verhindert_die_auskunft_nicht(
    client, app, _auth_signer, _isolate_chat_settings
):
    """Der umgekehrte Fall: aus Sicht des Servers liegt das Token in der
    Zukunft. PyJWT wirft dafuer ``ImmatureSignatureError`` — ein ``iat`` in der
    lokalen Zukunft ist hier Versatz, kein Angriff."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = MEIN_KONTO
    await _jwks_bereitstellen(app, _auth_signer)

    token = _cloud_token(_auth_signer, iat_versatz=600, exp_delta=660)

    assert (await client.get(PFAD, headers=_kopf(token))).status_code == 200


@pytest.mark.asyncio
async def test_falscher_zweck(client, app, _auth_signer, _isolate_chat_settings):
    """Ein Token, das die Cloud fuer etwas anderes ausgestellt hat (etwa
    ``watchtower-update``), darf hier nicht gelten — sonst genuegt EIN
    abgefangenes Cloud-Token fuer jeden Zweck."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    await _jwks_bereitstellen(app, _auth_signer)

    token = _cloud_token(_auth_signer, purpose="watchtower-update")

    assert (await client.get(PFAD, headers=_kopf(token))).status_code == 401


@pytest.mark.asyncio
async def test_token_fuer_eine_andere_instanz(
    client, app, _auth_signer, _isolate_chat_settings
):
    """DER wichtige Riegel: ohne ihn liesse sich ein Token, das die Cloud fuer
    Server A ausgestellt hat, gegen Server B richten — und dessen Betreiber
    erfuehre so, ob Konto X seinen Nachbarn betreibt."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    _isolate_chat_settings.pulse_instance_owner_id = MEIN_KONTO
    await _jwks_bereitstellen(app, _auth_signer)

    token = _cloud_token(_auth_signer, instance_id=12345678901234567)

    assert (await client.get(PFAD, headers=_kopf(token))).status_code == 401


@pytest.mark.asyncio
async def test_fremde_signatur(client, app, _auth_signer, _isolate_chat_settings):
    """Selbst signiert zaehlt nicht — sonst koennte sich jeder die Auskunft
    selbst ausstellen."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    await _jwks_bereitstellen(app, _auth_signer)

    fremd = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = int(time.time())
    token = jwt.encode(
        {
            "purpose": "owner-check",
            "instance_id": str(MEINE_INSTANZ),
            "owner_user_id": str(MEIN_KONTO),
            "iat": now,
            "exp": now + 60,
        },
        fremd,
        algorithm="RS256",
        headers={"kid": _kid(_auth_signer)},
    )

    assert (await client.get(PFAD, headers=_kopf(token))).status_code == 401


@pytest.mark.asyncio
async def test_kalter_jwks_cache_antwortet_nicht(
    client, app, _auth_signer, _isolate_chat_settings
):
    """Ohne JWKS kann die Signatur nicht geprueft werden. Dann gibt es keine
    Auskunft — nicht etwa eine ungepruefte."""
    _isolate_chat_settings.pulse_instance_id = MEINE_INSTANZ
    await app.state.redis.delete(REDIS_CLOUD_JWKS_KEY, REDIS_JWKS_KEY)

    assert (
        await client.get(PFAD, headers=_kopf(_cloud_token(_auth_signer)))
    ).status_code == 401
