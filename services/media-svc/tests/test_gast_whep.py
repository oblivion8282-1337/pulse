"""``GET /gast/whep`` — Zuschau-URL für einen Gast (Besprechungslink).

Ein Gast hat kein Konto. Seine Berechtigung IST die Kanalbindung des Tickets,
und deshalb prüft diese Route genau die — sonst nichts. Der zweite Punkt ist
die Trennung: dieselbe Auskunft gibt es unter ``/channels/{id}/whep`` nur
gegen ein Konto-Token, und keine der beiden Routen nimmt beides an.
"""

from __future__ import annotations

import json

import pytest

from dcc_media_svc.streamkeys import ACTIVE_KEY, TOKEN_KEY


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _ticket(auth_signer, *, channel_id: str, gast_id: str = "gast-77") -> str:
    return auth_signer.issue_gast(
        gast_id=gast_id,
        guild_id="9",
        channel_id=channel_id,
        name="Frau Meier",
        ttl_s=3600,
    )


@pytest.mark.asyncio
async def test_gast_bekommt_die_zuschau_url(client, redis, auth_signer):
    cid = "770001"
    path = f"channel-{cid}-42-{'deadbeef' * 4}"
    await redis.set(
        ACTIVE_KEY.format(channel_id=cid, user_id="42"),
        json.dumps({"user_id": "42", "started_at": "2026-09-04T00:00:00+00:00", "path": path}),
    )
    read_token = None
    # Die Tests teilen sich die Dev-Redis: eine überbliebene Rauswurf-Sperre
    # für das feste gast-77 (z. B. aus dem Sperr-Test weiter unten oder einem
    # Live-Kick) würde diesen Test sonst ohne eigene Schuld fallen lassen.
    await redis.delete("gast:gesperrt:gast-77")
    try:
        r = await client.get(
            f"/gast/whep?channel_id={cid}&user_id=42",
            headers=_auth(_ticket(auth_signer, channel_id=cid)),
        )
        assert r.status_code == 200, r.text
        base, _, query = r.json()["whep_url"].partition("?")
        assert base == f"http://stream.test:8889/{path}/whep"
        read_token = query[len("token=") :]
        rec = json.loads(await redis.get(TOKEN_KEY.format(token=read_token)))
        assert rec["scope"] == "read"
        assert rec["channel_id"] == cid
    finally:
        await redis.delete(ACTIVE_KEY.format(channel_id=cid, user_id="42"))
        if read_token:
            await redis.delete(TOKEN_KEY.format(token=read_token))


@pytest.mark.asyncio
async def test_ticket_fuer_anderen_kanal_sieht_nichts(client, redis, auth_signer):
    cid = "770002"
    r = await client.get(
        f"/gast/whep?channel_id={cid}&user_id=42",
        headers=_auth(_ticket(auth_signer, channel_id="999999")),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_rausgeworfener_gast_bekommt_keine_neue_zuschau_url(
    client, redis, auth_signer
):
    """Audit 2026-09: Die Rauswurf-Sperre gilt auch hier, nicht nur im
    chat-gateway-Proxy — ein rausgeworfener Gast mit noch laufendem Ticket
    (bis 4 h) darf sich keine NEUEN Lese-Token holen statt nur die alten
    zu verlieren."""
    from dcc_shared.gaeste import sperren

    cid = "770004"
    await sperren(redis, "gast-77")
    r = await client.get(
        f"/gast/whep?channel_id={cid}&user_id=42",
        headers=_auth(_ticket(auth_signer, channel_id=cid)),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "removed from the meeting"


@pytest.mark.asyncio
async def test_konto_token_taugt_hier_nicht_und_gast_ticket_dort_nicht(
    client, redis, auth_signer
):
    cid = "770003"
    zugang = auth_signer.issue_access(7, "bob")
    ticket = _ticket(auth_signer, channel_id=cid)

    assert (
        await client.get(f"/gast/whep?channel_id={cid}&user_id=42", headers=_auth(zugang))
    ).status_code == 401
    assert (
        await client.get(f"/channels/{cid}/whep?user_id=42", headers=_auth(ticket))
    ).status_code == 401
