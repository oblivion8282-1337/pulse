"""FCM-Token-Routen + Push-Wege (Übergabe P0.1).

Abgedeckt sind die drei Pflichte der Aufgabe — Token-Speichern (Upsert +
Token-Übernahme durch ein anderes Konto), Drossel und Auth — plus das
inhaltsfreie Push-Bein: Offline-Gate, graceful degradation ohne
Service-Account-Key und Aufräumen toter Tokens.
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway.models import FcmToken


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _register_token(client, token: str, fcm: str, geraet: str = "handy-1"):
    return await client.post(
        "/fcm/token", json={"token": fcm, "geraet_id": geraet}, headers=_auth(token)
    )


async def _tokens(session_factory, uid: int) -> list[FcmToken]:
    from sqlalchemy import select

    async with session_factory() as s:
        rows = (
            (await s.execute(select(FcmToken).where(FcmToken.user_id == uid)))
            .scalars()
            .all()
        )
        return list(rows)


# ---------------------------------------------------------------------------
# Routen


async def test_speichern_upsert_je_geraet(client, _auth_signer, session_factory):
    token, uid = _user(_auth_signer)
    r = await _register_token(client, token, "fcm-token-a")
    assert r.status_code == 204, r.text
    r = await _register_token(client, token, "fcm-token-b")
    assert r.status_code == 204
    rows = await _tokens(session_factory, uid)
    # Upsert desselben Geräts: eine Zeile, Token aufgefrischt.
    assert len(rows) == 1
    assert rows[0].token == "fcm-token-b"
    r = await _register_token(client, token, "fcm-token-a", geraet="tablet-1")
    assert r.status_code == 204
    rows = await _tokens(session_factory, uid)
    assert {row.geraet_id for row in rows} == {"handy-1", "tablet-1"}


async def test_token_gehoert_genau_einem_konto(
    client, _auth_signer, session_factory
):
    token_a, uid_a = _user(_auth_signer)
    token_b, uid_b = _user(_auth_signer)
    await _register_token(client, token_a, "shared-fcm-token", geraet="alt")
    r = await _register_token(client, token_b, "shared-fcm-token", geraet="neu")
    assert r.status_code == 204
    # Dasselbe physische Gerät kann nach Neuanmeldung nur noch Konto B erreichen.
    assert await _tokens(session_factory, uid_a) == []
    rows_b = await _tokens(session_factory, uid_b)
    assert len(rows_b) == 1 and rows_b[0].token == "shared-fcm-token"


async def test_auth_pflicht(client):
    r = await client.post(
        "/fcm/token", json={"token": "fcm-x", "geraet_id": "g1"}
    )
    assert r.status_code == 401, r.text
    r = await client.request("DELETE", "/fcm/token", json={"token": "fcm-x"})
    assert r.status_code == 401, r.text


async def test_drossel(client, _auth_signer):
    token, uid = _user(_auth_signer)
    statuses = []
    for i in range(11):  # Regel: 10/Minute — der elfte Aufruf fällt in die Bremse
        r = await _register_token(client, token, f"fcm-{i}", geraet=f"g{i % 2}")
        statuses.append(r.status_code)
    assert statuses[:10] == [204] * 10
    assert statuses[10] == 429


async def test_entfernen_idempotent(client, _auth_signer, session_factory):
    token, uid = _user(_auth_signer)
    await _register_token(client, token, "fcm-weg")
    r = await client.request(
        "DELETE", "/fcm/token", json={"token": "fcm-weg"}, headers=_auth(token)
    )
    assert r.status_code == 204
    assert await _tokens(session_factory, uid) == []
    # Nochmal löschen (anderes Gerät, gleicher Token weg) bleibt still 204.
    r = await client.request(
        "DELETE", "/fcm/token", json={"token": "fcm-weg"}, headers=_auth(token)
    )
    assert r.status_code == 204


# ---------------------------------------------------------------------------
# Push-Bein (fcm.fan_out_fcm_dm_push)


class _ManagerStub:
    """Duck-typed ConnectionManager: 0 Sockets = offline."""

    def __init__(self, sockets_by_user: dict[int, int]):
        self._counts = sockets_by_user

    def user_socket_count(self, user_id: int) -> int:
        return self._counts.get(user_id, 0)


@pytest.fixture
def _fcm_sender(monkeypatch):
    """Stub der Sendefunktion + Firebase-App-Wächter; sammelt Aufrufe."""
    import dcc_chat_gateway.fcm as fcm_mod

    sent: list[tuple[str, dict]] = []

    def _fake_send(*, token: str, payload: dict) -> str:
        sent.append((token, payload))
        return "ok"

    monkeypatch.setattr(fcm_mod, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm_mod, "_send_one", _fake_send)
    return sent


async def test_push_nur_an_offline_empfaenger(
    client, session_factory, _fcm_sender
):
    import dcc_chat_gateway.fcm as fcm_mod

    async with session_factory() as s:
        s.add(FcmToken(user_id=111, geraet_id="g1", token="tok-offline"))
        s.add(FcmToken(user_id=222, geraet_id="g1", token="tok-online"))
        await s.commit()

    n = await fcm_mod.fan_out_fcm_dm_push(
        recipient_ids={111, 222},
        author_name="Anna",
        channel_id=42,
        manager=_ManagerStub({222: 2}),
    )
    assert n == 1
    # Nur der Offline-Empfänger; Nutzlast inhaltsfrei (Absender + Kanal, nie Text).
    assert len(_fcm_sender) == 1
    tok, payload = _fcm_sender[0]
    assert tok == "tok-offline"
    assert payload == {
        "type": "dm",
        "title": "Anna",
        "body": fcm_mod.DM_BODY,
        "channel_id": "42",
    }


async def test_push_graceful_ohne_key(client, session_factory, monkeypatch):
    """Kein FIREBASE_SERVICE_ACCOUNT_KEY → kein Push, kein Crash."""
    import dcc_chat_gateway.fcm as fcm_mod

    monkeypatch.setattr(fcm_mod, "ensure_fcm", lambda: None)
    async with session_factory() as s:
        s.add(FcmToken(user_id=333, geraet_id="g1", token="tok-333"))
        await s.commit()
    n = await fcm_mod.fan_out_fcm_dm_push(
        recipient_ids={333}, author_name="Anna", channel_id=42
    )
    assert n == 0


async def test_push_raeumt_tote_tokens(client, session_factory, monkeypatch):
    import dcc_chat_gateway.fcm as fcm_mod

    async with session_factory() as s:
        s.add(FcmToken(user_id=444, geraet_id="g1", token="tok-dead"))
        await s.commit()

    monkeypatch.setattr(fcm_mod, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm_mod, "_send_one", lambda *, token, payload: "dead")
    n = await fcm_mod.fan_out_fcm_dm_push(
        recipient_ids={444}, author_name="Anna", channel_id=42
    )
    assert n == 0
    from sqlalchemy import select

    async with session_factory() as s:
        assert (
            await s.execute(select(FcmToken).where(FcmToken.user_id == 444))
        ).scalar_one_or_none() is None
