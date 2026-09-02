"""Instanz-Einstellung für die Kanal-Erstellung (Konzept §2a).

Modus „regulär" (Vorgabe): Klartext-Kanäle wie bisher. Modus
„ablage_only": Neuanlage nur mit `ablage=true` — und ein solcher Kanal
ist serverblind: Nachrichten-Post und Klartext-Anhang-Upload werden
verworfen, `chat.messages` bleibt für ihn für immer leer.
"""

from __future__ import annotations

import pytest

@pytest.fixture
def policy():
    """Setzt die Instanz-Policy für einen Test und räumt ab."""

    import dcc_chat_gateway.config as chat_config

    def _stellen(wert: str) -> None:
        chat_config.get_settings().channel_creation_policy = wert

    yield _stellen
    _stellen("regular")



@pytest.mark.asyncio
async def test_regulaer_modus_erlaubt_klartextkanal(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    r = await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "general"},
        headers=auth(t1),
    )
    assert r.status_code == 201
    assert r.json()["ablage"] is False


@pytest.mark.asyncio
async def test_ablage_kanal_laesst_sich_anlegen_und_zeigt_das_flag(client, _auth_signer):
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    r = await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "ablage-raum", "ablage": True},
        headers=auth(t1),
    )
    assert r.status_code == 201
    assert r.json()["ablage"] is True


@pytest.mark.asyncio
async def test_ablage_only_mode_sperrt_klartextkanal(client, _auth_signer, policy):
    policy("ablage_only")
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()

    r = await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "klartext-ist-gesperrt"},
        headers=auth(t1),
    )
    assert r.status_code == 403
    assert "requires_ablage" in r.text


@pytest.mark.asyncio
async def test_ablage_only_mode_erplaubt_ablage_kanal(client, _auth_signer, policy):
    policy("ablage_only")
    t1, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    r = await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "ablage-raum", "ablage": True},
        headers=auth(t1),
    )
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_nachricht_in_ablage_kanal_wird_verworfen(client, _auth_signer, policy):
    policy("ablage_only")
    t1, user_id = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    c = (await client.post(
        f"/guilds/{g['id']}/channels",
        json={"name": "ablage-raum", "ablage": True},
        headers=auth(t1),
    )).json()

    r = await client.post(
        f"/channels/{c['id']}/messages",
        json={"content": "sollte nie ankommen"},
        headers=auth(t1),
    )
    assert r.status_code == 403

    # Und in der Datenbank ist nichts gelandet — der Server bleibt blind.
    count = await _messages_count(client, t1, c["id"])
    assert count == 0


@pytest.mark.asyncio
async def test_capabilities_zeigen_die_policy(client, _auth_signer, policy):
    t1, _ = await _register_user(_auth_signer)

    r = await client.get("/capabilities", headers=auth(t1))
    assert r.json()["channel_creation_policy"] == "regular"

    policy("ablage_only")
    r = await client.get("/capabilities", headers=auth(t1))
    assert r.json()["channel_creation_policy"] == "ablage_only"


# ---------------------------------------------------------------------------
# Hilfsstücke (Muster wie test_rest.py)
# ---------------------------------------------------------------------------

def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer):
    import random

    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


async def _messages_count(client, token: str, channel_id: str) -> int:
    r = await client.get(f"/channels/{channel_id}/messages", headers=auth(token))
    if r.status_code != 200:
        return -1
    return len(r.json())


# ---------------------------------------------------------------------------
# Der WS-Weg — und zwar BEIDE Pfade
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ws_send_in_ablage_kanal_wird_auch_nach_subscribe_verworfen(
    ws_app, _auth_signer
):
    """Der schnelle Pfad von `handle_send` darf die Ablage-Sperre nicht umgehen.

    `handle_send` hat zwei Wege: den langsamen (Kanal frisch laden, Rechte
    aufloesen) und den schnellen (`cid in ctx.subscribed`, Rechte gelten als
    bei `subscribe` geprueft). Die Mischzustand-Sperre aus Konzept §2a stand
    nur im langsamen. Ein `subscribe` VOR dem `send` genuegte damit, um
    Klartext in einen Kanal zu schreiben, der sich nach aussen als
    Ende-zu-Ende-verschluesselt ausweist — und andere Mitglieder vertrauen
    genau dieser Kennzeichnung.

    Der Test sendet deshalb zweimal: einmal ohne vorheriges `subscribe`
    (langsamer Pfad, war schon dicht) und einmal danach (schneller Pfad).
    """
    import asyncio
    import random

    from starlette.testclient import TestClient

    from .conftest import receive_skipping

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=auth(token)).json()
            kanal = tc.post(
                f"/guilds/{g['id']}/channels",
                json={"name": "ablage-raum", "ablage": True},
                headers=auth(token),
            ).json()
            assert kanal["ablage"] is True

            with tc.websocket_connect(f"/ws?token={token}") as ws:
                receive_skipping(ws)  # ready

                ws.send_json(
                    {
                        "op": "send",
                        "channel_id": kanal["id"],
                        "content": "klartext ohne subscribe",
                        "nonce": "n-langsam",
                    }
                )
                langsam = receive_skipping(ws)
                assert langsam["op"] == "error", (
                    "langsamer Pfad: Klartext in einen Ablage-Kanal muss "
                    f"abgewiesen werden, war {langsam}"
                )

                ws.send_json({"op": "subscribe", "channel_id": kanal["id"]})
                ws.send_json(
                    {
                        "op": "send",
                        "channel_id": kanal["id"],
                        "content": "klartext nach subscribe",
                        "nonce": "n-schnell",
                    }
                )
                schnell = receive_skipping(ws)
                assert schnell["op"] == "error", (
                    "schneller Pfad: ein vorheriges `subscribe` darf die "
                    f"Ablage-Sperre nicht aushebeln, war {schnell}"
                )

            # Gegenprobe am Bestand: es darf keine Zeile entstanden sein.
            assert _messages_count_sync(tc, token, kanal["id"]) == 0

    await asyncio.to_thread(_run)


def _messages_count_sync(tc, token: str, channel_id: str) -> int:
    r = tc.get(f"/channels/{channel_id}/messages", headers=auth(token))
    if r.status_code != 200:
        return -1
    return len(r.json())
