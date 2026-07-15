"""Tests for the mod-queue endpoints.

Endpoints under test:
  * GET  /guilds/{gid}/mod-queue
  * POST /guilds/{gid}/mod-queue/{rid}/resolve
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway.models import Report


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _uid() -> int:
    return random.randint(1, 1_000_000)


async def _token(signer, *, is_admin: bool = False) -> tuple[str, int]:
    uid = _uid()
    if is_admin:
        return signer.issue_access(uid, f"admin{uid}", is_admin=True), uid
    return signer.issue_access(uid, f"user{uid}"), uid


# ---------------------------------------------------------------------------
# Setup helpers
# ---------------------------------------------------------------------------


async def _make_guild(client, owner_token: str) -> dict:
    r = await client.post("/guilds", json={"name": "testguild"}, headers=auth(owner_token))
    assert r.status_code == 201, r.text
    return r.json()


async def _add_member(client, guild_id: str, uid: int, owner_token: str) -> None:
    r = await client.post(
        f"/guilds/{guild_id}/members",
        json={"user_id": str(uid)},
        headers=auth(owner_token),
    )
    assert r.status_code in (200, 201), r.text


async def _grant_role_with_perms(client, guild_id: str, uid: int, perms: int, owner_token: str):
    role = (
        await client.post(
            f"/guilds/{guild_id}/roles",
            json={"name": "mod", "permissions": str(perms)},
            headers=auth(owner_token),
        )
    ).json()
    await client.put(
        f"/guilds/{guild_id}/members/{uid}/roles/{role['id']}",
        headers=auth(owner_token),
    )
    return role


async def _seed_report(session_factory, reporter_id: int, *, channel_id: int | None = None,
                       user_id: int | None = None, message_id: int | None = None) -> int:
    """Directly insert a Report row bypassing the HTTP rate-limit."""
    from dcc_chat_gateway.snowflake import next_id as _nid

    rid = _nid()
    async with session_factory() as s:
        s.add(Report(
            id=rid,
            reporter_user_id=reporter_id,
            target_channel_id=channel_id,
            target_user_id=user_id,
            target_message_id=message_id,
            reason_code="spam",
            body="Direct seed for mod-queue test — bypasses HTTP path.",
            status="new",
        ))
        await s.commit()
    return rid


# ---------------------------------------------------------------------------
# Permission gate — non-mod gets 403
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_mod_cannot_see_queue(client, _auth_signer):
    t_owner, _ = await _token(_auth_signer)
    t_user, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_user))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_non_member_cannot_see_queue(client, _auth_signer):
    t_owner, _ = await _token(_auth_signer)
    t_stranger, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_stranger))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# MANAGE_MESSAGES holder can see queue
# ---------------------------------------------------------------------------

_MANAGE_MESSAGES = 1 << 23


@pytest.mark.asyncio
async def test_manage_messages_mod_can_see_queue(client, _auth_signer):
    t_owner, uid_owner = await _token(_auth_signer)
    t_mod, uid_mod = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_mod, t_owner)
    await _grant_role_with_perms(client, g["id"], uid_mod, _MANAGE_MESSAGES, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_mod))
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ---------------------------------------------------------------------------
# Scoped listing — cross-guild leak must NOT happen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mod_queue_channel_scope(client, _auth_signer, session_factory):
    """Reports targeting channels IN this guild appear; others do not."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    # Create a channel in our guild.
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    ch_id = int(ch["id"])

    reporter_uid = _uid()

    # Report targeting OUR channel
    own_rid = await _seed_report(session_factory, reporter_uid, channel_id=ch_id)
    # Report targeting an unrelated channel (random id, not in any guild)
    await _seed_report(session_factory, reporter_uid, channel_id=999_999_888_777)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_owner))
    assert r.status_code == 200
    ids = {item["id"] for item in r.json()}
    assert str(own_rid) in ids
    # The unrelated-channel report must not appear
    assert len(ids) == 1


