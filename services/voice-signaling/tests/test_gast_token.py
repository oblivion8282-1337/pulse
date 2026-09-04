"""``POST /gast/token`` — LiveKit-Token für einen Gast (Besprechungslink).

Der Kern ist die Kanalbindung: das Ticket nennt einen Kanal, der Rumpf des
Aufrufs auch, und beide MÜSSEN übereinstimmen. Ohne diesen Vergleich wäre aus
einem Ticket für den Besprechungsraum eines für jeden Sprachkanal der
Community geworden — der Gast bräuchte nur eine andere Zahl zu schicken.
"""

from __future__ import annotations

import uuid

import jwt
import pytest

from dcc_shared import gaeste

LIVEKIT_SECRET = "testsecrettestsecrettestsecrettestsecret"


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _eigene_kennung() -> str:
    """Eine Gast-Kennung, die nur zu DIESEM Test gehört.

    Die Redis-Tests hier laufen gegen den gemeinsamen Dev-Redis (die Fixture
    ``app`` bringt keinen mit). Feste Kennungen liessen zwei Worker unter
    ``-n`` an denselben Schlüsseln arbeiten — einer räumte dem anderen die
    Zeile weg, und das sah aus wie ein Flackern, war aber ein echter
    Zusammenstoss. (Prompt passiert, mit genau diesen Tests.)
    """
    return f"gast-{uuid.uuid4().int % 10**12}"


def _ticket(
    auth_signer,
    *,
    channel_id: str = "555",
    name: str = "Frau Meier",
    gast_id: str = "gast-77",
) -> str:
    return auth_signer.issue_gast(
        gast_id=gast_id,
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
    kennung = _eigene_kennung()
    await gaeste.sperren(redis, kennung, 60)
    try:
        r = await client.post(
            "/gast/token",
            json={"channel_id": "555"},
            headers=auth(_ticket(auth_signer, gast_id=kennung)),
        )
        assert r.status_code == 403
    finally:
        await redis.delete(gaeste.GAST_SPERRE_KEY.format(gast_id=kennung))
        await redis.aclose()
        app.state.redis = None


@pytest.mark.asyncio
async def test_rauswurf_nimmt_dem_gast_die_zuschau_adresse(app, auth_signer):
    """Ein Rauswurf ohne das waere unvollstaendig.

    Das WHEP-Lese-Token haengt an Kanal und Streamer, nicht am Zuschauer, und
    der auth-hook nimmt es die volle Stunde lang an, ohne es zu verbrauchen.
    Der Rausgeworfene bekaeme also keine NEUE Adresse mehr — die bereits
    geholte liefe weiter.
    """
    import os

    from dcc_shared.streaming import read_cache_key, token_key
    from redis.asyncio import Redis

    redis = Redis.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:6380/0").replace(
            "localhost", "127.0.0.1"
        )
    )
    kennung = _eigene_kennung()
    tok = f"tok-{uuid.uuid4().hex}"
    zeiger = read_cache_key(kennung, "555", "42", 0)
    datensatz = token_key(tok)
    try:
        await redis.set(zeiger, tok)
        await redis.set(datensatz, '{"scope":"read"}')

        gefallen = await gaeste.lese_token_loeschen(redis, kennung)

        assert gefallen == 2, "Zeiger UND Datensatz muessen fallen"
        assert await redis.exists(zeiger) == 0
        # Der Datensatz ist der eigentliche Zweck: nur sein Wegfall macht die
        # schon ausgehaendigte Adresse ungueltig.
        assert await redis.exists(datensatz) == 0
    finally:
        await redis.delete(zeiger, datensatz)
        await redis.aclose()


@pytest.mark.asyncio
async def test_lese_token_eines_anderen_bleiben_unberuehrt(app):
    """Die Suche darf nur die Token DIESES Gastes treffen.

    Der Doppelpunkt im Muster trennt ``gast-7`` sauber von ``gast-77`` — ohne
    ihn naehme ein Rauswurf dem falschen Zuschauer das Bild weg.
    """
    import os

    from dcc_shared.streaming import read_cache_key
    from redis.asyncio import Redis

    redis = Redis.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:6380/0").replace(
            "localhost", "127.0.0.1"
        )
    )
    # Beide Kennungen teilen sich absichtlich einen Präfix: ``<n>`` und
    # ``<n>7`` — daran hängt die Aussage des Tests.
    kurz = _eigene_kennung()
    lang = f"{kurz}7"
    meiner = read_cache_key(kurz, "555", "42", 0)
    fremder = read_cache_key(lang, "555", "42", 0)
    try:
        await redis.set(meiner, "tok-a")
        await redis.set(fremder, "tok-b")
        await gaeste.lese_token_loeschen(redis, kurz)
        assert await redis.exists(meiner) == 0
        assert await redis.exists(fremder) == 1
    finally:
        await redis.delete(meiner, fremder)
        await redis.aclose()
