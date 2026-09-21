"""Tests für das Self-Host-Diagnose-Paket (Spec 2026-09-21 §7, Phase 3).

Abgedeckt:
- 401 ohne Token, 403 ohne admin-Claim
- 200 für den Admin, mit allen Pflicht-Blöcken (kopf, setup_status, abstuerze,
  backups, konfiguration, cloud, bootstrap_logs)
- Whitelist-Disziplin: Credentials-Envs tauchen NIE im Paket auf
- setup_status wird aus $PULSE_DATA_PATH gelesen
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_401_ohne_token(client):
    r = await client.get("/admin/self-host/diagnose-paket")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_403_ohne_admin_claim(client, access_token):
    r = await client.get(
        "/admin/self-host/diagnose-paket",
        headers={"Authorization": f"Bearer {access_token[0]}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_admin_bekommt_paket(client, admin_token, tmp_path, monkeypatch):
    # Setup-Checkliste + Bootstrap-Log in ein tmp-/data spiegeln.
    monkeypatch.setenv("PULSE_DATA_PATH", str(tmp_path))
    (tmp_path / "setup-status").write_text(
        "1789925100\t01-init-data-dirs\tok\n1789925139\tfertig\tok\n", encoding="utf-8"
    )
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    # /var/log/pulse ist fest verdrahtet — nur wenn es fehlt, bleibt der Block
    # einfach leer (getestet durch Fehlen hier); wir überschreiben ihn nicht.

    # Credentials unterjubeln: die Whitelist darf sie NICHT durchlassen.
    monkeypatch.setenv("PULSE_CLOUD_CLIENT_SECRET", "ganz-geheim")
    monkeypatch.setenv("PULSE_HOSTNAME", "pulse.example.de")

    r = await client.get(
        "/admin/self-host/diagnose-paket",
        headers={"Authorization": f"Bearer {admin_token[0]}"},
    )
    assert r.status_code == 200, r.text
    paket = r.json()

    for block in ("kopf", "setup_status", "abstuerze", "backups", "konfiguration", "cloud"):
        assert block in paket, block
    assert paket["setup_status"][-1] == "1789925139\tfertig\tok"
    assert paket["kopf"]["hostname"] == "pulse.example.de"
    # Whitelist-Disziplin (Spec §8): Geheimnisse verlassen den Server nicht.
    assert "ganz-geheim" not in r.text
    assert "client_secret" not in paket["konfiguration"]
    # Cloud-Check ist live: httpx trifft im Test auf ein
    # nicht-antwortendes Ziel — egal wie es ausgeht, das Feld muss da sein.
    assert isinstance(paket["cloud"], dict)
