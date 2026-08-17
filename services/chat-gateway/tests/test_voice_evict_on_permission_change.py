"""Voice-Eviction bei Rechtsentzug (Bughunt 2026-08-17, Runde 2, Voice).

Lücke: der Entzug von CONNECT/VIEW_CHANNEL über eine Kanal-Überschreibung,
eine Rollenänderung oder das Entfernen einer Rolle von einem Mitglied ließ
eine bereits laufende Sprachsitzung unangetastet — die Oberfläche zeigte den
Kanal als geschlossen, LiveKit hörte munter weiter zu. Diese Tests prüfen,
dass die drei Routen jetzt ``evict_ineligible_from_voice_channels`` anstoßen
UND dass sie dabei niemanden treffen, der weiterhin darf (die Gegenprobe ist
hier wichtiger als der positive Fall — ein Fix, der zu viel wirft, reißt
legitime Gespräche ab).

Ergänzt außerdem die verbleibenden zwei Befunde derselben Runde:
* die 100-Kanal-Grenze der internen Evict-Route wird durch Stückelung
  eingehalten statt die ganze Anfrage still scheitern zu lassen;
* Voice-Pull auf einen Nutzer mit bestehendem deny(CONNECT/VIEW_CHANNEL)
  meldet 409 statt Erfolg vorzutäuschen.
"""

from __future__ import annotations

import random

import dcc_chat_gateway.voice_evict as voice_evict
import pytest
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.permissions import OVERWRITE_TARGET_ROLE, OVERWRITE_TARGET_USER
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.permissions import Permissions


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _make_channel(client, token, guild_id, name, type_):
    return (
        await client.post(
            f"/guilds/{guild_id}/channels",
            json={"name": name, "type": type_},
            headers=auth(token),
        )
    ).json()


async def _add_member(client, token_owner, guild_id, uid):
    await client.post(
        f"/guilds/{guild_id}/members",
        json={"user_id": str(uid)},
        headers=auth(token_owner),
    )


async def _everyone(client, token, guild_id) -> dict:
    roles = (await client.get(f"/guilds/{guild_id}/roles", headers=auth(token))).json()
    return next(r for r in roles if r["is_everyone"])


def _capture_post_evict(monkeypatch):
    """Monkeypatch ``voice_evict.get_settings`` (Secret gesetzt) +
    ``voice_evict._post_evict`` (Netzwerk abgeklemmt, Aufrufe gesammelt).
    Gleiches Muster wie ``test_evict_all_fires_per_present_user``."""
    calls: list[tuple[list[int], str]] = []

    async def _capture(_secret, channel_ids, user_id):
        calls.append(([int(c) for c in channel_ids], user_id))

    monkeypatch.setattr(voice_evict, "_post_evict", _capture)
    monkeypatch.setattr(
        voice_evict,
        "get_settings",
        lambda: type("S", (), {"internal_service_secret": "s"})(),
    )
    return calls


async def _sadd(app, channel_id, uid) -> None:
    await app.state.redis.sadd(f"voice:room:channel-{channel_id}", str(uid))


# ---- Befund 1: Überschreibung (permission_overwrites.py) -------------------


@pytest.mark.asyncio
async def test_overwrite_deny_connect_evicts_present_user(
    client, app, _auth_signer, monkeypatch
):
    """Deny(CONNECT) per User-Überschreibung auf einem Sprachkanal wirft den
    dort präsenten Nutzer raus — ohne den Fix bleibt er stumm sitzen."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)
    await _sadd(app, v["id"], uid_other)

    calls = _capture_post_evict(monkeypatch)

    r = await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": str(int(Permissions.CONNECT))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert ([int(v["id"])], str(uid_other)) in calls


@pytest.mark.asyncio
async def test_overwrite_deny_does_not_evict_unaffected_user(
    client, app, _auth_signer, monkeypatch
):
    """Gegenprobe: in DEMSELBEN Kanal sitzt ein zweiter Nutzer ohne die neue
    deny-Überschreibung — der darf bleiben. Ein Fix, der ihn mitwirft, wäre
    schlimmer als die Lücke selbst."""
    t_owner, _ = await _register_user(_auth_signer)
    t_hit, uid_hit = await _register_user(_auth_signer)
    t_safe, uid_safe = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_hit)
    await _add_member(client, t_owner, g["id"], uid_safe)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)
    await _sadd(app, v["id"], uid_hit)
    await _sadd(app, v["id"], uid_safe)

    calls = _capture_post_evict(monkeypatch)

    r = await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_hit}",
        json={"allow": "0", "deny": str(int(Permissions.CONNECT))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    hit_uids = {uid for _cids, uid in calls}
    assert str(uid_hit) in hit_uids
    assert str(uid_safe) not in hit_uids


@pytest.mark.asyncio
async def test_overwrite_on_text_channel_does_not_touch_voice_evict(
    client, app, _auth_signer, monkeypatch
):
    """Ein Overwrite auf einem TEXT-Kanal darf den Voice-Auswurfweg gar nicht
    erst ansprechen (Guard in permission_overwrites.py auf CHANNEL_TYPE_VOICE)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    txt = await _make_channel(client, t_owner, g["id"], "txt", 0)

    calls = _capture_post_evict(monkeypatch)

    r = await client.put(
        f"/channels/{txt['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": str(int(Permissions.SEND_MESSAGES))},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert calls == []


