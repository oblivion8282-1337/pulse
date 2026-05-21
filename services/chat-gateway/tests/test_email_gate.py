"""chat-gateway side of the email-verification gate (Phase 2).

A token carrying ``email_blocked`` — auth-svc stamps it on unverified
accounts once SMTP is configured — is rejected everywhere: REST routes
return 403, the WS endpoint closes with the distinct code 4003 (so the
client can route to the "verify your email" screen).
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_rest_rejects_email_blocked_token(client, _auth_signer):
    uid = random.randint(1, 1_000_000)
    blocked = _auth_signer.issue_access(uid, f"u{uid}", email_blocked=True)
    r = await client.post("/guilds", json={"name": "g"}, headers=_auth(blocked))
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "email verification required"


@pytest.mark.asyncio
async def test_rest_allows_token_without_claim(client, _auth_signer):
    """Sanity: a token without the claim still works — the gate must not
    over-reach onto verified / gate-off accounts."""
    uid = random.randint(1, 1_000_000)
    ok = _auth_signer.issue_access(uid, f"u{uid}")
    r = await client.post("/guilds", json={"name": "g"}, headers=_auth(ok))
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_ws_rejects_email_blocked_token(ws_app, _auth_signer):
    def _run():
        uid = random.randint(1, 1_000_000)
        blocked = _auth_signer.issue_access(uid, f"u{uid}", email_blocked=True)
        with TestClient(ws_app) as tc:
            with pytest.raises(WebSocketDisconnect) as exc:
                with tc.websocket_connect(f"/ws?token={blocked}") as ws:
                    ws.receive_text()
            assert exc.value.code == 4003

    await asyncio.to_thread(_run)
