"""APNs-VoIP-Mechanik — ohne Apple und ohne echten Schlüssel prüfbar.

Was hier NICHT geprüft wird, und zwar bewusst: dass Apple den Push annimmt.
Dafür braucht es den echten ``.p8``, ein echtes Gerät und einen echten Token;
diese Datei deckt die Rechnung ab, die auch dann noch falsch sein könnte —
Statusdeutung, Kopfzeilen, Umgebungs-Weiche, Fehlkonfiguration.
"""

from __future__ import annotations

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from dcc_chat_gateway import apns_voip


def _zugang(sandbox: bool = True) -> apns_voip.ApnsZugang:
    schluessel = ec.generate_private_key(ec.SECP256R1())
    pem = schluessel.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return apns_voip.ApnsZugang(
        schluessel_pem=pem,
        key_id="ABC1234567",
        team_id="TEAM123456",
        bundle_id="com.howispulse.app",
        sandbox=sandbox,
    )


def test_jwt_traegt_kid_und_iss():
    """``kid`` gehört in den KOPF, ``iss`` in die Nutzlast — vertauscht weist
    APNs mit ``InvalidProviderToken`` ab, und das sieht wie ein falscher
    Schlüssel aus."""
    zugang = _zugang()
    token = apns_voip.jwt_bauen(zugang, jetzt=1_700_000_000)
    kopf = pyjwt.get_unverified_header(token)
    assert kopf["kid"] == "ABC1234567"
    assert kopf["alg"] == "ES256"
    nutzlast = pyjwt.decode(token, options={"verify_signature": False})
    assert nutzlast["iss"] == "TEAM123456"
    assert nutzlast["iat"] == 1_700_000_000


def test_umgebung_entscheidet_den_host():
    """Ein Gerätetoken gehört zu GENAU EINER Umgebung; der falsche Host
    antwortet ``BadDeviceToken`` und das sieht nach kaputtem Token aus."""
    assert apns_voip.host_fuer(True) == apns_voip.SANDBOX_HOST
    assert apns_voip.host_fuer(False) == apns_voip.PROD_HOST
    assert apns_voip.SANDBOX_HOST != apns_voip.PROD_HOST


def test_kopfzeilen_setzen_voip_und_den_voip_topic():
    zugang = _zugang()
    kopf = apns_voip.kopfzeilen(zugang, "tok")
    assert kopf["apns-push-type"] == "voip"
    # Der Topic ist NICHT die Bundle-ID, sondern Bundle-ID + ".voip".
    assert kopf["apns-topic"] == "com.howispulse.app.voip"
    assert kopf["apns-priority"] == "10"
    # Verwerfen ist besser als zu spät: ein Push, der nach zwei Minuten
    # eintrifft, lässt für ein Gespräch klingeln, das längst vorbei ist.
    assert kopf["apns-expiration"] == "0"
    assert kopf["authorization"] == "bearer tok"


@pytest.mark.parametrize(
    ("status", "grund", "erwartet"),
    [
        (200, None, "ok"),
        (410, "Unregistered", "dead"),
        (400, "BadDeviceToken", "dead"),
        (400, "DeviceTokenNotForTopic", "dead"),
        # Die drei 4xx, die KEINEN Token kosten dürfen — sonst räumt eine
        # Störung oder ein Konfigurationsfehler die Registrierungen leer.
        (403, "ExpiredProviderToken", "warn"),
        (403, "InvalidProviderToken", "warn"),
        (429, "TooManyRequests", "warn"),
        (400, "PayloadTooLarge", "warn"),
        (500, None, "warn"),
        (503, None, "warn"),
    ],
)
def test_deutung(status, grund, erwartet):
    assert apns_voip.deutung(status, grund) == erwartet


def test_ohne_konfiguration_kein_zugang():
    """Der Normalfall einer Installation ohne eigenen APNs-Schlüssel: kein
    Zugang, keine Pushs, sonst ändert sich nichts."""

    class Leer:
        pass

    assert apns_voip.zugang_aus_einstellungen(Leer()) is None


def test_unlesbare_schluesseldatei_ist_kein_absturz(tmp_path):
    class Einstellungen:
        apns_key_file = str(tmp_path / "gibt-es-nicht.p8")
        apns_key_id = "ABC1234567"
        apns_team_id = "TEAM123456"
        apns_bundle_id = "com.howispulse.app"
        apns_sandbox = True

    assert apns_voip.zugang_aus_einstellungen(Einstellungen()) is None


def test_jwt_vorrat_gibt_dasselbe_zurueck_und_erneuert_nach_ablauf():
    """APNs bittet ausdrücklich darum, nicht je Nachricht ein JWT zu bauen —
    und die ES256-Signatur kostet Zeit, die ein klingelndes Telefon nicht hat."""
    zugang = _zugang()
    apns_voip.jwt_vorrat_leeren()
    erstes = apns_voip.jwt_mit_vorrat(zugang, jetzt=1000.0)
    assert apns_voip.jwt_mit_vorrat(zugang, jetzt=1000.0 + 60) == erstes
    nach_ablauf = apns_voip.jwt_mit_vorrat(
        zugang, jetzt=1000.0 + apns_voip.JWT_LAUFZEIT_S + 1
    )
    assert nach_ablauf != erstes
    apns_voip.jwt_vorrat_leeren()
