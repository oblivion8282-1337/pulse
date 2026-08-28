"""Serverticket — bauen und signieren.

Der Prüfstein, an dem die Migration hängt, ist
``test_legacy_uid_stimmt_mit_der_selfhost_rechnung_ueberein``: Die Cloud muss
dieselbe Zahl treffen, die ein Self-Host bisher in seinen Spalten führt. Trifft
sie daneben, zeigt die Umschreibung auf Zeilen, die es nicht gibt — und zwar
lautlos, weil ein ``UPDATE`` ohne Treffer kein Fehler ist.
"""

import base64

import jwt as pyjwt

from dcc_auth.server_ticket import TICKET_FRIST_S, ZWECK, baue_ticket, legacy_uid


def test_ticket_traegt_zweck_publikum_und_frist():
    roh = baue_ticket(
        user_id="73315227868860416",
        instance_id=86083174400004096,
        name="GordonBradley",
        avatar="abc123",
        amr=["pwd"],
        acr="0",
        pairwise_salt=b"\x01" * 32,
    )
    c = pyjwt.decode(roh, options={"verify_signature": False}, audience="86083174400004096")
    assert c["purpose"] == ZWECK
    assert c["aud"] == "86083174400004096"
    assert c["sub"] == "73315227868860416"
    assert c["name"] == "GordonBradley"
    assert c["amr"] == ["pwd"]
    assert c["exp"] - c["iat"] == TICKET_FRIST_S

    # jti ist da und je Aufruf verschieden — daran haengt die Einmal-Einloesung
    # beim Empfaenger. Zwei gleiche jti hiessen: das zweite Ticket gilt nie.
    zweites = pyjwt.decode(
        baue_ticket(
            user_id="73315227868860416",
            instance_id=86083174400004096,
            name="G",
            avatar=None,
            amr=[],
            acr="0",
            pairwise_salt=b"\x01" * 32,
        ),
        options={"verify_signature": False},
        audience="86083174400004096",
    )
    assert c["jti"] != zweites["jti"]


def test_legacy_uid_stimmt_mit_der_selfhost_rechnung_ueberein():
    """Die Cloud rechnet vorwaerts, was der Self-Host nicht zurueckrechnen kann.

    Beide Fassungen stehen bewusst getrennt (``dcc_auth`` haengt nicht von
    ``dcc_chat_gateway`` ab). Dass sie dasselbe liefern, haelt dieser Test fest —
    sonst faellt eine Abweichung erst auf, wenn Bestandsdaten verwaist sind.
    """
    from dcc_chat_gateway.credential_validator import compute_pairwise_sub
    from dcc_shared.session_tokens import synthesize_self_host_user_id

    salt = b"\x02" * 32
    seed = base64.urlsafe_b64encode(salt).rstrip(b"=").decode()
    erwartet = synthesize_self_host_user_id(
        compute_pairwise_sub("73315227868860416", 86083174400004096, seed)
    )
    assert legacy_uid("73315227868860416", 86083174400004096, salt) == erwartet


def test_ticket_ist_mit_dem_cloud_schluessel_signiert_und_traegt_kid():
    roh = baue_ticket(
        user_id="1",
        instance_id=2,
        name="x",
        avatar=None,
        amr=[],
        acr="0",
        pairwise_salt=b"\x03" * 32,
    )
    kopf = pyjwt.get_unverified_header(roh)
    assert kopf["kid"]
    assert kopf["alg"] == "RS256"