@pytest.mark.asyncio
async def test_mod_queue_user_scope(client, _auth_signer, session_factory):
    """User-only reports only appear when the target user is a member."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    t_member, uid_member = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_member, t_owner)

    reporter_uid = _uid()
    uid_outsider = _uid()

    # Report targeting our member
    member_rid = await _seed_report(session_factory, reporter_uid, user_id=uid_member)
    # Report targeting a user who is NOT in this guild
    await _seed_report(session_factory, reporter_uid, user_id=uid_outsider)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_owner))
    assert r.status_code == 200
    ids = {item["id"] for item in r.json()}
    assert str(member_rid) in ids
    # Outsider report must not leak into this guild's queue
    assert len(ids) == 1


@pytest.mark.asyncio
async def test_mod_queue_cross_guild_leak_prevented(client, _auth_signer, session_factory):
    """Guild A's mod cannot see reports scoped to Guild B's channels."""
    t_owner_a, _ = await _token(_auth_signer)
    t_owner_b, _ = await _token(_auth_signer)
    g_a = await _make_guild(client, t_owner_a)
    g_b = await _make_guild(client, t_owner_b)

    ch_b = (
        await client.post(
            f"/guilds/{g_b['id']}/channels",
            json={"name": "b-general", "type": 0},
            headers=auth(t_owner_b),
        )
    ).json()

    reporter_uid = _uid()
    await _seed_report(session_factory, reporter_uid, channel_id=int(ch_b["id"]))

    # Guild A's owner queries their own mod queue
    r = await client.get(f"/guilds/{g_a['id']}/mod-queue", headers=auth(t_owner_a))
    assert r.status_code == 200
    assert r.json() == []


# ---------------------------------------------------------------------------
# Resolve + audit-log
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_report_writes_audit_log(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    # ``warn`` is a non-enforceable action_type — recorded as metadata only, no
    # ban/kick/delete dispatch (enforcement is covered separately below).
    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "warn", "resolution_note": "Removed."},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "resolved"
    assert body["resolver_user_id"] == str(uid_owner)

    # Audit log must contain the entry
    log_r = await client.get(f"/guilds/{g['id']}/mod-audit-log", headers=auth(t_owner))
    assert log_r.status_code == 200
    entries = log_r.json()
    assert len(entries) >= 1
    entry = entries[0]
    assert entry["action_type"] == "report_resolved"
    assert entry["actor_user_id"] == str(uid_owner)


@pytest.mark.asyncio
async def test_resolve_already_resolved_409(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "main", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    resolve_payload = {"resolution": "dismissed"}
    await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json=resolve_payload,
        headers=auth(t_owner),
    )
    r2 = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json=resolve_payload,
        headers=auth(t_owner),
    )
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_resolve_non_mod_403(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    t_user, uid_user = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_user, t_owner)

    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved"},
        headers=auth(t_user),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Triage — mark a report as in-progress
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_triage_report_sets_status(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/triage", headers=auth(t_owner)
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "triaged"

    # Idempotent re-triage
    r2 = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/triage", headers=auth(t_owner)
    )
    assert r2.status_code == 200
    assert r2.json()["status"] == "triaged"

    # Shows up in the triaged listing, no longer under new
    listed = (
        await client.get(
            f"/guilds/{g['id']}/mod-queue", params={"status": "triaged"},
            headers=auth(t_owner),
        )
    ).json()
    assert str(rid) in {item["id"] for item in listed}

    # Triaged reports can still be resolved afterwards
    r3 = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "dismissed"},
        headers=auth(t_owner),
    )
    assert r3.status_code == 200
    # …and a resolved report can no longer be triaged
    r4 = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/triage", headers=auth(t_owner)
    )
    assert r4.status_code == 409


@pytest.mark.asyncio
async def test_triage_requires_mod_perm(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    t_user, uid_user = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_user, t_owner)
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/triage", headers=auth(t_user)
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Enforcement — resolving with an action_type actually executes the action
# ---------------------------------------------------------------------------

_BAN_MEMBERS = 1 << 2
_KICK_MEMBERS = 1 << 1


async def _report_status(session_factory, rid: int) -> str:
    async with session_factory() as s:
        return (await s.get(Report, rid)).status


@pytest.mark.asyncio
async def test_resolve_ban_actually_bans(client, _auth_signer, session_factory):
    from dcc_chat_gateway.models import GuildBan, GuildMember

    t_owner, uid_owner = await _token(_auth_signer)
    _, uid_target = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])
    await _add_member(client, g["id"], uid_target, t_owner)
    rid = await _seed_report(session_factory, uid_owner, user_id=uid_target)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "ban", "resolution_note": "spammer"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "resolved"

    async with session_factory() as s:
        assert await s.get(GuildBan, (gid, uid_target)) is not None
        assert await s.get(GuildMember, (gid, uid_target)) is None  # evicted

    # Both the ban action AND the report resolution are audited.
    log = (await client.get(f"/guilds/{g['id']}/mod-audit-log", headers=auth(t_owner))).json()
    action_types = {e["action_type"] for e in log}
    assert "ban" in action_types
    assert "report_resolved" in action_types


@pytest.mark.asyncio
async def test_resolve_kick_actually_kicks(client, _auth_signer, session_factory):
    from dcc_chat_gateway.models import GuildBan, GuildMember

    t_owner, uid_owner = await _token(_auth_signer)
    _, uid_target = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])
    await _add_member(client, g["id"], uid_target, t_owner)
    rid = await _seed_report(session_factory, uid_owner, user_id=uid_target)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "kick"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        assert await s.get(GuildMember, (gid, uid_target)) is None  # removed
        assert await s.get(GuildBan, (gid, uid_target)) is None  # but not banned


@pytest.mark.asyncio
async def test_resolve_message_delete_actually_deletes(client, _auth_signer, session_factory):
    from dcc_chat_gateway.models import Message

    t_owner, uid_owner = await _token(_auth_signer)
    t_author, uid_author = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_author, t_owner)
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    msg = (
        await client.post(
            f"/channels/{ch['id']}/messages", json={"content": "bad"}, headers=auth(t_author)
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, message_id=int(msg["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "message_delete"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        assert (await s.get(Message, int(msg["id"]))).deleted_at is not None


@pytest.mark.asyncio
async def test_resolve_ban_without_permission_403_keeps_report_open(
    client, _auth_signer, session_factory
):
    """A mod with only MANAGE_MESSAGES cannot ban — the action fails 403 and
    the report must stay open rather than silently closing 'as banned'."""
    t_owner, _ = await _token(_auth_signer)
    t_mod, uid_mod = await _token(_auth_signer)
    _, uid_target = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_mod, t_owner)
    await _add_member(client, g["id"], uid_target, t_owner)
    await _grant_role_with_perms(client, g["id"], uid_mod, _MANAGE_MESSAGES, t_owner)
    rid = await _seed_report(session_factory, uid_mod, user_id=uid_target)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "ban"},
        headers=auth(t_mod),
    )
    assert r.status_code == 403, r.text
    assert await _report_status(session_factory, rid) == "new"


@pytest.mark.asyncio
async def test_resolve_ban_without_user_target_400(client, _auth_signer, session_factory):
    """``ban`` on a channel-only report has no user to ban → 400, not silent."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "ban"},
        headers=auth(t_owner),
    )
    assert r.status_code == 400, r.text
    assert await _report_status(session_factory, rid) == "new"


