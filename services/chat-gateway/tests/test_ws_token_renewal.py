"""Token-Austausch am offenen Socket (``token_refresh``).

Warum das geprueft wird: der Socket starb frueher am ``exp`` seines Tokens,
und weil ein Verbindungsabbau sofort ``presence_update(online=False)`` meldet,
flackerte jeder Nutzer im Token-Takt aus den Listen der anderen. Der Austausch
haelt den Socket am Leben — und darf dabei die Eintrittspruefung nicht
aufweichen (fremdes Token, geaenderte Rechte-Claims: Ablehnung).

Die Gegenprobe (``test_socket_stirbt_ohne_erneuerung``) gehoert dazu: ohne sie
wuerde ein Test, der den Socket nur laenger leben sieht, auch dann gruen sein,
wenn der Wecker gar nicht mehr gestellt wird.
"""

from __future__ import annotations

import asyncio
import random
import time

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# Lebensdauer des kurzlebigen Tokens in den Ablauf-Tests. Muss ueber der Zeit
# liegen, die Verbindungsaufbau + ready brauchen, und darunter, was der
# pytest-Timeout (30 s) traegt.
KURZ_S = 3


def _token_mit_exp(signer, uid: int, *, lebensdauer_s: int, admin: bool = False) -> str:
    """Access-Token mit frei gewaehlter Lebensdauer.

    ``issue_access`` nimmt die TTL aus den Settings — fuer die Ablauf-Tests
    brauchen wir eine kurze, ohne die globale Einstellung zu verbiegen (die
    haengt an einer prozessweiten Settings-Instanz und wuerde in andere Tests
    lecken).
    """
    now = int(time.time())
    payload = {
        "iss": signer._settings.jwt_issuer,
        "aud": signer._settings.jwt_audience,
        "sub": str(uid),
        "username": f"u{uid}",
        "iat": now,
        "exp": now + lebensdauer_s,
        "typ": "access",
    }
    if admin:
        payload["admin"] = True
    return signer._sign(payload)


@pytest.mark.asyncio
async def test_hello_kuendigt_token_refresh_an(ws_app, _auth_signer):
    """Der Klient nutzt den Austausch nur, wenn der Server ihn ansagt."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                hello = ws.receive_json()
                assert hello["op"] == "hello"
                assert "token_refresh" in hello["capabilities"]
                # Der Klient entscheidet ueber die Faehigkeit, nicht ueber die
                # Version: Die Web-App kommt von der Cloud und ist fuer alle
                # sofort neu, ein Self-Host aktualisiert sich wann er will. Eine
                # neue App trifft also wochenlang auf alte Server.
                assert "server-ticket" in hello["capabilities"]

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_socket_ueberlebt_ablauf_nach_erneuerung(ws_app, _auth_signer):
    """Frisches Token vor dem Ablauf → der Socket bleibt bestehen."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            kurz = _token_mit_exp(_auth_signer, uid, lebensdauer_s=KURZ_S)
            with tc.websocket_connect(f"/ws?token={kurz}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # ready
                frisch = _auth_signer.issue_access(uid, f"u{uid}")
                ws.send_json({"op": "token_refresh", "token": frisch})
                antwort = ws.receive_json()
                assert antwort["op"] == "token_renewed"
                assert antwort["exp"] > time.time()
                # Ueber den alten Ablauf hinaus warten und nachfassen.
                time.sleep(KURZ_S + 1)
                ws.send_json({"op": "ping"})
                assert ws.receive_json() == {"op": "pong"}

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_socket_stirbt_ohne_erneuerung(ws_app, _auth_signer):
    """Gegenprobe: ohne Austausch schliesst der Ablauf den Socket wie bisher."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            kurz = _token_mit_exp(_auth_signer, uid, lebensdauer_s=KURZ_S)
            with tc.websocket_connect(f"/ws?token={kurz}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # ready
                with pytest.raises(WebSocketDisconnect) as exc:
                    while True:
                        ws.receive_json()
                assert exc.value.code == 4001

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_fremdes_token_wird_abgelehnt(ws_app, _auth_signer):
    """Ein gueltiges Token eines ANDEREN Nutzers verlaengert nichts."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            fremd = uid + 1
            token = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # ready
                ws.send_json(
                    {
                        "op": "token_refresh",
                        "token": _auth_signer.issue_access(fremd, f"u{fremd}"),
                    }
                )
                antwort = ws.receive_json()
                assert antwort["op"] == "error"
                assert antwort["code"] == 4015

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_geaenderte_rechte_werden_abgelehnt(ws_app, _auth_signer):
    """Ein Token mit anderem ``admin``-Claim erneuert nicht.

    Der Claim haengt pro Socket im Sichtbarkeitsfilter. Wuerde die Erneuerung
    ihn stillschweigend uebernehmen (oder ignorieren), lebte ein entzogener
    Admin-Status unbegrenzt weiter, statt hoechstens eine Token-Lebensdauer.
    """

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")  # kein admin
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # ready
                ws.send_json(
                    {
                        "op": "token_refresh",
                        "token": _token_mit_exp(
                            _auth_signer, uid, lebensdauer_s=900, admin=True
                        ),
                    }
                )
                antwort = ws.receive_json()
                assert antwort["op"] == "error"
                assert antwort["code"] == 4015

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_abgelaufenes_token_wird_abgelehnt(ws_app, _auth_signer):
    """Ein bereits abgelaufenes Token ist keine Verlaengerung."""

    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            token = _auth_signer.issue_access(uid, f"u{uid}")
            with tc.websocket_connect(f"/ws?token={token}") as ws:
                ws.receive_json()  # hello
                ws.receive_json()  # ready
                ws.send_json(
                    {
                        "op": "token_refresh",
                        "token": _token_mit_exp(_auth_signer, uid, lebensdauer_s=-10),
                    }
                )
                antwort = ws.receive_json()
                assert antwort["op"] == "error"
                assert antwort["code"] == 4015

    await asyncio.to_thread(_run)