# ---- Befund 1: Rollenänderung (roles.py, guild-weit) ------------------------


@pytest.mark.asyncio
async def test_patch_everyone_role_removes_connect_evicts_present_user(
    client, app, _auth_signer, monkeypatch
):
    """CONNECT aus der @everyone-Rolle nehmen entzieht jedem gewöhnlichen
    Mitglied den Zugang zu einem öffentlichen Sprachkanal — der Präsente
    muss geworfen werden."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)
    everyone = await _everyone(client, t_owner, g["id"])
    await _sadd(app, v["id"], uid_other)
    # Der Owner sitzt ebenfalls im Kanal — er resolved über GRANT_ALL_SAFE
    # und darf durch die Rollenänderung NIE betroffen sein (Gegenprobe).
    await _sadd(app, v["id"], uid_owner)

    calls = _capture_post_evict(monkeypatch)

    new_perms = int(everyone["permissions"]) & ~int(Permissions.CONNECT)
    r = await client.patch(
        f"/guilds/{g['id']}/roles/{everyone['id']}",
        json={"permissions": str(new_perms)},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    hit_uids = {uid for _cids, uid in calls}
    assert str(uid_other) in hit_uids
    assert str(uid_owner) not in hit_uids  # Owner-Ausnahme, siehe oben


@pytest.mark.asyncio
async def test_patch_role_unrelated_bit_does_not_evict(
    client, app, _auth_signer, monkeypatch
):
    """Gegenprobe: eine Rollenänderung, die CONNECT/VIEW_CHANNEL unangetastet
    lässt (nur ein anderes Bit ändert sich), wirft niemanden."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)
    everyone = await _everyone(client, t_owner, g["id"])
    await _sadd(app, v["id"], uid_other)

    calls = _capture_post_evict(monkeypatch)

    # SEND_MESSAGES dazu- oder wegnehmen berührt VIEW_CHANNEL/CONNECT nicht.
    new_perms = int(everyone["permissions"]) & ~int(Permissions.SEND_MESSAGES)
    r = await client.patch(
        f"/guilds/{g['id']}/roles/{everyone['id']}",
        json={"permissions": str(new_perms)},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert calls == []


# ---- Befund 1: Rollenentzug vom Mitglied (role_members.py) -----------------


@pytest.mark.asyncio
async def test_unassign_role_evicts_from_private_channel(
    client, app, _auth_signer, monkeypatch
):
    """Ein privater Sprachkanal (deny VIEW_CHANNEL für @everyone) ist nur
    über eine Rollen-Überschreibung sichtbar. Die Rolle entziehen nimmt genau
    diesen Zugang wieder — der Anwesende muss geworfen werden."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "secret-voice", CHANNEL_TYPE_VOICE)
    everyone = await _everyone(client, t_owner, g["id"])
    await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{everyone['id']}",
        json={"allow": "0", "deny": str(int(Permissions.VIEW_CHANNEL))},
        headers=auth(t_owner),
    )
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": "invited", "permissions": "0"},
            headers=auth(t_owner),
        )
    ).json()
    await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_ROLE}/{role['id']}",
        json={"allow": str(int(Permissions.VIEW_CHANNEL | Permissions.CONNECT)), "deny": "0"},
        headers=auth(t_owner),
    )
    r = await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{role['id']}", headers=auth(t_owner)
    )
    assert r.status_code == 204, r.text
    await _sadd(app, v["id"], uid_other)

    calls = _capture_post_evict(monkeypatch)

    r = await client.delete(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{role['id']}", headers=auth(t_owner)
    )
    assert r.status_code == 204, r.text
    assert ([int(v["id"])], str(uid_other)) in calls


@pytest.mark.asyncio
async def test_unassign_unrelated_role_does_not_evict(client, app, _auth_signer, monkeypatch):
    """Gegenprobe: ein Mitglied verliert eine Rolle, die mit Voice-Zugang
    nichts zu tun hat — bleibt unbehelligt, auch wenn es gerade im Kanal
    sitzt (Zugang kommt hier aus dem öffentlichen Default)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)
    role = (
        await client.post(
            f"/guilds/{g['id']}/roles",
            json={"name": "color-only", "permissions": "0"},
            headers=auth(t_owner),
        )
    ).json()
    await client.put(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{role['id']}", headers=auth(t_owner)
    )
    await _sadd(app, v["id"], uid_other)

    calls = _capture_post_evict(monkeypatch)

    r = await client.delete(
        f"/guilds/{g['id']}/members/{uid_other}/roles/{role['id']}", headers=auth(t_owner)
    )
    assert r.status_code == 204, r.text
    assert calls == []


