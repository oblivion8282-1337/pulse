"""Tests für den serverseitigen Lesefortschritt (P0.2): PUT /dm-channels/{id}/lesestand.

Deckt die Sicherheits- und Konsistenzgrenzen der Route: Mitgliedsgate,
Monotonie-Guard (veralteter Client darf nicht zurücksetzen) und das
additive ready-Feld. """

from __future__ import annotations

import pytest

from .conftest import make_auth_header

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


async def _register_user(_auth_signer) -> tuple[str, int]:
    import random

    uid = random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


async def _dm_zwischen(_auth_signer, client, friend_pair, uid_a: int, uid_b: int) -> str:
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=make_auth_header(_auth_signer.issue_access(uid_a, f"user{uid_a}")),
    )
    assert r.status_code == 201
    return r.json()["id"]


@pytest.mark.asyncio
async def test_lesestand_setzt_stand(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    dm_id = await _dm_zwischen(_auth_signer, client, friend_pair, uid_a, uid_b)

    r = await client.put(
        f"/dm-channels/{dm_id}/lesestand",
        json={"last_read_message_id": "9009000000000000001"},
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 204

    # Der Kanal-Liste trägt den eigenen Stand (und den der Gegenstelle als NULL).
    r = await client.get("/dm-channels", headers=make_auth_header(t_a))
    assert r.status_code == 200
    eintrag = next(d for d in r.json() if d["id"] == dm_id)
    assert eintrag["last_read_message_id"] == "9009000000000000001"
    assert eintrag["partner_last_read_message_id"] is None


@pytest.mark.asyncio
async def test_lesestand_monotonie_guard(client, _auth_signer, friend_pair):
    """Ein veralteter Stand (zweites Gerät hinkt nach) darf nicht zurücksetzen."""
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    dm_id = await _dm_zwischen(_auth_signer, client, friend_pair, uid_a, uid_b)
    heads = make_auth_header(t_a)

    r = await client.put(
        f"/dm-channels/{dm_id}/lesestand",
        json={"last_read_message_id": "9009000000000000002"},
        headers=heads,
    )
    assert r.status_code == 204
    r = await client.put(
        f"/dm-channels/{dm_id}/lesestand",
        json={"last_read_message_id": "9009000000000000001"},
        headers=heads,
    )
    assert r.status_code == 204

    r = await client.get("/dm-channels", headers=heads)
    eintrag = next(d for d in r.json() if d["id"] == dm_id)
    assert eintrag["last_read_message_id"] == "9009000000000000002"


@pytest.mark.asyncio
async def test_lesestand_fremde_kanal_404(client, _auth_signer, friend_pair):
    """Nicht-Mitglieder bekommen 404 — der Stand eines fremden DM-Paars ist
    nicht les- und schreibbar (DMs sind Cloud-only, Mitgliedsgate)."""
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    dm_id = await _dm_zwischen(_auth_signer, client, friend_pair, uid_a, uid_b)

    t_fremd, _ = await _register_user(_auth_signer)
    r = await client.put(
        f"/dm-channels/{dm_id}/lesestand",
        json={"last_read_message_id": 100},
        headers=make_auth_header(t_fremd),
    )
    assert r.status_code == 404
