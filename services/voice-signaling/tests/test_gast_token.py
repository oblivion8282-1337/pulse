"""``POST /gast/token`` — LiveKit-Token für einen Gast (Besprechungslink).

Der Kern ist die Kanalbindung: das Ticket nennt einen Kanal, der Rumpf des
Aufrufs auch, und beide MÜSSEN übereinstimmen. Ohne diesen Vergleich wäre aus
einem Ticket für den Besprechungsraum eines für jeden Sprachkanal der
Community geworden — der Gast bräuchte nur eine andere Zahl zu schicken.
"""

from __future__ import annotations

import jwt
import pytest

from dcc_shared import gaeste

LIVEKIT_SECRET = "testsecrettestsecrettestsecrettestsecret"


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _ticket(auth_signer, *, channel_id: str = "555", name: str = "Frau Meier") -> str:
    return auth_signer.issue_gast(
        gast_id="gast-77",
        guild_id="9",
        channel_id=channel_id,
        name=name,
        ttl_s=3600,
    )


@pytest.mark.asyncio
async def test_gast_token_happy_path(client, auth_signer):
    r = await client.post(
        "/gast/token",
        json={"channel_id": "555"},
        headers=auth(_ticket(auth_signer)),
    )
    assert r.status_code == 200, r.text
    payload = jwt.decode(
        r.json()["token"],
        LIVEKIT_SECRET,
        algorithms=["HS256"],
        options={"verify_aud": False},
    )
    assert payload["sub"] == "gast-77"
    assert payload["name"] == "Frau Meier"
    assert payload["video"]["room"] == "channel-555"
    assert payload["video"]["roomJoin"] is True


@pytest.mark.asyncio
async def test_gast_darf_nur_mikrofon_und_kamera(client, auth_signer):
    """Kein Bildschirm teilen, kein Datenkanal.

    Der Datenkanal trägt in Pulse Fernsteuer- und Zeigerdaten — er gehört
    einem Gast nicht in die Hand, auch nicht „nur zum Zusehen".
    """
    r = await client.post(
        "/gast/token", json={"channel_id": "555"}, headers=auth(_ticket(auth_signer))
    )
    video = jwt.decode(
        r.json()["token"], LIVEKIT_SECRET, algorithms=["HS256"], options={"verify_aud": False}
    )["video"]
    quellen = set(video.get("canPublishSources") or [])
    assert quellen == {"microphone", "camera"}
    assert video.get("canPublishData") in (False, None)


@pytest.mark.asyncio
async def test_ticket_fuer_anderen_kanal_wird_abgewiesen(client, auth_signer):
    r = await client.post(
        "/gast/token",
        json={"channel_id": "666"},
        headers=auth(_ticket(auth_signer, channel_id="555")),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_zugangstoken_eines_nutzers_ist_hier_wertlos(client, auth_signer):
    """Und umgekehrt: die Gast-Route nimmt kein Konto-Token an.

    Die Trennung liegt im ``typ``-Claim und ist fail-closed auf beiden Seiten —
    ``/token`` weist ein Gast-Ticket ab, ``/gast/token`` ein Zugangstoken.
    """
    r = await client.post(
        "/gast/token",
        json={"channel_id": "555"},
        headers=auth(auth_signer.issue_access(42, "alice")),
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_gast_ticket_oeffnet_die_mitglieder_route_nicht(client, auth_signer):
    r = await client.post(
        "/token", json={"channel_id": "555"}, headers=auth(_ticket(auth_signer))
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_rausgeworfener_gast_kommt_nicht_zurueck(client, auth_signer, app):
    """Die Sperre gilt für das Ticket, nicht für die Verbindung.

    Ein Rauswurf, den nur LiveKit kennt, wäre in dem Moment aufgehoben, in dem
    der Gast sich ein neues Token holt — und das tut sein Klient von selbst.

    Die App-Fixture fährt ohne Lebenszyklus, hat also kein Redis am Zustand;
    hier wird eines angehängt, weil genau der Redis-Weg geprüft werden soll.
    """
    import os

    from redis.asyncio import Redis

    redis = Redis.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:6380/0").replace(
            "localhost", "127.0.0.1"
        )
    )
    app.state.redis = redis
    await gaeste.sperren(redis, "gast-77", 60)
    try:
        r = await client.post(
            "/gast/token", json={"channel_id": "555"}, headers=auth(_ticket(auth_signer))
        )
        assert r.status_code == 403
    finally:
        await redis.delete(gaeste.GAST_SPERRE_KEY.format(gast_id="gast-77"))
        await redis.aclose()
        app.state.redis = None
