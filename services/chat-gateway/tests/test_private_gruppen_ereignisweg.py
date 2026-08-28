"""Der Ereignisweg einer privaten Gruppe (Etappe G, Task 3).

Warum eine eigene Datei: ``test_private_gruppen.py`` deckt Modelle und Routen
(G1) und ist bereits nahe an der Groessen-Policy. Hier geht es um die zweite
Pruefstelle — den Weg, auf dem ein Weckruf zu den offenen Sockets faechert.

**Warum das ueberhaupt zweimal geprueft wird.** Dieselbe Doppelung wie bei den
Standplatz-Geraeten (CLAUDE.md, „Der Kanal ist der Rechteanker … zweifach
geprueft — Route UND Ereignisweg"): die Route entscheidet, wer einliefern
darf, der Ereignisweg entscheidet, wer es zu sehen bekommt. Wer nur die Route
prueft, laesst ein entferntes Mitglied weiter mitlesen, solange sein Socket
offen ist — und genau so lange dauert eine Sitzung.

Die Sockets sind Attrappen (``_FakeWS``, wie ``test_pubsub_invalidate.py``):
geprueft wird der Filter und die Auffaecherung, nicht das WebSocket-Protokoll.
Der Weg ist trotzdem der echte — ``manager.publish`` geht durch Redis, den
``_listen``-Lauf und ``handle_chat_channel``.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from dcc_shared.events import PostfachNeuEvent

from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.snowflake import next_id

pytestmark = pytest.mark.usefixtures("cloud_mode")


class _FakeWS:
    """Stand-in fuer ``fastapi.WebSocket`` — der Manager braucht eine hashbare
    Identitaet und ``send_text``.

    **``send_text``, nicht ``send_json``**: die Auffaecherung kodiert den
    Rahmen genau einmal und schickt ihn als Text (``pubsub_listener.py::
    _fan_out``). Eine Attrappe mit nur ``send_json`` bekommt deshalb nie
    etwas — und zwar lautlos, weil ``_send`` jede Ausnahme abfaengt und den
    Socket still entfernt. ``test_pubsub_invalidate.py`` kommt ohne aus, weil
    es nur den Filter aufruft, nie die Auffaecherung."""

    def __init__(self, name: str = "ws") -> None:
        self.name = name
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    def __repr__(self) -> str:  # pragma: no cover — nur zur Fehlersuche
        return f"<_FakeWS {self.name}>"


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    """Schaltet ``private_groups_enabled`` fuer die Dauer eines Tests ein —
    dieselbe Fixture wie in ``test_private_gruppen.py``, Vorgabe ist AUS."""
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


async def _socket_an(manager, name: str, user_id: int, gruppe_id: int) -> _FakeWS:
    """Ein angemeldeter Socket, der den Gruppenkanal abonniert hat.

    Abonniert wird bewusst am ``subscribe``-Op vorbei, direkt ueber den
    Manager: geprueft werden soll hier der Ereignisweg, nicht die Route — ein
    Socket kommt also auch dann in den Satz, wenn er dort nichts zu suchen
    hat."""
    ws = _FakeWS(name)
    user = AuthenticatedUser(id=user_id, username=f"u{user_id}", is_admin=False, payload={})
    ok, _ = await manager.register(ws, user)  # type: ignore[arg-type]
    assert ok, "register sollte unterhalb der Verbindungsgrenze gelingen"
    await manager.subscribe(ws, str(gruppe_id))
    return ws


async def _gruppe_anlegen(session_factory, ersteller_id: int, *mitglieder: int) -> int:
    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember

    gid = next_id()
    async with session_factory() as s:
        s.add(
            PrivateGroupChannel(
                id=gid, ersteller_id=ersteller_id, erstellt_von_id=ersteller_id, name="g"
            )
        )
        await s.flush()
        for uid in (ersteller_id, *mitglieder):
            s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=uid))
        await s.commit()
    return gid


async def _mitglied_entfernen(session_factory, gruppe_id: int, user_id: int) -> None:
    from sqlalchemy import delete

    from dcc_chat_gateway.models import PrivateGroupMember

    async with session_factory() as s:
        await s.execute(
            delete(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == user_id,
            )
        )
        await s.commit()


async def _warte_auf_zustellung(sockets: list[_FakeWS], sekunden: float = 3.0) -> None:
    """Wartet, bis JEDER genannte Socket etwas bekommen hat — oder die Zeit
    ablaeuft. Der Weg fuehrt ueber einen echten Redis und den
    ``_listen``-Lauf, ist also asynchron zum Test."""
    frist = asyncio.get_running_loop().time() + sekunden
    while asyncio.get_running_loop().time() < frist:
        if all(ws.sent for ws in sockets):
            return
        await asyncio.sleep(0.02)


async def _weckruf(manager, gruppe_id: int) -> None:
    await manager.publish(
        str(gruppe_id), PostfachNeuEvent(channel_id=str(gruppe_id), anzahl=1)
    )


@pytest.mark.asyncio
async def test_weckruf_erreicht_das_mitglied(app, session_factory, gruppen_an):
    """Ohne diesen Weg merkt ein zweites, offenes Geraet nichts von einer
    Gruppennachricht — sie erscheint erst beim naechsten ``ready``, also nach
    einem Neuladen."""
    manager = app.state.connection_manager
    uid_a, uid_b = next_id(), next_id()
    gid = await _gruppe_anlegen(session_factory, uid_a, uid_b)

    ws_a = await _socket_an(manager, "a", uid_a, gid)
    ws_b = await _socket_an(manager, "b", uid_b, gid)

    await _weckruf(manager, gid)
    await _warte_auf_zustellung([ws_a, ws_b])

    assert [m["op"] for m in ws_a.sent] == ["postfach_neu"]
    assert [m["op"] for m in ws_b.sent] == ["postfach_neu"]
    assert ws_b.sent[0]["channel_id"] == str(gid)


@pytest.mark.asyncio
async def test_weckruf_erreicht_kein_nichtmitglied(app, session_factory, gruppen_an):
    """Der Ereignisweg muss selbst pruefen. Der Abonnent-Satz allein reicht
    nicht als Beleg: er wird an anderer Stelle gefuellt, und ein Fehler dort
    darf nicht bedeuten, dass ein Fremder mitliest."""
    manager = app.state.connection_manager
    uid_a, uid_fremd = next_id(), next_id()
    gid = await _gruppe_anlegen(session_factory, uid_a)

    ws_a = await _socket_an(manager, "a", uid_a, gid)
    # Der Fremde SOLL im Abonnenten-Satz stehen, damit allein der Filter ihn
    # heraushaelt — ueber die Route waere er gar nicht erst hineingekommen.
    ws_fremd = await _socket_an(manager, "fremd", uid_fremd, gid)

    await _weckruf(manager, gid)
    await _warte_auf_zustellung([ws_a])

    assert [m["op"] for m in ws_a.sent] == ["postfach_neu"]
    assert ws_fremd.sent == []


@pytest.mark.asyncio
async def test_entferntes_mitglied_bekommt_nichts_mehr(app, session_factory, gruppen_an):
    """Wer entfernt wurde, bekommt nichts mehr — auch nicht auf dem noch
    offenen Socket. Der zweite Weckruf ist der eigentliche Test; der erste
    belegt nur, dass der Socket vorher wirklich beliefert wurde (sonst waere
    das Schweigen danach keine Aussage)."""
    manager = app.state.connection_manager
    uid_a, uid_b = next_id(), next_id()
    gid = await _gruppe_anlegen(session_factory, uid_a, uid_b)

    ws_a = await _socket_an(manager, "a", uid_a, gid)
    ws_b = await _socket_an(manager, "b", uid_b, gid)

    await _weckruf(manager, gid)
    await _warte_auf_zustellung([ws_a, ws_b])
    assert len(ws_b.sent) == 1, "Vorbedingung: B bekommt als Mitglied den Weckruf"

    await _mitglied_entfernen(session_factory, gid, uid_b)
    ws_a.sent.clear()
    ws_b.sent.clear()

    await _weckruf(manager, gid)
    await _warte_auf_zustellung([ws_a])

    assert [m["op"] for m in ws_a.sent] == ["postfach_neu"]
    assert ws_b.sent == []


@pytest.mark.asyncio
async def test_abgeschalteter_schalter_stellt_nichts_zu(app, session_factory):
    """Ohne ``gruppen_an`` — der Schalter steht aus. Eine Bestandsgruppe darf
    dann auch auf dem Ereignisweg nichts mehr zustellen, sonst sperrte der
    Schalter nur die Verwaltung, nicht die Nutzung (dieselbe Regel wie in
    ``private_gruppen_zugriff.py``)."""
    manager = app.state.connection_manager
    uid_a, uid_b = next_id(), next_id()
    gid = await _gruppe_anlegen(session_factory, uid_a, uid_b)

    ws_a = await _socket_an(manager, "a", uid_a, gid)
    ws_b = await _socket_an(manager, "b", uid_b, gid)

    await _weckruf(manager, gid)
    # Nichts zu erwarten — kurz warten, damit ein Fehlverhalten Zeit haette,
    # sich zu zeigen.
    await asyncio.sleep(0.5)

    assert ws_a.sent == []
    assert ws_b.sent == []
