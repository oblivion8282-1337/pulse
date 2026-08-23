"""Tests for the public community address (Stufe 4).

Covers:
  * ``GET /guilds/{id}/settings`` + ``PATCH /guilds/{id}`` handle / is_public:
    - handle format validation (422)
    - per-instance handle uniqueness (409)
    - ``is_public=true`` requires a handle (400)
    - clearing a handle while public is rejected (400)
  * ``GET /c/{handle}`` preview — public only; private/unknown = 404 (no leak)
  * ``POST /c/{handle}/join`` — public join grant + idempotent + ban-block;
    private/unknown = 404
  * handle validation helper (``community_handle.validate_handle``)

These run in the default (self-host) test mode. The public-join + preview routes
are *not* CloudOnly (they serve both Cloud + Self-Host communities); the
instance-membership grant is asserted via the ``InstanceMember`` table.
"""

from __future__ import annotations

import random

import pytest
from dcc_chat_gateway.community_handle import is_valid_handle, validate_handle


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _make_guild(client, token: str, name: str = "g") -> dict:
    return (await client.post("/guilds", json={"name": name}, headers=auth(token))).json()


async def _make_channel(client, token: str, guild_id: str, name: str = "general") -> dict:
    return (
        await client.post(
            f"/guilds/{guild_id}/channels", json={"name": name}, headers=auth(token)
        )
    ).json()


# ---------------------------------------------------------------------------
# Handle validation helper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "handle,valid",
    [
        ("cool-server", True),
        ("abc", True),
        ("a1b", True),
        ("a" * 32, True),
        ("ab", False),  # too short
        ("a" * 33, False),  # too long
        ("-lead", False),  # leading hyphen
        ("trail-", False),  # trailing hyphen
        ("Upper", False),  # uppercase
        ("has space", False),
        ("under_score", False),
        ("admin", False),  # reserved
        ("new", False),  # reserved
        ("", False),
    ],
)
def test_handle_validation(handle, valid):
    assert is_valid_handle(handle) is valid
    if valid:
        assert validate_handle(handle) == handle
    else:
        with pytest.raises(ValueError):
            validate_handle(handle)


# ---------------------------------------------------------------------------
# Settings: handle + is_public via PATCH /guilds/{id} + GET .../settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_settings_defaults(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.get(f"/guilds/{g['id']}/settings", headers=auth(owner_t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["handle"] is None
    assert body["is_public"] is False
    assert body["address_path"] is None


