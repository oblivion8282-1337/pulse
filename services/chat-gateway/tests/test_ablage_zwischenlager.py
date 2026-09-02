"""Zwischenlager der Community-Dateiablage (Etappe E8, Aufgabe 2). S3 gemockt
wie in ``test_attachments.py`` — nur die DB-Seite (Kontingente, Rechte,
Quittierung, Alters-Sweep) wird hier real geprueft.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from dcc_chat_gateway import s3 as s3_mod
from dcc_chat_gateway.ablage_zwischenlager_pflege import sweep_alte_zwischenlager_dateien
from dcc_chat_gateway.models import AblageZwischenlagerDatei


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


class _S3Mock:
    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.put_calls: list[dict] = []

    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        self.put_calls.append(
            {"key": key, "content_type": content_type, "content_length": content_length}
        )
        return f"https://mock/{key}?put-sig"

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        return f"https://mock/{key}?get-sig"

    async def delete_object(self, key):
        self.deleted.append(key)


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    return m


async def _guild_mit_zwei_mitgliedern(client, _auth_signer):
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_mitglied, uid_mitglied = await _register_user(_auth_signer)

    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_mitglied)},
        headers=auth(t_owner),
    )
    return t_owner, uid_owner, t_mitglied, uid_mitglied, g["id"]


@pytest.mark.asyncio
async def test_mitglied_kuendigt_an_und_zweites_mitglied_laedt_herunter(
    client, _auth_signer, mock_s3
):
    t_owner, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)

    r = await client.post(
        f"/guilds/{gid}/ablage/zwischenlager", json={"groesse": 1234}, headers=auth(t_mitglied)
    )
    assert r.status_code == 201, r.text
    eintrag_id = r.json()["id"]
    assert r.json()["upload_url"].startswith("https://mock/")

    r = await client.get(f"/guilds/{gid}/ablage/zwischenlager", headers=auth(t_owner))
    assert r.status_code == 200
    liste = r.json()
    assert len(liste) == 1
    assert liste[0]["id"] == eintrag_id
    assert liste[0]["groesse"] == 1234
    # Kein Dateiname, kein MIME-Typ irgendwo in der Antwort.
    assert set(liste[0].keys()) == {"id", "groesse", "hochgeladen_von", "erstellt_am"}

    r = await client.get(
        f"/guilds/{gid}/ablage/zwischenlager/{eintrag_id}/download-url", headers=auth(t_owner)
    )
    assert r.status_code == 200
    assert r.json()["url"].startswith("https://mock/")


@pytest.mark.asyncio
async def test_datei_zu_gross_wird_abgewiesen(client, _auth_signer, mock_s3):
    from dcc_chat_gateway import config as chat_config

    einstellungen = chat_config.get_settings()
    alt = einstellungen.ablage_zwischenlager_max_datei_bytes
    einstellungen.ablage_zwischenlager_max_datei_bytes = 100
    try:
        _, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
        r = await client.post(
            f"/guilds/{gid}/ablage/zwischenlager",
            json={"groesse": 200},
            headers=auth(t_mitglied),
        )
        assert r.status_code == 413
    finally:
        einstellungen.ablage_zwischenlager_max_datei_bytes = alt


@pytest.mark.asyncio
async def test_gesamtkontingent_der_community_wird_durchgesetzt(client, _auth_signer, mock_s3):
    from dcc_chat_gateway import config as chat_config

    einstellungen = chat_config.get_settings()
    alt_datei = einstellungen.ablage_zwischenlager_max_datei_bytes
    alt_gesamt = einstellungen.ablage_zwischenlager_max_gesamt_bytes
    einstellungen.ablage_zwischenlager_max_datei_bytes = 1000
    einstellungen.ablage_zwischenlager_max_gesamt_bytes = 1500
    try:
        _, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
        r1 = await client.post(
            f"/guilds/{gid}/ablage/zwischenlager",
            json={"groesse": 1000},
            headers=auth(t_mitglied),
        )
        assert r1.status_code == 201
        r2 = await client.post(
            f"/guilds/{gid}/ablage/zwischenlager",
            json={"groesse": 600},
            headers=auth(t_mitglied),
        )
        assert r2.status_code == 413
    finally:
        einstellungen.ablage_zwischenlager_max_datei_bytes = alt_datei
        einstellungen.ablage_zwischenlager_max_gesamt_bytes = alt_gesamt


@pytest.mark.asyncio
async def test_nur_besitzer_darf_quittieren(client, _auth_signer, mock_s3):
    t_owner, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    r = await client.post(
        f"/guilds/{gid}/ablage/zwischenlager", json={"groesse": 10}, headers=auth(t_mitglied)
    )
    eintrag_id = r.json()["id"]

    r = await client.delete(
        f"/guilds/{gid}/ablage/zwischenlager/{eintrag_id}", headers=auth(t_mitglied)
    )
    assert r.status_code == 403

    r = await client.delete(
        f"/guilds/{gid}/ablage/zwischenlager/{eintrag_id}", headers=auth(t_owner)
    )
    assert r.status_code == 204
    assert mock_s3.deleted  # der Klumpen ist mitgegangen

    r = await client.get(f"/guilds/{gid}/ablage/zwischenlager", headers=auth(t_owner))
    assert r.json() == []


@pytest.mark.asyncio
async def test_alters_sweep_raeumt_und_entfernt_klumpen(
    client, _auth_signer, mock_s3, session_factory
):
    _, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    r = await client.post(
        f"/guilds/{gid}/ablage/zwischenlager", json={"groesse": 5}, headers=auth(t_mitglied)
    )
    eintrag_id = int(r.json()["id"])

    # Kuenstlich altern lassen.
    async with session_factory() as session:
        await session.execute(
            update(AblageZwischenlagerDatei)
            .where(AblageZwischenlagerDatei.id == eintrag_id)
            .values(created_at=datetime.now(UTC) - timedelta(days=10))
        )
        await session.commit()

    async with session_factory() as session:
        anzahl = await sweep_alte_zwischenlager_dateien(session, max_alter_tage=7)
    assert anzahl == 1
    assert mock_s3.deleted

    r = await client.get(f"/guilds/{gid}/ablage/zwischenlager", headers=auth(t_mitglied))
    assert r.json() == []
