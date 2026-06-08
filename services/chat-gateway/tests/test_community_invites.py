"""Tests for the Cloud-only Community-Invite-Broker (Stufe 2 / B-lite).

Covers ``routes/community_invites.py`` (POST-only since 2026-06-08 — the
invite is delivered as a **DM** with a join-card, there's no friends-tab list,
so no GET/DELETE route + no ``community_invite_received`` push anymore):
  * create → row written + invite link dropped as a DM (cloud + self-host link)
  * create no longer emits a ``community_invite_received`` push
  * friend-gate: only confirmed friends may be invited; blocks (either way) deny
  * dedupe (re-invite) → single row, the existing DM card rewritten in place
  * rate-limit per inviter
  * CloudOnly gate: self-host returns 404 on POST

The (absence of a) WS push is asserted by spying on
``manager.publish_user_event`` (same pattern as ``test_friend_ws_events.py``).

Product model: "erst befreundet, DANN einladen" → every success-path test wires
a confirmed friendship between inviter and invitee first (via the ``friend_pair``
conftest fixture, which writes a ``friendships`` row directly).
"""

from __future__ import annotations

import random

import pytest

# Broker is cloud-only — ensure cloud mode for all tests here.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _install_block(session_factory, blocker_id: int, blocked_id: int) -> None:
    """Install a directional block row (blocker → blocked)."""
    from dcc_chat_gateway.models import UserBlock

    async with session_factory() as s:
        s.add(UserBlock(blocker_id=blocker_id, blocked_id=blocked_id))
        await s.commit()


def _payload(invitee_id: int, **over) -> dict:
    base = {
        "invitee_id": str(invitee_id),
        "target_host": "pulse.firma.de",
        "target_instance_id": "100",
        "target_guild_id": "42",
        "target_guild_name": "Cool Community",
        "code": "ABCD1234",
    }
    base.update(over)
    return base


@pytest.fixture
def captured_events(app, monkeypatch):
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)
    return captured


def _ops_for(captured, target_uid: int) -> list[str]:
    return [e["op"] for (tid, e) in captured if tid == str(target_uid)]


# ---- create + friend-gate --------------------------------------------------


@pytest.mark.asyncio
async def test_create_returns_row_and_no_user_push(
    client, _auth_signer, captured_events, friend_pair
):
    """POST returns the broker row and emits NO ``community_invite_*`` push.

    Delivery is now the DM card (asserted in the DM tests below); the old
    per-user push to the invitee is gone, so neither party gets one.
    """
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["inviter_id"] == str(uid_a)
    assert body["invitee_id"] == str(uid_b)
    assert body["target_host"] == "pulse.firma.de"
    assert body["target_guild_name"] == "Cool Community"
    assert body["code"] == "ABCD1234"
    # No more friends-tab card → no ``community_invite_received``/_removed push
    # to either party (the DM is the delivery channel now).
    assert _ops_for(captured_events, uid_b) == []
    assert _ops_for(captured_events, uid_a) == []


@pytest.mark.asyncio
async def test_create_drops_invite_dm_self_host(
    client, _auth_signer, friend_pair, session_factory
):
    """A self-host invite lands as a DM whose content is the host-tagged link.

    The DM must be authored by the inviter, sit in the inviter↔invitee DM
    channel, and carry ``…/invite/<code>?host=<fqdn>`` so the receiving
    client's ``INVITE_RE`` renders the "Beitreten"-card.
    """
    from dcc_chat_gateway.models import DirectMessageChannel, Message

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites",
        json=_payload(uid_b, target_host="pulse.firma.de", code="ABCD1234"),
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text

    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        from sqlalchemy import select

        dm = (
            await s.execute(
                select(DirectMessageChannel).where(
                    DirectMessageChannel.user_a_id == lo,
                    DirectMessageChannel.user_b_id == hi,
                )
            )
        ).scalars().first()
        assert dm is not None, "invite did not create the DM channel"
        msgs = (
            await s.execute(
                select(Message).where(Message.channel_id == dm.id)
            )
        ).scalars().all()
    assert len(msgs) == 1
    msg = msgs[0]
    assert msg.author_id == uid_a
    assert (
        msg.content == "https://howispulse.com/invite/ABCD1234?host=pulse.firma.de"
    )