@pytest.mark.asyncio
async def test_resolve_warn_records_without_enforcement(client, _auth_signer, session_factory):
    """Non-enforceable action_type (``warn``) closes the report but takes no
    action against the target."""
    from dcc_chat_gateway.models import GuildBan, GuildMember

    t_owner, uid_owner = await _token(_auth_signer)
    _, uid_target = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])
    await _add_member(client, g["id"], uid_target, t_owner)
    rid = await _seed_report(session_factory, uid_owner, user_id=uid_target)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "warn"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text

    async with session_factory() as s:
        assert await s.get(GuildMember, (gid, uid_target)) is not None  # still a member
        assert await s.get(GuildBan, (gid, uid_target)) is None


# ---------------------------------------------------------------------------
# Open-reports count (badge source)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mod_queue_count_new_and_triaged(client, _auth_signer, session_factory):
    """Count = new + triaged (open states); resolved/dismissed excluded."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    ch_id = int(ch["id"])
    reporter_uid = _uid()

    r1 = await _seed_report(session_factory, reporter_uid, channel_id=ch_id)
    await _seed_report(session_factory, reporter_uid, channel_id=ch_id)

    # Initially both are "new" → count 2.
    r = await client.get(f"/guilds/{g['id']}/mod-queue/count", headers=auth(t_owner))
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 2

    # Triage one → still open, count stays 2.
    await client.post(f"/guilds/{g['id']}/mod-queue/{r1}/triage", headers=auth(t_owner))
    r = await client.get(f"/guilds/{g['id']}/mod-queue/count", headers=auth(t_owner))
    assert r.json()["count"] == 2

    # Resolve one → count drops to 1.
    await client.post(
        f"/guilds/{g['id']}/mod-queue/{r1}/resolve",
        json={"resolution": "resolved", "action_type": "other"},
        headers=auth(t_owner),
    )
    r = await client.get(f"/guilds/{g['id']}/mod-queue/count", headers=auth(t_owner))
    assert r.json()["count"] == 1


@pytest.mark.asyncio
async def test_mod_queue_count_non_mod_403(client, _auth_signer):
    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    t_user, uid_user = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_user, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue/count", headers=auth(t_user))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_mod_queue_count_cross_guild_isolation(client, _auth_signer, session_factory):
    """A report scoped to guild B is not counted in guild A."""
    t_owner_a, _ = await _token(_auth_signer)
    t_owner_b, _ = await _token(_auth_signer)
    g_a = await _make_guild(client, t_owner_a)
    g_b = await _make_guild(client, t_owner_b)
    ch_b = (
        await client.post(
            f"/guilds/{g_b['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner_b),
        )
    ).json()
    await _seed_report(session_factory, _uid(), channel_id=int(ch_b["id"]))

    r = await client.get(f"/guilds/{g_a['id']}/mod-queue/count", headers=auth(t_owner_a))
    assert r.json()["count"] == 0
    r = await client.get(f"/guilds/{g_b['id']}/mod-queue/count", headers=auth(t_owner_b))
    assert r.json()["count"] == 1


@pytest.mark.asyncio
async def test_guilds_for_report_user_in_multiple_guilds(
    client, _auth_signer, session_factory
):
    """A user-only report resolves to every guild the target is a member of."""
    from dcc_chat_gateway.models import Report
    from dcc_chat_gateway.routes.mod_queue import guilds_for_report

    t_owner_a, _ = await _token(_auth_signer)
    t_owner_b, _ = await _token(_auth_signer)
    g_a = await _make_guild(client, t_owner_a)
    g_b = await _make_guild(client, t_owner_b)
    _, uid_target = await _token(_auth_signer)
    await _add_member(client, g_a["id"], uid_target, t_owner_a)
    await _add_member(client, g_b["id"], uid_target, t_owner_b)

    rid = await _seed_report(session_factory, _uid(), user_id=uid_target)
    async with session_factory() as s:
        report = await s.get(Report, rid)
        guilds = await guilds_for_report(s, report)
    assert guilds == {int(g_a["id"]), int(g_b["id"])}


@pytest.mark.asyncio
async def test_members_who_can_moderate_scoping(client, _auth_signer, session_factory):
    """Owner + a member with a mod role are moderators; a plain member and an
    outsider are not. This is what narrows report_new fan-out."""
    from dcc_chat_gateway.permissions import Permissions, members_who_can_moderate

    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    gid = int(g["id"])

    t_mod, uid_mod = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_mod, t_owner)
    await _grant_role_with_perms(
        client, g["id"], uid_mod, int(Permissions.BAN_MEMBERS), t_owner
    )

    t_plain, uid_plain = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_plain, t_owner)

    _, uid_outsider = await _token(_auth_signer)

    async with session_factory() as s:
        mods = await members_who_can_moderate(s, gid)
    assert uid_owner in mods
    assert uid_mod in mods
    assert uid_plain not in mods
    assert uid_outsider not in mods


# ---------------------------------------------------------------------------
# Escalation — hand a report up to the platform operator (auth-svc complaint)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_escalate_files_complaint_and_stamps(
    client, _auth_signer, session_factory, monkeypatch
):
    """A mod escalates → auth-svc is called, escalated_at is stamped, report
    stays open."""
    from dcc_chat_gateway.routes import mod_queue as _mq

    calls: list[tuple[str, int | None]] = []

    async def _fake_escalate(body: str, target_user_id: int | None) -> str:
        calls.append((body, target_user_id))
        return "999"

    monkeypatch.setattr(_mq, "escalate_report_to_operator", _fake_escalate)

    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    t_member, uid_member = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_member, t_owner)
    rid = await _seed_report(session_factory, _uid(), user_id=uid_member)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/escalate", headers=auth(t_owner)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["escalated_at"] is not None
    assert body["status"] == "new"  # stays open
    # auth-svc got the reported user + a context body
    assert len(calls) == 1
    assert calls[0][1] == uid_member
    assert str(rid) in calls[0][0]


@pytest.mark.asyncio
async def test_escalate_is_idempotent_409(
    client, _auth_signer, session_factory, monkeypatch
):
    from dcc_chat_gateway.routes import mod_queue as _mq

    async def _fake_escalate(body: str, target_user_id: int | None) -> str:
        return "1"

    monkeypatch.setattr(_mq, "escalate_report_to_operator", _fake_escalate)

    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    _, uid_member = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_member, t_owner)
    rid = await _seed_report(session_factory, _uid(), user_id=uid_member)

    first = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/escalate", headers=auth(t_owner)
    )
    assert first.status_code == 200
    second = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/escalate", headers=auth(t_owner)
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_escalate_non_mod_403(client, _auth_signer, session_factory):
    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    t_user, uid_user = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_user, t_owner)
    rid = await _seed_report(session_factory, _uid(), user_id=uid_user)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/escalate", headers=auth(t_user)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_escalate_operator_unreachable_502_leaves_report_open(
    client, _auth_signer, session_factory, monkeypatch
):
    """auth-svc down → 502 and NO escalated_at, so the mod can retry."""
    from dcc_chat_gateway.complaint_escalate import EscalationUnavailable
    from dcc_chat_gateway.routes import mod_queue as _mq

    async def _fake_escalate(body: str, target_user_id: int | None) -> str:
        raise EscalationUnavailable("auth-svc down")

    monkeypatch.setattr(_mq, "escalate_report_to_operator", _fake_escalate)

    t_owner, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    _, uid_member = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_member, t_owner)
    rid = await _seed_report(session_factory, _uid(), user_id=uid_member)

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/escalate", headers=auth(t_owner)
    )
    assert r.status_code == 502
    # not stamped → still escalatable
    listing = await client.get(
        f"/guilds/{g['id']}/mod-queue", headers=auth(t_owner)
    )
    match = [x for x in listing.json() if x["id"] == str(rid)]
    assert match and match[0]["escalated_at"] is None


@pytest.mark.asyncio
async def test_resolution_action_recorded_for_closed_tab(
    client, _auth_signer, session_factory
):
    """resolution_action carries the chosen action (drives the 'Erledigt'-Tab
    outcome); a dismiss records no action."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()

    rid1 = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))
    resolved = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid1}/resolve",
        json={"resolution": "resolved", "action_type": "other"},
        headers=auth(t_owner),
    )
    assert resolved.json()["resolution_action"] == "other"

    rid2 = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))
    dismissed = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid2}/resolve",
        json={"resolution": "dismissed", "action_type": "other"},
        headers=auth(t_owner),
    )
    # A dismiss carries no enforcement action.
    assert dismissed.json()["resolution_action"] is None


