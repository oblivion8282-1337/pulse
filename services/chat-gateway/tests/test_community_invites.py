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
async def test_create_liefert_zeile_und_benachrichtigt(
    client, _auth_signer, captured_events, friend_pair, session_factory
):
    """POST liefert unveraendert das Broker-Format und stellt in die Inbox zu.

    Das Antwortformat ist bewusst feldgleich geblieben, obwohl die Zeile jetzt
    aus einer anderen Tabelle stammt — ein Refactoring darf das Verhalten nach
    aussen nicht aendern. Zugestellt wird ueber ``community_invite_received``,
    dieselbe Schiene wie bei der Nutzername-Einladung.
    """
    from dcc_chat_gateway.models import CommunityInviteNotification

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

    assert _ops_for(captured_events, uid_b) == ["community_invite_received"]
    # Der Einladende bekommt nichts — er hat keine Liste offener Einladungen.
    assert _ops_for(captured_events, uid_a) == []

    async with session_factory() as s:
        zeile = await s.get(CommunityInviteNotification, int(body["id"]))
    assert zeile is not None
    assert zeile.invitee_user_id == uid_b
    assert zeile.target_host == "pulse.firma.de"
    assert zeile.code == "ABCD1234"
    assert zeile.guild_name == "Cool Community"


@pytest.mark.asyncio
async def test_create_schreibt_keine_nachricht(
    client, _auth_signer, friend_pair, session_factory
):
    """Die eigentliche Zusage dieser Etappe: KEINE Nachricht, kein DM-Kanal.

    Bis 2026-08-27 legte der Broker eine ``Message`` mit der ``author_id`` des
    Einladenden an — eine Nachricht im Namen eines Dritten. Mit
    Ende-zu-Ende-verschluesselten Direktnachrichten ist das unmoeglich, dem
    Server fehlt dafuer der Schluessel. Ohne diesen Test koennte ein spaeterer
    Umbau die Zusage stillschweigend zuruecknehmen.
    """
    from sqlalchemy import func, select

    from dcc_chat_gateway.models import DirectMessageChannel, Message

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 201, r.text

    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        nachrichten = (
            await s.execute(select(func.count()).select_from(Message))
        ).scalar_one()
        dm = (
            await s.execute(
                select(DirectMessageChannel).where(
                    DirectMessageChannel.user_a_id == lo,
                    DirectMessageChannel.user_b_id == hi,
                )
            )
        ).scalars().first()
    assert nachrichten == 0, "die Einladung hat eine Nachricht geschrieben"
    assert dm is None, "die Einladung hat einen DM-Kanal angelegt"


@pytest.mark.asyncio
async def test_create_cloud_ziel_ohne_host(
    client, _auth_signer, friend_pair, session_factory
):
    """Cloud-Ziel: ``target_host`` bleibt leer, der Beitritt laeuft hier."""
    from dcc_chat_gateway.models import CommunityInviteNotification

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites",
        json=_payload(uid_b, target_host="howispulse.com", target_instance_id=None),
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text

    async with session_factory() as s:
        zeile = await s.get(CommunityInviteNotification, int(r.json()["id"]))
    assert zeile is not None
    assert zeile.target_host == "howispulse.com"


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
async def test_create_to_existing_cloud_member_rejected(
    client, _auth_signer, friend_pair, session_factory
):
    """Invitee already a member of the target CLOUD community → 409.

    ``target_instance_id`` None == Cloud → the broker can reach the Cloud
    ``guild_members`` table and refuses a pointless re-invite (the invitee
    would just see a "Beitreten"-card for a community they're already in).
    """
    from dcc_chat_gateway.models import Guild, GuildMember

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    # Cloud guild 4242, uid_b bereits Mitglied.
    async with session_factory() as s:
        s.add(Guild(id=4242, name="G", owner_id=uid_a))
        s.add(GuildMember(guild_id=4242, user_id=uid_b))
        await s.commit()
    r = await client.post(
        "/community-invites",
        json=_payload(uid_b, target_instance_id=None, target_guild_id="4242"),
        headers=auth(t_a),
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "already_member"


@pytest.mark.asyncio
async def test_create_to_non_member_cloud_passes(
    client, _auth_signer, friend_pair
):
    """Cloud target, invitee NOT a member → 201 (guard prüft, überschießt nicht)."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites",
        json=_payload(uid_b, target_instance_id=None, target_guild_id="4242"),
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_create_requires_auth(client, _auth_signer):
    _, uid_b = await _register(_auth_signer)
    r = await client.post("/community-invites", json=_payload(uid_b))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_create_dedupes_pro_guild_und_empfaenger(
    client, _auth_signer, friend_pair, session_factory
):
    """Zweimal einladen erzeugt EINE Zeile, kein Stapel."""
    from sqlalchemy import func, select

    from dcc_chat_gateway.models import CommunityInviteNotification

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)

    r1 = await client.post("/community-invites", json=_payload(uid_b), headers=auth(t_a))
    r2 = await client.post("/community-invites", json=_payload(uid_b), headers=auth(t_a))
    assert r1.status_code == 201 and r2.status_code == 201, r2.text
    # Dieselbe Zeile, nicht zwei — die Kennung bleibt stabil, damit die Karte
    # beim Empfaenger nicht springt.
    assert r1.json()["id"] == r2.json()["id"]

    async with session_factory() as s:
        anzahl = (
            await s.execute(
                select(func.count()).select_from(CommunityInviteNotification)
            )
        ).scalar_one()
    assert anzahl == 1


@pytest.mark.asyncio
async def test_reinvite_schreibt_frischen_code_fort(
    client, _auth_signer, friend_pair, session_factory
):
    """Erneut einladen aktualisiert den Code auf der vorhandenen Zeile.

    Der Einladende holt sich beim zweiten Anlauf einen frischen host-gepraegten
    Code; die Einladung beim Empfaenger muss darauf zeigen, ohne dass eine
    zweite danebensteht.
    """
    from dcc_chat_gateway.models import CommunityInviteNotification

    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)

    r1 = await client.post(
        "/community-invites", json=_payload(uid_b, code="ALT12345"), headers=auth(t_a)
    )
    r2 = await client.post(
        "/community-invites", json=_payload(uid_b, code="NEU67890"), headers=auth(t_a)
    )
    assert r1.status_code == 201 and r2.status_code == 201, r2.text
    assert r1.json()["id"] == r2.json()["id"]
    assert r2.json()["code"] == "NEU67890"

    async with session_factory() as s:
        zeile = await s.get(CommunityInviteNotification, int(r2.json()["id"]))
    assert zeile is not None and zeile.code == "NEU67890"


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
