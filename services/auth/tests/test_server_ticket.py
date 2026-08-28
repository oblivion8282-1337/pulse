"""Serverticket — bauen und signieren."""

import jwt as pyjwt

from dcc_auth.server_ticket import TICKET_FRIST_S, ZWECK, baue_ticket


def test_ticket_traegt_zweck_publikum_und_frist():
    roh = baue_ticket(
        user_id="73315227868860416",
        instance_id=86083174400004096,
        name="GordonBradley",
        avatar="abc123",
        amr=["pwd"],
        acr="0",
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
        ),
        options={"verify_signature": False},
        audience="86083174400004096",
    )
    assert c["jti"] != zweites["jti"]


def test_ticket_ist_mit_dem_cloud_schluessel_signiert_und_traegt_kid():
    roh = baue_ticket(
        user_id="1",
        instance_id=2,
        name="x",
        avatar=None,
        amr=[],
        acr="0",
    )
    kopf = pyjwt.get_unverified_header(roh)
    assert kopf["kid"]
    assert kopf["alg"] == "RS256"
