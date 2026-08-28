"""Abonnieren eines privaten Gruppenkanals ueber die WebSocket (Etappe G).

Die erste Haelfte des Rechteankers: die Route. Die zweite (der Ereignisweg)
steht in ``test_private_gruppen_ereignisweg.py`` — geprueft wird beides,
dieselbe Doppelung wie bei den Standplatz-Geraeten.

Ohne ein Abonnement erreicht der ``postfach_neu``-Weckruf den Klienten nie:
er faechert an ``_subs[<kanal_id>]`` auf (``pubsub_channel_handlers.py::
handle_chat_channel``), und in diesen Satz kommt ein Socket nur ueber die
``subscribe``-Op.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

from .conftest import receive_skipping

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def gruppen_an(_isolate_chat_settings):
    """Schaltet ``private_groups_enabled`` fuer die Dauer eines Tests ein —
    dieselbe Fixture wie in ``test_private_gruppen.py``, Vorgabe ist AUS."""
    _isolate_chat_settings.private_groups_enabled = True
    return _isolate_chat_settings


def _gruppe_anlegen_sync(tc: TestClient, signer) -> tuple[str, int, str, int, str]:
    """Zwei Konten, eine Gruppe mit beiden. Ueber die echten Routen, damit der
    Test nicht an einem selbst gebauten Datenstand vorbeiprueft."""
    uid_a = random.randint(1, 1_000_000)
    uid_b = random.randint(1, 1_000_000)
    t_a = signer.issue_access(uid_a, f"a{uid_a}")
    t_b = signer.issue_access(uid_b, f"b{uid_b}")
    r = tc.post("/gruppen", json={"name": "Testgruppe"}, headers=_auth(t_a))
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    r = tc.post(
        f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_b)}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text
    return t_a, uid_a, t_b, uid_b, gid


@pytest.mark.asyncio
async def test_mitglied_darf_gruppenkanal_abonnieren(ws_app, _auth_signer, gruppen_an):
    def _run():
        with TestClient(ws_app) as tc:
            _, _, t_b, _, gid = _gruppe_anlegen_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={t_b}") as ws:
                receive_skipping(ws)  # ready
                ws.send_json({"op": "subscribe", "channel_id": gid})
                # Ein Erfolg schickt nichts zurueck; ein zweites, sicher
                # fehlschlagendes Abonnement macht das Schweigen pruefbar
                # (dasselbe Muster wie ``test_dms_ws.py``).
                ws.send_json({"op": "subscribe", "channel_id": "keine-zahl"})
                antwort = ws.receive_json()
                assert antwort["op"] == "error"
                assert antwort["code"] == 4003

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_nichtmitglied_darf_nicht_abonnieren(ws_app, _auth_signer, gruppen_an):
    def _run():
        with TestClient(ws_app) as tc:
            _, _, _, _, gid = _gruppe_anlegen_sync(tc, _auth_signer)
            uid_fremd = random.randint(1, 1_000_000)
            t_fremd = _auth_signer.issue_access(uid_fremd, f"f{uid_fremd}")
            with tc.websocket_connect(f"/ws?token={t_fremd}") as ws:
                receive_skipping(ws)  # ready
                ws.send_json({"op": "subscribe", "channel_id": gid})
                antwort = ws.receive_json()
                assert antwort["op"] == "error"
                assert antwort["code"] == 4004

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_abgeschaltet_ist_der_gruppenkanal_unerreichbar(
    ws_app, _auth_signer, _isolate_chat_settings
):
    """Der Schalter (Vorgabe AUS) muss auch hier greifen: eine Bestandsgruppe
    darf bei abgeschaltetem Schalter nicht abonnierbar sein, sonst sperrte er
    nur die Verwaltung, nicht die Nutzung."""

    def _run():
        with TestClient(ws_app) as tc:
            # Anlegen braucht den Schalter — kurz an, danach wieder aus.
            _isolate_chat_settings.private_groups_enabled = True
            try:
                _, _, t_b, _, gid = _gruppe_anlegen_sync(tc, _auth_signer)
            finally:
                _isolate_chat_settings.private_groups_enabled = False
            with tc.websocket_connect(f"/ws?token={t_b}") as ws:
                receive_skipping(ws)  # ready
                ws.send_json({"op": "subscribe", "channel_id": gid})
                antwort = ws.receive_json()
                assert antwort["op"] == "error"
                assert antwort["code"] == 4004

    await asyncio.to_thread(_run)