@pytest.mark.asyncio
async def test_set_handle_then_public(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    # Set a handle first.
    r = await client.patch(
        f"/guilds/{g['id']}", json={"handle": "my-server"}, headers=auth(owner_t)
    )
    assert r.status_code == 200, r.text
    s = (await client.get(f"/guilds/{g['id']}/settings", headers=auth(owner_t))).json()
    assert s["handle"] == "my-server"
    assert s["address_path"] == "/c/my-server"
    assert s["is_public"] is False
    # Now flip public.
    r2 = await client.patch(
        f"/guilds/{g['id']}", json={"is_public": True}, headers=auth(owner_t)
    )
    assert r2.status_code == 200, r2.text
    s2 = (await client.get(f"/guilds/{g['id']}/settings", headers=auth(owner_t))).json()
    assert s2["is_public"] is True


@pytest.mark.asyncio
async def test_set_handle_and_public_in_one_patch(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.patch(
        f"/guilds/{g['id']}",
        json={"handle": "oneshot", "is_public": True},
        headers=auth(owner_t),
    )
    assert r.status_code == 200, r.text
    s = (await client.get(f"/guilds/{g['id']}/settings", headers=auth(owner_t))).json()
    assert s["handle"] == "oneshot" and s["is_public"] is True


@pytest.mark.asyncio
async def test_public_requires_handle(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.patch(
        f"/guilds/{g['id']}", json={"is_public": True}, headers=auth(owner_t)
    )
    assert r.status_code == 400
    assert "handle" in r.json()["detail"]


@pytest.mark.asyncio
async def test_cannot_clear_handle_while_public(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    await client.patch(
        f"/guilds/{g['id']}",
        json={"handle": "keepme", "is_public": True},
        headers=auth(owner_t),
    )
    # Try to clear the handle while still public → 400.
    r = await client.patch(
        f"/guilds/{g['id']}", json={"handle": ""}, headers=auth(owner_t)
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_can_clear_handle_after_going_private(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    await client.patch(
        f"/guilds/{g['id']}",
        json={"handle": "temp", "is_public": True},
        headers=auth(owner_t),
    )
    # Go private + clear the handle in one patch.
    r = await client.patch(
        f"/guilds/{g['id']}",
        json={"is_public": False, "handle": ""},
        headers=auth(owner_t),
    )
    assert r.status_code == 200, r.text
    s = (await client.get(f"/guilds/{g['id']}/settings", headers=auth(owner_t))).json()
    assert s["handle"] is None and s["is_public"] is False


@pytest.mark.asyncio
async def test_handle_invalid_format_rejected(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    r = await client.patch(
        f"/guilds/{g['id']}", json={"handle": "Bad Handle"}, headers=auth(owner_t)
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_handle_uniqueness_conflict(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    g1 = await _make_guild(client, owner_t, "g1")
    g2 = await _make_guild(client, owner_t, "g2")
    r1 = await client.patch(
        f"/guilds/{g1['id']}", json={"handle": "dup-handle"}, headers=auth(owner_t)
    )
    assert r1.status_code == 200, r1.text
    r2 = await client.patch(
        f"/guilds/{g2['id']}", json={"handle": "dup-handle"}, headers=auth(owner_t)
    )
    assert r2.status_code == 409
    assert "taken" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_settings_requires_manage_guild(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    member_t, member_uid = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(member_uid)},
        headers=auth(owner_t),
    )
    # A plain member lacks MANAGE_GUILD → 403 on both read + write.
    r = await client.get(f"/guilds/{g['id']}/settings", headers=auth(member_t))
    assert r.status_code == 403
    r2 = await client.patch(
        f"/guilds/{g['id']}", json={"handle": "nope"}, headers=auth(member_t)
    )
    assert r2.status_code == 403


# ---------------------------------------------------------------------------
# Public preview: GET /c/{handle}
# ---------------------------------------------------------------------------


async def _make_public(client, token, name="Public Co", handle="pub-co") -> dict:
    g = await _make_guild(client, token, name)
    await _make_channel(client, token, g["id"])
    r = await client.patch(
        f"/guilds/{g['id']}",
        json={"handle": handle, "is_public": True},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    return g


@pytest.mark.asyncio
async def test_preview_public_community(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    viewer_t, _ = await _register_user(_auth_signer)
    g = await _make_public(client, owner_t, name="Cool Public", handle="cool-pub")
    r = await client.get("/c/cool-pub", headers=auth(viewer_t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["guild"]["id"] == g["id"]
    assert body["guild"]["name"] == "Cool Public"
    assert body["member_count"] == 1
    assert body["is_public"] is True


@pytest.mark.asyncio
async def test_preview_private_community_404(client, _auth_signer):
    """A community with a handle but NOT public must not be previewable —
    same 404 as a non-existent handle (no existence/member-count leak)."""
    owner_t, _ = await _register_user(_auth_signer)
    viewer_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    # Handle set but is_public stays false.
    await client.patch(
        f"/guilds/{g['id']}", json={"handle": "secret-co"}, headers=auth(owner_t)
    )
    r = await client.get("/c/secret-co", headers=auth(viewer_t))
    assert r.status_code == 404
    assert r.json()["detail"] == "community not found"


@pytest.mark.asyncio
async def test_preview_unknown_handle_404(client, _auth_signer):
    viewer_t, _ = await _register_user(_auth_signer)
    r = await client.get("/c/does-not-exist", headers=auth(viewer_t))
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Public join: POST /c/{handle}/join
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_join_public_community(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, _ = await _register_user(_auth_signer)
    g = await _make_public(client, owner_t, handle="joinme")
    r = await client.post("/c/joinme/join", headers=auth(joiner_t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["guild"]["id"] == g["id"]
    assert body["channel_id"] is not None
    # joiner is now a member: can list channels.
    r2 = await client.get(f"/guilds/{g['id']}/channels", headers=auth(joiner_t))
    assert r2.status_code == 200
    # member count reflects the new join.
    prev = (await client.get("/c/joinme", headers=auth(joiner_t))).json()
    assert prev["member_count"] == 2


@pytest.mark.asyncio
async def test_join_public_community_idempotent(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, _ = await _register_user(_auth_signer)
    await _make_public(client, owner_t, handle="twice")
    r1 = await client.post("/c/twice/join", headers=auth(joiner_t))
    assert r1.status_code == 200
    r2 = await client.post("/c/twice/join", headers=auth(joiner_t))
    assert r2.status_code == 200, r2.text


@pytest.mark.asyncio
async def test_join_private_community_404(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, owner_t)
    await client.patch(
        f"/guilds/{g['id']}", json={"handle": "private-join"}, headers=auth(owner_t)
    )
    r = await client.post("/c/private-join/join", headers=auth(joiner_t))
    assert r.status_code == 404
    # Confirm the would-be joiner did NOT become a member.
    r2 = await client.get(f"/guilds/{g['id']}/channels", headers=auth(joiner_t))
    assert r2.status_code in (403, 404)


@pytest.mark.asyncio
async def test_join_unknown_handle_404(client, _auth_signer):
    joiner_t, _ = await _register_user(_auth_signer)
    r = await client.post("/c/nope-nope/join", headers=auth(joiner_t))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_banned_user_cannot_join_public(client, _auth_signer):
    owner_t, _ = await _register_user(_auth_signer)
    banned_t, banned_uid = await _register_user(_auth_signer)
    g = await _make_public(client, owner_t, handle="banzone")
    # Ban the user from the guild before they try to join.
    rb = await client.put(
        f"/guilds/{g['id']}/bans/{banned_uid}", json={}, headers=auth(owner_t)
    )
    assert rb.status_code == 200, rb.text
    r = await client.post("/c/banzone/join", headers=auth(banned_t))
    assert r.status_code == 403
    # Did not become a member.
    r2 = await client.get(f"/guilds/{g['id']}/channels", headers=auth(banned_t))
    assert r2.status_code in (403, 404)


@pytest.mark.asyncio
async def test_join_public_grants_instance_membership_self_host(
    client, _auth_signer, session_factory
):
    """On a Self-Host, joining a public community grants community-scoped
    instance membership (Entscheidung 5)."""
    from dcc_chat_gateway.models import InstanceMember
    from sqlalchemy import select

    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, joiner_uid = await _register_user(_auth_signer)
    await _make_public(client, owner_t, handle="instgrant")
    r = await client.post("/c/instgrant/join", headers=auth(joiner_t))
    assert r.status_code == 200, r.text
    # The joiner's cross-mode identifier — in self-host test mode the access
    # token isn't a self-host session token, so user_identifier == str(uid).
    async with session_factory() as s:
        rows = (
            await s.execute(select(InstanceMember.joined_via))
        ).scalars().all()
    assert "public_community" in rows


@pytest.mark.asyncio
async def test_join_public_blocked_when_locked_self_host(
    client, _auth_signer, session_factory
):
    """"Server gesperrt" (locked) toggle blocks a NEW instance join via the
    public-community path on a Self-Host (defensive — the primary lock is the
    cert-login gate). Existing members are unaffected (covered by the gate
    tests)."""
    from dcc_chat_gateway.models import ChatSettings, InstanceMember
    from sqlalchemy import select

    owner_t, _ = await _register_user(_auth_signer)
    joiner_t, joiner_uid = await _register_user(_auth_signer)
    await _make_public(client, owner_t, handle="lockedhouse")
    # Seal the instance.
    async with session_factory() as s:
        row = await s.get(ChatSettings, 1)
        row.locked = True
        await s.commit()

    r = await client.post("/c/lockedhouse/join", headers=auth(joiner_t))
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "join_locked"
    # The joiner became neither an instance member nor a guild member.
    async with session_factory() as s:
        rows = (
            await s.execute(select(InstanceMember.user_identifier))
        ).scalars().all()
    assert str(joiner_uid) not in rows


# ---------------------------------------------------------------------------
# Verzeichnis: GET /c  (Mobil-Umbau 2026-08-22, Entdecken-Bereich)
# ---------------------------------------------------------------------------
#
# **Der sicherheitsrelevante Teil ist `listed`.** Eine oeffentliche Adresse
# heisst „wer den Link kennt, kommt rein" — nicht „stell mich in ein
# durchsuchbares Schaufenster". Das sind zwei verschiedene Zustimmungen, und
# bestehende oeffentliche Communities duerfen durch den neuen Endpunkt NICHT
# auffindbar werden. Genau das pruefen die ersten beiden Tests.


async def _oeffentlich(client, token: str, name: str, handle: str, *, listed: bool,
                       category: str | None = None) -> dict:
    g = await _make_guild(client, token, name)
    await _make_channel(client, token, g["id"])
    payload: dict = {"handle": handle, "is_public": True}
    if listed:
        payload["listed"] = True
    if category:
        payload["category"] = category
    r = await client.patch(f"/guilds/{g['id']}", json=payload, headers=auth(token))
    assert r.status_code == 200, r.text
    return g


@pytest.mark.asyncio
async def test_verzeichnis_zeigt_nicht_gelistete_nicht(client, _auth_signer):
    """Oeffentliche Adresse allein bringt eine Community NICHT ins Schaufenster."""
    t, _ = await _register_user(_auth_signer)
    await _oeffentlich(client, t, "still", "stille-ecke", listed=False)
    r = await client.get("/c", headers=auth(t))
    assert r.status_code == 200
    assert [e for e in r.json()["items"] if e["handle"] == "stille-ecke"] == []


@pytest.mark.asyncio
async def test_verzeichnis_zeigt_gelistete(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    await _oeffentlich(client, t, "offen", "offene-ecke", listed=True)
    r = await client.get("/c", headers=auth(t))
    treffer = [e for e in r.json()["items"] if e["handle"] == "offene-ecke"]
    assert len(treffer) == 1
    assert treffer[0]["name"] == "offen"
    assert treffer[0]["member_count"] >= 1


@pytest.mark.asyncio
async def test_verzeichnis_verlangt_anmeldung(client):
    """Wie die Vorschau — der Gateway hat keinen Ratenbegrenzer."""
    r = await client.get("/c")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_verzeichnis_filtert_nach_kategorie(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    await _oeffentlich(client, t, "zocker", "zocker-ecke", listed=True, category="gaming")
    await _oeffentlich(client, t, "toene", "toene-ecke", listed=True, category="music")
    r = await client.get("/c", params={"category": "gaming"}, headers=auth(t))
    handles = [e["handle"] for e in r.json()["items"]]
    assert "zocker-ecke" in handles
    assert "toene-ecke" not in handles


@pytest.mark.asyncio
async def test_verzeichnis_sucht_im_namen(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    await _oeffentlich(client, t, "Kartoffelfreunde", "kartoffel", listed=True)
    r = await client.get("/c", params={"q": "kartoffel"}, headers=auth(t))
    assert [e["handle"] for e in r.json()["items"]] == ["kartoffel"]


@pytest.mark.asyncio
async def test_verzeichnis_deckelt_die_seitengroesse(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    r = await client.get("/c", params={"limit": 5000}, headers=auth(t))
    assert r.status_code == 200
    assert len(r.json()["items"]) <= 50


@pytest.mark.asyncio
async def test_listed_ohne_is_public_wird_abgelehnt(client, _auth_signer):
    """Ohne oeffentliche Adresse gibt es nichts zu listen."""
    t, _ = await _register_user(_auth_signer)
    g = await _make_guild(client, t, "privat")
    r = await client.patch(f"/guilds/{g['id']}", json={"listed": True}, headers=auth(t))
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_nicht_oeffentlich_stellen_raeumt_die_listung(client, _auth_signer):
    """Wer die Adresse zurueckzieht, verschwindet auch aus dem Verzeichnis.

    Sonst bliebe ``listed`` still stehen und die Community waere beim naechsten
    Oeffentlichmachen ungefragt wieder im Schaufenster.
    """
    t, _ = await _register_user(_auth_signer)
    g = await _oeffentlich(client, t, "kurz", "kurz-da", listed=True)
    await client.patch(f"/guilds/{g['id']}", json={"is_public": False}, headers=auth(t))
    s = (await client.get(f"/guilds/{g['id']}/settings", headers=auth(t))).json()
    assert s["listed"] is False