@pytest.mark.asyncio
async def test_create_drops_invite_dm_cloud(
    client, _auth_signer, friend_pair, session_factory
):
    """A Cloud invite (target_host == Cloud origin) yields a host-less link."""
    from dcc_chat_gateway.models import DirectMessageChannel, Message

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites",
        json=_payload(
            uid_b, target_host="https://howispulse.com", code="CLOUD000"
        ),
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text

    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        from sqlalchemy import select

        dm = (
            await s.execute(
                select(DirectMessageChannel).where(
                    DirectMessageChannel.user_a_id == lo,
                    DirectMessageChannel.user_b_id == hi,
                )
            )
        ).scalars().first()
        assert dm is not None
        msg = (
            await s.execute(
                select(Message).where(Message.channel_id == dm.id)
            )
        ).scalars().first()
    assert msg is not None
    assert msg.content == "https://howispulse.com/invite/CLOUD000"


@pytest.mark.asyncio
async def test_create_to_non_friend_rejected(client, _auth_signer):
    """No friendship → 403 (product model "erst befreundet, DANN einladen")."""
    t_a, _ = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "not_friends"


@pytest.mark.asyncio
async def test_create_to_blocked_rejected_outgoing(
    client, _auth_signer, friend_pair, session_factory
):
    """Inviter blocked the invitee → 403 even if they were friends before."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _install_block(session_factory, blocker_id=uid_a, blocked_id=uid_b)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "block_in_place"


@pytest.mark.asyncio
async def test_create_to_blocked_rejected_incoming(
    client, _auth_signer, friend_pair, session_factory
):
    """Invitee blocked the inviter → 403 (block wins in either direction)."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _install_block(session_factory, blocker_id=uid_b, blocked_id=uid_a)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "block_in_place"


@pytest.mark.asyncio
async def test_create_self_invite_rejected(client, _auth_signer):
    t_a, uid_a = await _register(_auth_signer)
    r = await client.post(
        "/community-invites", json=_payload(uid_a), headers=auth(t_a)
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_invite_yourself"


@pytest.mark.asyncio
async def test_create_requires_auth(client, _auth_signer):
    _, uid_b = await _register(_auth_signer)
    r = await client.post("/community-invites", json=_payload(uid_b))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_create_dedupes_same_inviter_invitee_guild(
    client, _auth_signer, friend_pair, session_factory
):
    """A repeat invite (same inviter→invitee→guild) collapses to one row, with
    the newest code winning — AND the existing DM card is rewritten in place
    (no second card stacked, the stale code is gone from the thread)."""
    from dcc_chat_gateway.models import CommunityInvite, DirectMessageChannel, Message

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/community-invites",
        json=_payload(uid_b, code="OLD00000"),
        headers=auth(t_a),
    )
    await client.post(
        "/community-invites",
        json=_payload(uid_b, code="NEW00000"),
        headers=auth(t_a),
    )

    from sqlalchemy import select

    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        # Exactly one broker row, newest code wins.
        rows = (
            await s.execute(
                select(CommunityInvite).where(
                    CommunityInvite.inviter_id == uid_a,
                    CommunityInvite.invitee_id == uid_b,
                )
            )
        ).scalars().all()
        assert len(rows) == 1
        assert rows[0].code == "NEW00000"
        # Exactly one DM card; it points at the new code, the old one is gone.
        dm = (
            await s.execute(
                select(DirectMessageChannel).where(
                    DirectMessageChannel.user_a_id == lo,
                    DirectMessageChannel.user_b_id == hi,
                )
            )
        ).scalars().first()
        msgs = (
            await s.execute(
                select(Message).where(
                    Message.channel_id == dm.id,
                    Message.deleted_at.is_(None),
                )
            )
        ).scalars().all()
    assert len(msgs) == 1
    assert "NEW00000" in msgs[0].content
    assert "OLD00000" not in msgs[0].content
    # Rewritten in place → marked edited.
    assert msgs[0].edited_at is not None


