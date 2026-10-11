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
    # Zeitkritisch ist ein Feld der NUTZLAST (`aps.interruption-level`) —
    # als Kopf übergeht APNs es still (Bughunt 2026-10-11, T16).
    assert aps["interruption-level"] == "time-sensitive"
    assert "apns-interruption-level" not in d["apns"]["headers"]
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


# ---------------------------------------------------------------------------
# Anhang-Hinweis (Eigentuemer-Entscheid 2026-10-08)


def test_body_ohne_anhang_bleibt_inhaltsfrei():
    from dcc_chat_gateway.fcm import dm_body

    assert dm_body(False) == "Neue Nachricht"


def test_body_mit_anhang_sagt_es_ohne_den_inhalt_zu_verraten():
    """Der Server WEISS, dass ein Anhang dranhaengt (Bezugszeilen), aber nie,
    was drin ist. Genau diese Grenze soll der Text abbilden: kein Dateiname,
    keine Art, keine Groesse."""
    from dcc_chat_gateway.fcm import dm_body

    text = dm_body(True)
    assert text == "Hat dir einen Anhang geschickt"
    assert "." not in text  # kein Dateiname durchgerutscht


def test_anhang_hinweis_landet_im_aps_und_in_der_notification(payload):
    """Beide Stellen muessen denselben Text tragen — iOS zeigt `aps.alert`,
    Android die `notification`. Stuenden dort verschiedene Texte, saehe
    dieselbe Nachricht je nach Geraet anders aus."""
    from dcc_chat_gateway.fcm import _build_dm_message, dm_body

    p = {**payload, "body": dm_body(True)}
    d = _kodiere(_build_dm_message(payload=p, token="t", badge=1))
    assert d["apns"]["payload"]["aps"]["alert"]["body"] == "Hat dir einen Anhang geschickt"
    assert d["notification"]["body"] == "Hat dir einen Anhang geschickt"


def test_kategorie_verbindet_die_meldung_mit_den_aktionen(payload):
    """Ohne `category` zeigt iOS die Meldung ohne den Antworten-Knopf an —
    lautlos. Der Bezeichner muss dem in AppDelegate.swift entsprechen."""
    from dcc_chat_gateway.fcm import DM_KATEGORIE

    d = _kodiere(_build_dm_message(payload=payload, token="t", badge=None))
    assert d["apns"]["payload"]["aps"]["category"] == DM_KATEGORIE == "dm"
