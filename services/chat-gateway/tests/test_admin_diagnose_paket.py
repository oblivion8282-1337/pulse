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
    # Credentials unterjubeln: die Whitelist darf sie NICHT durchlassen.
    monkeypatch.setenv("PULSE_CLOUD_CLIENT_SECRET", "ganz-geheim")
    monkeypatch.setenv("PULSE_HOSTNAME", "pulse.example.de")

    r = await client.get(
        "/admin/self-host/diagnose-paket",
        headers={"Authorization": f"Bearer {admin_token[0]}"},
    )
    assert r.status_code == 200, r.text
    paket = r.json()

    for block in (
        "kopf", "setup_status", "abstuerze", "backups", "konfiguration", "cloud", "bootstrap_logs"
    ):
        assert block in paket, block
    assert paket["setup_status"][-1] == "1789925139\tfertig\tok"
    assert paket["kopf"]["hostname"] == "pulse.example.de"
    # Whitelist-Disziplin (Spec §8): Geheimnisse verlassen den Server nicht.
    assert "ganz-geheim" not in r.text
    assert "client_secret" not in paket["konfiguration"]
    # Cloud-Check ist live: httpx trifft im Test auf ein
    # nicht-antwortendes Ziel — egal wie es ausgeht, das Feld muss da sein.
    assert isinstance(paket["cloud"], dict)


def test_bootstrap_log_redaktion_password_zeilen():
    """Bughunt P2 (Spec §8): pg-Logs können im Fehlerfall SQL-Statements mit
    dem Klartext-DB-Passwort enthalten (`ALTER ROLE … PASSWORD '…'`). JEDE
    Zeile mit 'password' fliegt raus — konservativ, hart, getestet."""
    from dcc_chat_gateway.routes.admin_diagnose_paket import _redigiere_bootstrap_log

    roh = "\n".join(
        [
            "2026-09-21 12:00:00 UTC LOG:  database system is ready to accept connections",
            "2026-09-21 12:00:01 UTC ERROR:  syntax error at or near \"PASSWORD\"",
            "2026-09-21 12:00:01 UTC STATEMENT:  ALTER ROLE pulse WITH PASSWORD 'ganz-geheim-1234';",
            "2026-09-21 12:00:02 UTC LOG:  autovacuum launcher started",
        ]
    )
    redigiert = _redigiere_bootstrap_log(roh)
    assert "ganz-geheim-1234" not in redigiert
    assert "PASSWORD" not in redigiert
    assert "autovacuum launcher started" in redigiert
    assert "ready to accept connections" in redigiert