# ---- Befund 2: >100 Sprachkanäle -> Stückelung statt stillem Fehlschlag ----


@pytest.mark.asyncio
async def test_evict_user_chunks_over_100_channels(client, _auth_signer, session_factory, monkeypatch):
    """Vorher: eine Community mit >100 Sprachkanälen ließ den GESAMTEN Auswurf
    an der ``max_length=100``-Feldgrenze der Gegenseite scheitern (eine
    Anfrage, eine Ablehnung). Jetzt: mehrere Anfragen zu je höchstens 100."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    guild_id = int(g["id"])

    n = 150
    channel_ids = [next_id() for _ in range(n)]
    async with session_factory() as s:
        for i, cid in enumerate(channel_ids):
            s.add(
                Channel(
                    id=cid, guild_id=guild_id, name=f"v{i}", type=CHANNEL_TYPE_VOICE, position=i
                )
            )
        await s.commit()

    calls: list[list[int]] = []

    async def _capture(_secret, cids, _uid):
        calls.append(list(cids))

    monkeypatch.setattr(voice_evict, "_post_evict", _capture)
    monkeypatch.setattr(
        voice_evict,
        "get_settings",
        lambda: type("S", (), {"internal_service_secret": "s"})(),
    )

    async with session_factory() as s:
        await voice_evict.evict_user_from_guild_voice(s, guild_id, 999)

    assert len(calls) == 2  # ceil(150 / 100)
    assert all(len(block) <= 100 for block in calls)
    covered = {int(c) for block in calls for c in block}
    assert covered == set(channel_ids)


# ---- Befund 4: Voice-Pull gegen bestehendes deny -> 409 --------------------


@pytest.mark.asyncio
async def test_voice_pull_conflicts_with_existing_deny(client, _auth_signer):
    """Vorher: das Verschieben verOderte nur das allow-Bit, rührte deny NICHT
    an (deny gewinnt im Resolver) und meldete trotzdem Erfolg — der Nutzer
    blieb draußen, ohne dass irgendwer das merkte. Jetzt: 409 statt 200."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)

    deny = await client.put(
        f"/channels/{v['id']}/permissions/{OVERWRITE_TARGET_USER}/{uid_other}",
        json={"allow": "0", "deny": str(int(Permissions.CONNECT))},
        headers=auth(t_owner),
    )
    assert deny.status_code == 200, deny.text

    r = await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-move", headers=auth(t_owner)
    )
    assert r.status_code == 409, r.text

    # Das Verbot bleibt unangetastet — kein stilles Überschreiben.
    rows = (await client.get(f"/channels/{v['id']}/permissions", headers=auth(t_owner))).json()
    ow = next(
        row
        for row in rows
        if row["target_type"] == OVERWRITE_TARGET_USER and row["target_id"] == str(uid_other)
    )
    assert int(ow["deny"]) & int(Permissions.CONNECT)
    assert int(ow["allow"]) == 0  # kein Pull-Allow ist reingerutscht


@pytest.mark.asyncio
async def test_voice_pull_succeeds_without_conflicting_deny(client, _auth_signer):
    """Gegenprobe zu Befund 4: ohne bestehendes deny funktioniert das
    Verschieben weiterhin normal (200, nicht fälschlich 409)."""
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await _add_member(client, t_owner, g["id"], uid_other)
    v = await _make_channel(client, t_owner, g["id"], "voice", CHANNEL_TYPE_VOICE)

    r = await client.post(
        f"/channels/{v['id']}/members/{uid_other}/voice-move", headers=auth(t_owner)
    )
    assert r.status_code == 200, r.text
