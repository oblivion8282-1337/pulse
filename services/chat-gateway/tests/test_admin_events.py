"""``admin:events`` — Zustellung ausschließlich an Admin-Sockets.

Der Kanal trägt Admin-Benachrichtigungen (neue Self-Host-/App-Hosting-Anträge)
von auth-svc herüber. Der Handler darf sie NUR an Sockets mit ``is_admin``
zustellen: schon die Existenz eines Antrags ist eine Admin-Information.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

import pytest
from dcc_chat_gateway.pubsub_channel_handlers import handle_admin_events
from dcc_chat_gateway.pubsub_channels import ADMIN_EVENTS_CHANNEL


@dataclass
class _User:
    id: int
    is_admin: bool


class _StubManager:
    """Nur die vom Handler berührte Oberfläche der ConnectionManager."""

    def __init__(self, users: dict[str, _User]) -> None:
        self._lock = asyncio.Lock()
        self._ws_user = users
        self.sent: list[tuple[list[str], dict]] = []

    def _decode_payload(self, data, _label):
        return json.loads(data) if isinstance(data, (str, bytes)) else data

    async def _fan_out(self, targets, envelope):
        self.sent.append((list(targets), envelope))


def _msg(payload: dict) -> dict:
    return {"type": "message", "channel": ADMIN_EVENTS_CHANNEL, "data": json.dumps(payload)}


@pytest.mark.asyncio
async def test_only_admin_sockets_receive_the_event():
    manager = _StubManager(
        {
            "ws_admin": _User(id=1, is_admin=True),
            "ws_normal": _User(id=2, is_admin=False),
            "ws_admin2": _User(id=3, is_admin=True),
        }
    )
    payload = {"op": "admin_application_pending", "kind": "app_host"}

    await handle_admin_events(manager, ADMIN_EVENTS_CHANNEL, _msg(payload))

    assert len(manager.sent) == 1
    targets, envelope = manager.sent[0]
    assert sorted(targets) == ["ws_admin", "ws_admin2"]
    assert envelope == payload


@pytest.mark.asyncio
async def test_no_admin_connected_is_a_silent_noop():
    manager = _StubManager({"ws_normal": _User(id=2, is_admin=False)})

    await handle_admin_events(
        manager, ADMIN_EVENTS_CHANNEL, _msg({"op": "admin_application_pending", "kind": "instance"})
    )

    assert manager.sent == [([], {"op": "admin_application_pending", "kind": "instance"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"kind": "app_host"}, "kaputt", ["nope"]])
async def test_malformed_event_is_skipped_not_raised(payload):
    """Ein defektes Ereignis darf den Listener nicht mitreißen (er bedient alle Kanäle)."""
    manager = _StubManager({"ws_admin": _User(id=1, is_admin=True)})

    await handle_admin_events(manager, ADMIN_EVENTS_CHANNEL, _msg(payload))

    assert manager.sent == []
