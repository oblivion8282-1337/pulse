"""Tests für Einladungs-Benachrichtigungen an Nicht-Freunde (member-invites).

Muster der Friend-Tests: Cloud-only, Token via _auth_signer, Nutzername-
Auflösung über gesäte ``cached_user_profiles``-Zeilen.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime

import dcc_chat_gateway.ratelimit as chat_ratelimit
import pytest
from dcc_chat_gateway.models import (
    CommunityInviteNotification,
    Guild,
    GuildMember,
    UserBlock,
)
from dcc_chat_gateway.models.moderation import CachedUserProfile
from sqlalchemy import select

pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(_auth_signer, session_factory) -> tuple[str, int, str]:
    """Token + uid + Nutzername; sät die Profil-Cache-Zeile, über die der
    POST den Nutzernamen auflöst."""
    uid = random.randint(1, 1_000_000)
    username = f"u{uid}"
    async with session_factory() as s:
        s.add(
            CachedUserProfile(
                user_identifier=str(uid),
                username=username,
                display_name=username,
                last_statement_iat=datetime.now(tz=UTC),
                stale=False,
            )
        )
        await s.commit()
    return _auth_signer.issue_access(uid, username), uid, username


async def make_guild(client, token: str, name: str = "Invite Guild") -> str:
    r = await client.post("/guilds", json={"name": name}, headers=auth(token))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def invite(client, token: str, guild_id: str, username: str):
    return await client.post(
        f"/guilds/{guild_id}/member-invites",
        json={"username": username},
        headers=auth(token),
    )


# ---------------------------------------------------------------------------
# POST /guilds/{id}/member-invites
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_happy_path_creates_row(client, _auth_signer, session_factory):
    t_a, uid_a, _ = await register(_auth_signer, session_factory)
    _, uid_b, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)

    r = await invite(client, t_a, gid, name_b)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert body["invitee_user_id"] == str(uid_b)
    assert body["inviter_user_id"] == str(uid_a)
    assert body["guild_name"] == "Invite Guild"

    async with session_factory() as s:
        row = await s.get(CommunityInviteNotification, int(body["id"]))
        assert row is not None and row.status == "pending"


@pytest.mark.asyncio
async def test_invite_requires_create_invites(client, _auth_signer, session_factory):
    """Nicht-Member (= ohne CREATE_INVITES in der Guild) → 403."""
    t_a, _, _ = await register(_auth_signer, session_factory)
    t_x, _, _ = await register(_auth_signer, session_factory)
    _, _, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)

    r = await invite(client, t_x, gid, name_b)
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_invite_unknown_username_404(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    r = await invite(client, t_a, gid, "gibtsnicht")
    assert r.status_code == 404
    assert r.json()["detail"] == "user_not_found"


@pytest.mark.asyncio
async def test_invite_block_either_way_403(client, _auth_signer, session_factory):
    t_a, uid_a, _ = await register(_auth_signer, session_factory)
    _, uid_b, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    async with session_factory() as s:
        # Der EMPFÄNGER hat den Einlader geblockt — muss genauso greifen.
        s.add(UserBlock(blocker_id=uid_b, blocked_id=uid_a))
        await s.commit()

    r = await invite(client, t_a, gid, name_b)
    assert r.status_code == 403
    assert r.json()["detail"] == "block_in_place"


@pytest.mark.asyncio
async def test_invite_already_member_409(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    _, uid_b, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    async with session_factory() as s:
        s.add(GuildMember(guild_id=int(gid), user_id=uid_b))
        await s.commit()

    r = await invite(client, t_a, gid, name_b)
    assert r.status_code == 409
    assert r.json()["detail"] == "already_member"


@pytest.mark.asyncio
async def test_invite_duplicate_pending_409(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    _, _, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)

    assert (await invite(client, t_a, gid, name_b)).status_code == 201
    r = await invite(client, t_a, gid, name_b)
    assert r.status_code == 409
    assert r.json()["detail"] == "invite_already_pending"


@pytest.mark.asyncio
async def test_invite_rate_limit_429(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    limit, _window = chat_ratelimit._RULES["member_invite"]
    for _ in range(limit):
        _, _, name = await register(_auth_signer, session_factory)
        assert (await invite(client, t_a, gid, name)).status_code == 201
    _, _, name = await register(_auth_signer, session_factory)
    r = await invite(client, t_a, gid, name)
    assert r.status_code == 429


# ---------------------------------------------------------------------------
# GET /me/community-invites + accept/decline
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_pending_for_invitee(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    t_b, _, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    await invite(client, t_a, gid, name_b)

    r = await client.get("/me/community-invites", headers=auth(t_b))
    assert r.status_code == 200, r.text
    (entry,) = r.json()
    assert entry["guild_id"] == gid
    assert entry["guild_name"] == "Invite Guild"


@pytest.mark.asyncio
async def test_accept_creates_membership(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    t_b, uid_b, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    inv_id = (await invite(client, t_a, gid, name_b)).json()["id"]

    r = await client.post(f"/me/community-invites/{inv_id}/accept", headers=auth(t_b))
    assert r.status_code == 200, r.text
    assert r.json()["guild"]["id"] == gid

    async with session_factory() as s:
        assert (await s.get(GuildMember, (int(gid), uid_b))) is not None
        row = await s.get(CommunityInviteNotification, int(inv_id))
        assert row.status == "accepted"
    # Entschieden → nicht mehr in der Pending-Liste.
    r = await client.get("/me/community-invites", headers=auth(t_b))
    assert r.json() == []


@pytest.mark.asyncio
async def test_decline_leaves_no_membership(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    t_b, uid_b, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    inv_id = (await invite(client, t_a, gid, name_b)).json()["id"]

    r = await client.post(f"/me/community-invites/{inv_id}/decline", headers=auth(t_b))
    assert r.status_code == 204
    async with session_factory() as s:
        assert (await s.get(GuildMember, (int(gid), uid_b))) is None
        row = await s.get(CommunityInviteNotification, int(inv_id))
        assert row.status == "declined"
    # Nach Ablehnung darf ein NEUER Invite gestellt werden (Guard prüft nur pending).
    assert (await invite(client, t_a, gid, name_b)).status_code == 201


@pytest.mark.asyncio
async def test_accept_foreign_invite_404(client, _auth_signer, session_factory):
    t_a, _, _ = await register(_auth_signer, session_factory)
    _, _, name_b = await register(_auth_signer, session_factory)
    t_c, _, _ = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    inv_id = (await invite(client, t_a, gid, name_b)).json()["id"]

    r = await client.post(f"/me/community-invites/{inv_id}/accept", headers=auth(t_c))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_accept_after_guild_deleted_404_and_cleans_row(
    client, _auth_signer, session_factory
):
    t_a, _, _ = await register(_auth_signer, session_factory)
    t_b, _, name_b = await register(_auth_signer, session_factory)
    gid = await make_guild(client, t_a)
    inv_id = (await invite(client, t_a, gid, name_b)).json()["id"]

    # Guild direkt in der DB löschen (simuliert die gelöschte Community; der
    # FK-CASCADE der Invite-Zeile greift je nach Backend — der Route-Pfad
    # muss BEIDE Fälle sauber mit 404 beantworten und die Zeile aufräumen).
    async with session_factory() as s:
        g = await s.get(Guild, int(gid))
        await s.delete(g)
        await s.commit()

    r = await client.post(f"/me/community-invites/{inv_id}/accept", headers=auth(t_b))
    assert r.status_code == 404
    async with session_factory() as s:
        rows = (
            await s.execute(
                select(CommunityInviteNotification).where(
                    CommunityInviteNotification.id == int(inv_id)
                )
            )
        ).scalars().all()
        assert rows == []
