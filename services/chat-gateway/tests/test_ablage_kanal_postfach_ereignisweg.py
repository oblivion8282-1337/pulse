"""Der Ereignisweg eines Ablage-Kanals im Postfach (Etappe E6, Aufgabe 1).

Route und Ereignisweg werden getrennt geprueft — dieselbe Doppelung wie bei
den privaten Gruppen (``test_private_gruppen_ereignisweg.py``) und den
Standplatz-Geraeten (CLAUDE.md, „Der Kanal ist der Rechteanker … zweifach
geprueft — Route UND Ereignisweg").

**Warum hier kein eigener Filter noetig ist, anders als bei privaten
Gruppen**: ein Ablage-Kanal ist eine gewoehnliche Zeile in ``chat.channels``
(nur mit ``ablage=true``), keine eigene Tabelle. ``PostfachNeuEvent`` laeuft
ueber ``manager.publish(str(channel_id), …)`` -> Redis-Kanal
``chat:channel:<id>`` -> ``pubsub_channel_handlers.py::handle_chat_channel``
-> ``manager._filter_by_view_channel``. Dessen ``_resolve_channel_kind``
(``pubsub_perm_filter.py``) findet die Zeile in ``Channel`` und liefert
``ch.guild_id`` — denselben Zweig, den JEDER andere Guild-Kanal durchlaeuft
(``members_who_can_view``). Dieser Test belegt genau das am Code: ein
Nicht-Mitglied (keine ``GuildMember``-Zeile) bekommt den Weckruf nicht, ohne
dass ``_postfach_deps.py`` oder ``pubsub_perm_filter.py`` fuer Ablage-Kanaele
etwas Eigenes braucht.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from dcc_shared.events import PostfachNeuEvent
from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS

from dcc_chat_gateway.models import Channel, Guild, GuildMember, Role
from dcc_chat_gateway.security import AuthenticatedUser
from dcc_chat_gateway.snowflake import next_id

pytestmark = pytest.mark.usefixtures("cloud_mode")


class _FakeWS:
    """Stand-in fuer ``fastapi.WebSocket`` — wie in
    ``test_private_gruppen_ereignisweg.py``: ``send_text``, nicht
    ``send_json``, weil die Auffaecherung den Rahmen als Text verschickt."""

    def __init__(self, name: str = "ws") -> None:
        self.name = name
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    def __repr__(self) -> str:  # pragma: no cover — nur zur Fehlersuche
        return f"<_FakeWS {self.name}>"


async def _seed_guild_mit_ablage_kanal(
    session_factory, owner_id: int, *weitere_mitglieder: int
) -> tuple[int, int]:
    """Legt eine Community mit einem Ablage-Kanal an; ``owner_id`` plus
    ``weitere_mitglieder`` werden als ``GuildMember`` eingetragen (mit der
    @everyone-Rolle, die per Vorgabe VIEW_CHANNEL traegt) — wer NICHT in
    dieser Liste steht, bleibt Nicht-Mitglied und damit ausserhalb der
    ``members_who_can_view``-Menge."""
    gid = next_id()
    cid = next_id()
    async with session_factory() as s:
        s.add(Guild(id=gid, name="g", owner_id=owner_id))
        await s.flush()
        s.add(
            Role(
                id=next_id(),
                guild_id=gid,
                name="@everyone",
                permissions=DEFAULT_EVERYONE_PERMISSIONS,
                position=0,
                is_everyone=True,
            )
        )
        for uid in (owner_id, *weitere_mitglieder):
            s.add(GuildMember(guild_id=gid, user_id=uid))
        s.add(Channel(id=cid, guild_id=gid, name="ablage-raum", type=0, position=0, ablage=True))
        await s.commit()
    return gid, cid


async def _socket_an(manager, name: str, user_id: int, channel_id: int) -> _FakeWS:
    """Ein angemeldeter Socket, der den Kanal abonniert hat — am
    ``subscribe``-Op vorbei, direkt ueber den Manager, damit hier
    ausschliesslich der Ereignisweg geprueft wird (nicht die Route)."""
    ws = _FakeWS(name)
    user = AuthenticatedUser(id=user_id, username=f"u{user_id}", is_admin=False, payload={})
    ok, _ = await manager.register(ws, user)  # type: ignore[arg-type]
    assert ok, "register sollte unterhalb der Verbindungsgrenze gelingen"
    await manager.subscribe(ws, str(channel_id))
    return ws


async def _warte_auf_zustellung(sockets: list[_FakeWS], sekunden: float = 3.0) -> None:
    frist = asyncio.get_running_loop().time() + sekunden
    while asyncio.get_running_loop().time() < frist:
        if all(ws.sent for ws in sockets):
            return
        await asyncio.sleep(0.02)


async def _weckruf(manager, channel_id: int) -> None:
    await manager.publish(
        str(channel_id), PostfachNeuEvent(channel_id=str(channel_id), anzahl=1)
    )


@pytest.mark.asyncio
async def test_weckruf_erreicht_das_mitglied(app, session_factory):
    manager = app.state.connection_manager
    uid_a, uid_b = next_id(), next_id()
    _, cid = await _seed_guild_mit_ablage_kanal(session_factory, uid_a, uid_b)

    ws_a = await _socket_an(manager, "a", uid_a, cid)
    ws_b = await _socket_an(manager, "b", uid_b, cid)

    await _weckruf(manager, cid)
    await _warte_auf_zustellung([ws_a, ws_b])

    assert [m["op"] for m in ws_a.sent] == ["postfach_neu"]
    assert [m["op"] for m in ws_b.sent] == ["postfach_neu"]
    assert ws_b.sent[0]["channel_id"] == str(cid)


@pytest.mark.asyncio
async def test_weckruf_erreicht_kein_nichtmitglied(app, session_factory):
    """Der wichtigste Test dieser Datei: der Abonnenten-Satz allein ist kein
    Beleg (er wird an anderer Stelle gefuellt) — der Filter muss selbst
    pruefen. Der Fremde steht deshalb bewusst TROTZDEM im Abonnenten-Satz
    (ueber den Manager, an der Route vorbei), damit allein
    ``_filter_by_view_channel`` ihn heraushaelt."""
    manager = app.state.connection_manager
    uid_a, uid_fremd = next_id(), next_id()
    _, cid = await _seed_guild_mit_ablage_kanal(session_factory, uid_a)

    ws_a = await _socket_an(manager, "a", uid_a, cid)
    ws_fremd = await _socket_an(manager, "fremd", uid_fremd, cid)

    await _weckruf(manager, cid)
    await _warte_auf_zustellung([ws_a])

    assert [m["op"] for m in ws_a.sent] == ["postfach_neu"]
    assert ws_fremd.sent == []
