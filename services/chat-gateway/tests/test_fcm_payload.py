"""Der FCM-Message-Bau muss durch den echten firebase-Encoder.

Befund 2026-10-06: messaging.ApsSound existierte nicht — der Versand
brach still im except-All, und die stubbenden Tests konnten das nicht
sehen. Dieser Test konstruiert das echte Message-Objekt und encodiert
es (kein Netzwerk).
"""
import pytest

from dcc_chat_gateway.fcm import _build_dm_message


@pytest.fixture
def payload():
    return {
        "type": "dm",
        "title": "max",
        "body": "Neue Direktnachricht",
        "channel_id": "100905606516318208",
    }


def test_dm_message_encodiert_mit_ios_payload(payload):
    import json
    from firebase_admin import messaging
    from firebase_admin.messaging import _messaging_encoder

    msg = _build_dm_message(payload=payload, token="testtoken")
    # Der echte Weg aus messaging.send(): json.dumps mit dem internen
    # MessageEncoder — schlägt bei kaputten aps-Klassen sofort aus.
    d = json.loads(json.dumps(msg, cls=_messaging_encoder.MessageEncoder))
    aps = d["apns"]["payload"]["aps"]
    assert aps["alert"]["title"] == "max"
    assert aps["alert"]["body"] == "Neue Direktnachricht"
    assert aps["sound"] == "pulse-push.caf"
    assert d["apns"]["headers"]["apns-interruption-level"] == "time-sensitive"
    assert d["apns"]["headers"]["apns-push-type"] == "alert"
    assert d["token"] == "testtoken"
    assert d["android"]["notification"]["channel_id"] == "messages"
    assert d["android"]["data"]["channel_id"] == "100905606516318208"


def _kodiere(msg):
    """Der echte Weg aus messaging.send(): json.dumps mit dem internen
    MessageEncoder — schlägt bei kaputten aps-Klassen sofort aus."""
    import json

    from firebase_admin.messaging import _messaging_encoder

    return json.loads(json.dumps(msg, cls=_messaging_encoder.MessageEncoder))


def test_badge_landet_im_aps(payload):
    """Die Zahl am App-Icon kann NUR aus dem Push kommen (JS schläft)."""
    d = _kodiere(_build_dm_message(payload=payload, token="t", badge=7))
    assert d["apns"]["payload"]["aps"]["badge"] == 7


def test_badge_null_raeumt_die_plakette(payload):
    """0 ist eine Aussage, nicht „unbekannt" — iOS nimmt das Badge dann weg."""
    d = _kodiere(_build_dm_message(payload=payload, token="t", badge=0))
    assert d["apns"]["payload"]["aps"]["badge"] == 0


def test_ohne_badge_steht_kein_feld_im_aps(payload):
    """Unbekannt heisst schweigen: ein fehlendes `badge` lässt die Zahl am
    Gerät stehen, eine 0 würde sie löschen. Der Unterschied ist die ganze
    Absicherung gegen ein Redis, das gerade nicht antwortet."""
    d = _kodiere(_build_dm_message(payload=payload, token="t", badge=None))
    assert "badge" not in d["apns"]["payload"]["aps"]


def test_deeplink_daten_erreichen_auch_ios(payload):
    """`data` nur im Android-Block liess den iOS-Tap ohne Ziel (Befund
    Review 08.10.) — der Tap-Handler liest `notification.data.channel_id`."""
    d = _kodiere(_build_dm_message(payload=payload, token="t", badge=None))
    assert d["data"]["channel_id"] == "100905606516318208"
