"""Drossel auf dem E2EE-Sendeweg (Übergabe P2.12): ``POST /postfach`` teilt
sich den ``message``-Rahmen mit dem Klartext-Sendepfad — derselbe Verkehr,
derselbe Schutz. Die Geräte- und Kanal-Prüfungen laufen NACH der Drossel
(a. d. Reihenfolge im Route-Handler): abgewiesene Anfragen kosten keine
DB-Runden. """

from __future__ import annotations

import random

import pytest

from .conftest import make_auth_header

pytestmark = pytest.mark.usefixtures("cloud_mode")


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


@pytest.mark.asyncio
async def test_postfach_wird_gedrosselt(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=make_auth_header(t_a)
    )
    assert dm.status_code == 201
    channel_id = dm.json()["id"]

    rumpf = {
        "channel_id": channel_id,
        "device_pubkey": "drossel-test-geraet",
        "nutzlasten": [{"art": 0, "daten": "dGVzdA==", "empfaenger": ["empf-1"]}],
    }
    codes = []
    for _ in range(12):
        r = await client.post("/postfach", json=rumpf, headers=make_auth_header(t_a))
        codes.append(r.status_code)
    assert 429 in codes, f"keine Drossel nach 12 Anfragen: {codes}"
    assert codes[0] != 429, "die allererste Anfrage darf nicht schon gedrosselt sein"