@pytest.mark.asyncio
async def test_user_report_with_target_guild_scopes_to_that_guild_only(
    client, _auth_signer
):
    """A user reported from a community's member list (target_guild_id set)
    appears ONLY in that community — not in every guild the target is in."""
    t_owner, _ = await _token(_auth_signer)
    g_a = await _make_guild(client, t_owner)
    g_b = await _make_guild(client, t_owner)

    t_target, uid_target = await _token(_auth_signer)
    await _add_member(client, g_a["id"], uid_target, t_owner)
    await _add_member(client, g_b["id"], uid_target, t_owner)

    t_reporter, _ = await _token(_auth_signer)
    created = await client.post(
        "/reports",
        json={
            "target_user_id": str(uid_target),
            "target_guild_id": g_a["id"],
            "reason_code": "harassment",
            "body": "",
        },
        headers=auth(t_reporter),
    )
    assert created.status_code == 201, created.text
    rid = created.json()["id"]

    in_a = await client.get(f"/guilds/{g_a['id']}/mod-queue", headers=auth(t_owner))
    assert rid in {r["id"] for r in in_a.json()}

    in_b = await client.get(f"/guilds/{g_b['id']}/mod-queue", headers=auth(t_owner))
    assert rid not in {r["id"] for r in in_b.json()}

    # Count badge follows the same scope.
    cnt_a = (await client.get(f"/guilds/{g_a['id']}/mod-queue/count", headers=auth(t_owner))).json()
    cnt_b = (await client.get(f"/guilds/{g_b['id']}/mod-queue/count", headers=auth(t_owner))).json()
    assert cnt_a["count"] == 1
    assert cnt_b["count"] == 0
