"""Tests für die Health-Endpoints.

Abgedeckt:
- GET /health 200 wenn alles OK
- GET /health 503 wenn Redis nicht antwortet
- GET /health 200 "warming_up" wenn JWKS noch nicht ready (kein Hard-Fail —
  der Service ist alive, nur der Cache fehlt)
- GET /internal/health-probe 401 ohne Secret
- GET /internal/health-probe 401 mit falschem Secret
- GET /internal/health-probe 200 mit korrektem Secret
- GET /internal/health-probe 200 enthält erwartete Felder
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


# ---------------------------------------------------------------------------
# Hilfsfunktionen
# ---------------------------------------------------------------------------


def _secret_settings_override(secret: str = "test-secret"):
    """Gibt Settings-Override zurück der INTERNAL_SERVICE_SECRET setzt."""
    import dcc_chat_gateway.config as cfg

    original = cfg.get_settings

    class _Patched:
        def __init__(self):
            self._base = original()

        def __getattr__(self, name):
            if name == "internal_service_secret":
                return secret
            return getattr(self._base, name)

    patched = _Patched()

    def _provider():
        return patched  # type: ignore[return-value]

    return original, _provider


# ---------------------------------------------------------------------------
# GET /health — öffentlich
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health_ok(client):
    """200 wenn DB + Redis + JWKS alle OK sind."""
    # Im Test-Modus (skip_redis=True) returnt _check_redis True ohne echten Ping.
    # DB läuft auf SQLite in-memory — SELECT 1 sollte klappen.
    r = await client.get("/health")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_health_redis_down(client, app):
    """503 degraded wenn Redis nicht antwortet."""
    # Redis-Ping wirft Exception → _check_redis False.
    mock_redis = AsyncMock()
    mock_redis.ping.side_effect = ConnectionError("Redis unreachable")
    app.state.redis = mock_redis

    r = await client.get("/health")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "degraded"
    assert "redis" in body["failed"]


@pytest.mark.asyncio
async def test_health_jwks_not_ready(client, app):
    """200 warming_up wenn jwks_ready=False (Cold-Start, kein Hard-Fail)."""
    original_jwks_ready = getattr(app.state, "jwks_ready", True)
    app.state.jwks_ready = False
    try:
        r = await client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "warming_up"
        assert "jwks" in body["warming"]
    finally:
        app.state.jwks_ready = original_jwks_ready


@pytest.mark.asyncio
async def test_health_db_down(client):
    """503 degraded wenn DB-Check fehlschlägt."""
    with patch(
        "dcc_chat_gateway.routes.health._check_db",
        new_callable=AsyncMock,
        return_value=False,
    ):
        r = await client.get("/health")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "degraded"
    assert "db" in body["failed"]


# ---------------------------------------------------------------------------
# GET /internal/health-probe — JWT-validiert
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health_probe_no_secret(client):
    """401 ohne X-Pulse-Internal-Secret-Header."""
    import dcc_chat_gateway.config as cfg

    original, patched_provider = _secret_settings_override("test-secret")
    cfg.get_settings = patched_provider  # type: ignore[assignment]
    try:
        r = await client.get("/internal/health-probe")
        assert r.status_code == 401
    finally:
        cfg.get_settings = original  # type: ignore[assignment]


@pytest.mark.asyncio
async def test_health_probe_wrong_secret(client):
    """401 mit falschem Secret."""
    import dcc_chat_gateway.config as cfg

    original, patched_provider = _secret_settings_override("correct-secret")
    cfg.get_settings = patched_provider  # type: ignore[assignment]
    try:
        r = await client.get(
            "/internal/health-probe",
            headers={"X-Pulse-Internal-Secret": "wrong-secret"},
        )
        assert r.status_code == 401
    finally:
        cfg.get_settings = original  # type: ignore[assignment]


@pytest.mark.asyncio
async def test_health_probe_disabled_when_no_secret_configured(client):
    """401 wenn INTERNAL_SERVICE_SECRET nicht konfiguriert (leer)."""
    import dcc_chat_gateway.config as cfg

    original, patched_provider = _secret_settings_override("")
    cfg.get_settings = patched_provider  # type: ignore[assignment]
    try:
        r = await client.get(
            "/internal/health-probe",
            headers={"X-Pulse-Internal-Secret": "any-value"},
        )
        assert r.status_code == 401
    finally:
        cfg.get_settings = original  # type: ignore[assignment]


@pytest.mark.asyncio
async def test_health_probe_ok(client):
    """200 mit korrektem Secret + erwartete Felder im Response."""
    import dcc_chat_gateway.config as cfg

    original, patched_provider = _secret_settings_override("test-secret")
    cfg.get_settings = patched_provider  # type: ignore[assignment]
    try:
        r = await client.get(
            "/internal/health-probe",
            headers={"X-Pulse-Internal-Secret": "test-secret"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] in ("ok", "degraded")
        assert "services" in body
        assert "db" in body["services"]
        assert "redis" in body["services"]
        assert "jwks" in body["services"]
        assert "version" in body
        assert "jwks_status" in body
        assert "disk_usage" in body  # kann None sein wenn /data nicht existiert
        assert "disk_warning" in body
        assert "instance_mode" in body
    finally:
        cfg.get_settings = original  # type: ignore[assignment]
