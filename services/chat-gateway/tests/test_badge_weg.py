"""Der ganze Weg der Badge-Zahl: Push-Versand und Klienten-Korrektur.

Zwei Hälften, die zusammen die Zahl am App-Icon richtig halten:
 1. Jeder hinausgehende DM-Push erhöht den Zähler des EMPFÄNGERS und trägt
    dessen Stand als ``aps.badge`` mit (Fortschreibung, während die App
    schläft).
 2. Die wache App meldet ihren exakten Stand (``POST /fcm/badge``) und
    überschreibt die Fortschreibung — sie hat den Klartext, der Server nicht.
"""

import pytest

from dcc_chat_gateway import badgezaehler
from dcc_chat_gateway.models import FcmToken



def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class _ManagerStub:
    """Duck-typed ConnectionManager: 0 Sockets = offline, plus Redis."""

    def __init__(self, redis, sockets_by_user: dict[int, int] | None = None):
        self.redis = redis
        self._counts = sockets_by_user or {}

    def user_socket_count(self, user_id: int) -> int:
        return self._counts.get(user_id, 0)


@pytest.fixture
def _fcm_sender(monkeypatch):
    """Stub der Sendefunktion; sammelt (token, payload, badge) je Aufruf."""
    import dcc_chat_gateway.fcm as fcm_mod

    sent: list[tuple[str, dict, int | None]] = []

    def _fake_send(*, token: str, payload: dict, badge: int | None = None) -> str:
        sent.append((token, payload, badge))
        return "ok"

    monkeypatch.setattr(fcm_mod, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm_mod, "_send_one", _fake_send)
    return sent


async def test_jeder_empfaenger_bekommt_seine_eigene_zahl(
    app, client, session_factory, _fcm_sender
):
    """Zwei Empfänger, zwei Stände — die Nutzlast ist gemeinsam, das Badge nicht."""
    import dcc_chat_gateway.fcm as fcm_mod

    r = app.state.redis
    await badgezaehler.setzen(r, 8001, 0)
    await badgezaehler.setzen(r, 8002, 4)
    async with session_factory() as s:
        s.add(FcmToken(user_id=8001, geraet_id="g1", token="tok-8001"))
        s.add(FcmToken(user_id=8002, geraet_id="g1", token="tok-8002"))
        await s.commit()

    n = await fcm_mod.fan_out_fcm_dm_push(
        recipient_ids={8001, 8002},
        author_name="Anna",
        channel_id=42,
        manager=_ManagerStub(r),
    )
    assert n == 2
    nach_token = {tok: badge for tok, _payload, badge in _fcm_sender}
    assert nach_token == {"tok-8001": 1, "tok-8002": 5}


async def test_zwei_geraete_eines_kontos_tragen_denselben_stand(
    app, client, session_factory, _fcm_sender
):
    """Der Zähler hängt am KONTO, nicht am Gerät — sonst zählte ein zweites
    Gerät die Zahl des Kontos ein zweites Mal hoch."""
    import dcc_chat_gateway.fcm as fcm_mod

    r = app.state.redis
    await badgezaehler.setzen(r, 8003, 0)
    async with session_factory() as s:
        s.add(FcmToken(user_id=8003, geraet_id="handy", token="tok-handy"))
        s.add(FcmToken(user_id=8003, geraet_id="tablet", token="tok-tablet"))
        await s.commit()

    await fcm_mod.fan_out_fcm_dm_push(
        recipient_ids={8003},
        author_name="Anna",
        channel_id=42,
        manager=_ManagerStub(r),
    )
    badges = {badge for _t, _p, badge in _fcm_sender}
    assert badges == {1}
    assert await badgezaehler.lesen(r, 8003) == 1


async def test_ohne_manager_kein_badge_aber_push(
    app, client, session_factory, _fcm_sender
):
    """Pfadlose Aufrufe (Tests, Altpfade) haben kein Redis — dann reist die
    Nachricht OHNE Zahl, statt eine falsche zu behaupten."""
    import dcc_chat_gateway.fcm as fcm_mod

    async with session_factory() as s:
        s.add(FcmToken(user_id=8004, geraet_id="g1", token="tok-8004"))
        await s.commit()
    n = await fcm_mod.fan_out_fcm_dm_push(
        recipient_ids={8004}, author_name="Anna", channel_id=42
    )
    assert n == 1
    assert _fcm_sender[0][2] is None


async def test_klient_meldet_seinen_stand(app, client, _auth_signer):
    """POST /fcm/badge überschreibt die Fortschreibung."""
    uid = 8101
    token = _auth_signer.issue_access(uid, "u8101")
    await badgezaehler.erhoehen(app.state.redis, uid)
    await badgezaehler.erhoehen(app.state.redis, uid)

    rr = await client.post("/fcm/badge", json={"anzahl": 3}, headers=_auth(token))
    assert rr.status_code == 204
    assert await badgezaehler.lesen(app.state.redis, uid) == 3

    # 0 ist eine Aussage: alles gelesen → Plakette weg.
    rr = await client.post("/fcm/badge", json={"anzahl": 0}, headers=_auth(token))
    assert rr.status_code == 204
    assert await badgezaehler.lesen(app.state.redis, uid) == 0


async def test_negative_zahl_wird_abgewiesen(app, client, _auth_signer):
    token = _auth_signer.issue_access(8102, "u8102")
    rr = await client.post("/fcm/badge", json={"anzahl": -1}, headers=_auth(token))
    assert rr.status_code == 422


async def test_badge_melden_braucht_anmeldung(app, client):
    rr = await client.post("/fcm/badge", json={"anzahl": 1})
    assert rr.status_code == 401
