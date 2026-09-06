"""``POST /internal/streams/kill-sessions`` — MediaMTX-Sessions hart trennen.

Ein Rausgeworfener Gast verliert seine Lese-Token in Redis, aber eine
bereits etablierte WHEP-Session prüft das Token nur beim Handshake. Dieser
Endpunkt (aufgerufen aus chat-gateway und voice-signaling) löscht die
Session-Aufzeichnungen bei MediaMTX — hier gegen einen gefakten API-Server.

Geprüft: Secret-Guard (401/503), delimiter-genauer Token-Match (kein
Präfix-Fehltreffer), best-effort bei MediaMTX-Ausfall (204 statt 500).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import pytest_asyncio

_SECRET = "test-internal-secret"


def _auth() -> dict[str, str]:
    return {"X-Pulse-Internal-Secret": _SECRET}


class _FakeMediaMtx:
    """Mini-MediaMTX: listet Sessions, zählt Deletes, kann auch ausfallen."""

    def __init__(self, sessions: list[dict[str, Any]], *, kaputt: bool = False):
        self.sessions = sessions
        self.kaputt = kaputt
        self.deleted: list[str] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if self.kaputt:
            return httpx.Response(500, json={"error": "boom"})
        if request.url.path.endswith("/whepsessions") and request.method == "GET":
            return httpx.Response(200, json={"items": self.sessions, "totalCount": len(self.sessions)})
        if request.method == "DELETE" and "/whepsessions/" in request.url.path:
            sid = request.url.path.rsplit("/", 1)[-1]
            self.deleted.append(sid)
            return httpx.Response(204)
        return httpx.Response(404)


def _install(monkeypatch, app, holder: dict, fake: _FakeMediaMtx) -> None:
    """media-svc mit Fake-Transport und Settings verdrahten."""
    import httpx as _httpx

    from dcc_media_svc import routes as media_routes

    holder["fake"] = fake
    # Starlette-State erlaubt neue Attribute nur per direkter Zuweisung —
    # monkeypatch.setattr schlägt still fehl (raising=False).
    app.state.internal_service_secret = _SECRET

    class _FehlerClient:
        """Ersetzt den httpx.AsyncClient im Endpunkt."""

        def __init__(self, *a, **k) -> None:
            self._calls: list[Any] = []

        async def __aenter__(self) -> "_FehlerClient":
            return self

        async def __aexit__(self, *a) -> None:
            return False

        async def get(self, url: str, **k) -> httpx.Response:
            return await fake.handler(_httpx.Request("GET", url, params=k.get("params")))

        async def delete(self, url: str, **k) -> httpx.Response:
            return await fake.handler(_httpx.Request("DELETE", url))

    monkeypatch.setattr(httpx, "AsyncClient", _FehlerClient)


@pytest.mark.asyncio
async def test_kill_sessions_ohne_secret_ist_503(client):
    r = await client.post(
        "/internal/streams/kill-sessions", json={"tokens": ["x"]}
    )
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_kill_sessions_matcht_token_delimiter_genau(client, app, monkeypatch):
    """``token=abc`` darf nicht die Session des fremden Zuschauers mit
    ``token=abcdef`` mitlöschen."""
    fake = _FakeMediaMtx(
        [
            {"id": "s1", "query": "token=eins"},
            {"id": "s2", "query": "token=einszwei"},
            {"id": "s3", "query": "foo=1&token=eins"},
        ]
    )
    _install(monkeypatch, app, {}, fake)

    r = await client.post(
        "/internal/streams/kill-sessions",
        json={"tokens": ["eins"]},
        headers=_auth(),
    )
    assert r.status_code == 204
    assert fake.deleted == ["s1", "s3"]


@pytest.mark.asyncio
async def test_kill_sessions_mediamtx_ausfall_bleibt_204(client, app, monkeypatch):
    """Best-effort: MediaMTX down → kein 500 zum Aufrufer; der Reconnect
    bleibt als Rückfallebene."""
    fake = _FakeMediaMtx([], kaputt=True)
    _install(monkeypatch, app, {}, fake)

    r = await client.post(
        "/internal/streams/kill-sessions",
        json={"tokens": ["eins"]},
        headers=_auth(),
    )
    assert r.status_code == 204