@pytest.mark.asyncio
async def test_reinvite_after_card_deleted_posts_fresh(
    client, _auth_signer, friend_pair, session_factory
):
    """If the inviter deleted the old card, the re-invite posts a fresh DM
    rather than failing to find one to rewrite."""
    from dcc_chat_gateway.models import CommunityInvite, DirectMessageChannel, Message

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/community-invites",
        json=_payload(uid_b, code="OLD00000"),
        headers=auth(t_a),
    )

    from datetime import UTC, datetime

    from sqlalchemy import select, update

    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        # Simulate the user deleting the first card.
        await s.execute(
            update(Message)
            .where(Message.author_id == uid_a)
            .values(deleted_at=datetime.now(tz=UTC))
        )
        await s.commit()

    await client.post(
        "/community-invites",
        json=_payload(uid_b, code="NEW00000"),
        headers=auth(t_a),
    )
    async with session_factory() as s:
        dm = (
            await s.execute(
                select(DirectMessageChannel).where(
                    DirectMessageChannel.user_a_id == lo,
                    DirectMessageChannel.user_b_id == hi,
                )
            )
        ).scalars().first()
        live = (
            await s.execute(
                select(Message).where(
                    Message.channel_id == dm.id,
                    Message.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        broker = (
            await s.execute(
                select(CommunityInvite).where(CommunityInvite.invitee_id == uid_b)
            )
        ).scalars().all()
    assert len(broker) == 1
    assert len(live) == 1
    assert "NEW00000" in live[0].content


@pytest.mark.asyncio
async def test_unique_dedupe_index_rejects_duplicate_triple(session_factory):
    """The dedupe index is UNIQUE — the DB itself rejects a second row for the
    same (inviter, invitee, guild). That's what makes the broker's collapse
    race-safe: a concurrent double-POST can't stack two rows / two cards (the
    route catches the resulting IntegrityError and resolves to the winner's
    row). Guards against the model index silently losing ``unique=True``."""
    from sqlalchemy.exc import IntegrityError

    from dcc_chat_gateway.models import CommunityInvite
    from dcc_chat_gateway.snowflake import next_id

    def _row() -> CommunityInvite:
        return CommunityInvite(
            id=next_id(),
            inviter_id=111,
            invitee_id=222,
            target_host="pulse.firma.de",
            target_instance_id=100,
            target_guild_id=42,
            target_guild_name="Cool Community",
            code="ABCD1234",
        )

    async with session_factory() as s:
        s.add(_row())
        await s.commit()

    # Same triple, fresh id → the unique index must reject the second insert.
    async with session_factory() as s:
        s.add(_row())
        with pytest.raises(IntegrityError):
            await s.commit()


# ---- rate limit ------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_rate_limited_per_inviter(
    client, _auth_signer, friend_pair
):
    import dcc_chat_gateway.ratelimit as rl

    t_a, uid_a = await _register(_auth_signer)
    limit, _ = rl._RULES["community_invite"]
    # Burn the whole budget with distinct (friended) invitees.
    for _ in range(limit):
        _, uid_x = await _register(_auth_signer)
        await friend_pair(uid_a, uid_x)
        r = await client.post(
            "/community-invites", json=_payload(uid_x), headers=auth(t_a)
        )
        assert r.status_code == 201, r.text
    _, uid_last = await _register(_auth_signer)
    await friend_pair(uid_a, uid_last)
    r = await client.post(
        "/community-invites", json=_payload(uid_last), headers=auth(t_a)
    )
    assert r.status_code == 429


# ---- CloudOnly gate --------------------------------------------------------


@pytest.mark.asyncio
async def test_self_host_returns_404(client, _auth_signer, _isolate_chat_settings):
    """On a self-host instance the broker POST 404s (CloudOnly guard)."""
    _isolate_chat_settings.pulse_instance_mode = "self-host"
    t_a, _ = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r_post = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r_post.status_code == 404
