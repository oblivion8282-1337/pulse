"""Das Pulse-Laufwerk (2026-09-11). S3 gemockt wie in
``test_ablage_zwischenlager.py`` — geprueft wird die DB-Seite: Rechte,
Kontingente, Zustands-Maschine (angekündigt -> hochgeladen), Aufräumen.
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway import s3 as s3_mod

# Die Owner-Routen (Betreiber-Zuweisung) lösen die Owner-Claim nur im
# Cloud-Modus auf — dieselbe Regel wie test_guild_limits.py.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


class _S3Mock:
    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.put_lengths: list[int | None] = []

    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        self.put_lengths.append(content_length)
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
async def test_nur_besitzer_verbindet_und_trennt(client, _auth_signer, mock_s3):
    t_owner, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)

    r = await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_mitglied))
    assert r.status_code == 403

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_mitglied))
    assert r.status_code == 200
    assert r.json()["verbunden"] is False

    r = await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))
    assert r.status_code == 204

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_mitglied))
    assert r.json()["verbunden"] is True
    assert r.json()["kontingent_bytes"] > 0

    r = await client.delete(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_mitglied))
    assert r.status_code == 403
    r = await client.delete(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))
    assert r.status_code == 204

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["verbunden"] is False


@pytest.mark.asyncio
async def test_ankuendigung_ohne_laufwerk_findet_nicht_statt(client, _auth_signer, mock_s3):
    _, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 10},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_mitglied_klumpen_weg_von_ankuendigung_bis_lese_url(client, _auth_signer, mock_s3):
    t_owner, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-3f2b01.puls", "groesse": 1234},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 201, r.text
    assert r.json()["upload_url"].startswith("https://mock/")

    # Unbestaetigt: kein Kontingent-Verbrauch, nicht in der Namensliste.
    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["genutzt_bytes"] == 0
    r = await client.get(f"/guilds/{gid}/ablage/pulse/dateien", headers=auth(t_mitglied))
    assert r.json() == []

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
        json={"name": "a-3f2b01.puls"},
        headers=auth(t_owner),  # fremde Bestaetigung aendert nichts
    )
    assert r.status_code == 204
    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["genutzt_bytes"] == 0

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
        json={"name": "a-3f2b01.puls"},
        headers=auth(t_mitglied),
    )
    assert r.status_code == 204
    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["genutzt_bytes"] == 1234

    r = await client.get(f"/guilds/{gid}/ablage/pulse/dateien", headers=auth(t_mitglied))
    assert r.json() == ["a-3f2b01.puls"]

    r = await client.get(
        f"/guilds/{gid}/ablage/pulse/dateien/lese-url",
        params={"name": "a-3f2b01.puls"},
        headers=auth(t_owner),
    )
    assert r.status_code == 200
    assert r.json()["url"].startswith("https://mock/")

    r = await client.delete(
        f"/guilds/{gid}/ablage/pulse/dateien",
        params={"name": "a-3f2b01.puls"},
        headers=auth(t_owner),
    )
    assert r.status_code == 204
    assert mock_s3.deleted
    r = await client.get(f"/guilds/{gid}/ablage/pulse/dateien", headers=auth(t_mitglied))
    assert r.json() == []


@pytest.mark.asyncio
async def test_verzeichnis_hat_eigene_kleine_grenze(client, _auth_signer, mock_s3):
    from dcc_chat_gateway import config as chat_config

    einstellungen = chat_config.get_settings()
    alt = einstellungen.pulse_laufwerk_verzeichnis_max_bytes
    einstellungen.pulse_laufwerk_verzeichnis_max_bytes = 256 * 1024
    try:
        t_owner, _, _, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
        await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))

        r = await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien",
            json={"name": "verzeichnis.puls", "groesse": 256 * 1024 + 1},
            headers=auth(t_owner),
        )
        assert r.status_code == 413
        r = await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien",
            json={"name": "verzeichnis.puls", "groesse": 1024},
            headers=auth(t_owner),
        )
        assert r.status_code == 201
    finally:
        einstellungen.pulse_laufwerk_verzeichnis_max_bytes = alt


@pytest.mark.asyncio
async def test_gesamtkontingent_zaehlt_nur_gelungene(client, _auth_signer, mock_s3):
    from dcc_chat_gateway import config as chat_config

    einstellungen = chat_config.get_settings()
    alt_datei = einstellungen.pulse_laufwerk_max_datei_bytes
    alt_gesamt = einstellungen.pulse_laufwerk_max_gesamt_bytes
    einstellungen.pulse_laufwerk_max_datei_bytes = 1000
    einstellungen.pulse_laufwerk_max_gesamt_bytes = 1500
    try:
        t_owner, _, t_mitglied, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
        await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))

        r = await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien",
            json={"name": "a-01.puls", "groesse": 1000},
            headers=auth(t_mitglied),
        )
        assert r.status_code == 201
        # Angekuendigt, nie gelungen — verbraucht noch nichts.
        r = await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien",
            json={"name": "a-02.puls", "groesse": 1000},
            headers=auth(t_mitglied),
        )
        assert r.status_code == 201

        await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
            json={"name": "a-01.puls"},
            headers=auth(t_mitglied),
        )
        r = await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien",
            json={"name": "a-03.puls", "groesse": 501},
            headers=auth(t_mitglied),
        )
        assert r.status_code == 413
        r = await client.post(
            f"/guilds/{gid}/ablage/pulse/dateien",
            json={"name": "a-03.puls", "groesse": 500},
            headers=auth(t_mitglied),
        )
        assert r.status_code == 201
    finally:
        einstellungen.pulse_laufwerk_max_datei_bytes = alt_datei
        einstellungen.pulse_laufwerk_max_gesamt_bytes = alt_gesamt


@pytest.mark.asyncio
async def test_loeschen_nur_uploader_oder_besitzer(client, _auth_signer, mock_s3):
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_mitglied, uid_mitglied = await _register_user(_auth_signer)
    t_zwei, uid_zwei = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    for uid in (uid_mitglied, uid_zwei):
        await client.post(
            f"/guilds/{g['id']}/members", json={"user_id": str(uid)}, headers=auth(t_owner)
        )
    gid = g["id"]
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))

    await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-09.puls", "groesse": 10},
        headers=auth(t_mitglied),
    )
    await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
        json={"name": "a-09.puls"},
        headers=auth(t_mitglied),
    )

    r = await client.delete(
        f"/guilds/{gid}/ablage/pulse/dateien",
        params={"name": "a-09.puls"},
        headers=auth(t_zwei),
    )
    assert r.status_code == 403
    r = await client.delete(
        f"/guilds/{gid}/ablage/pulse/dateien",
        params={"name": "a-09.puls"},
        headers=auth(t_mitglied),  # Uploader selbst darf
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_unpassender_name_wird_abgewiesen(client, _auth_signer, mock_s3):
    t_owner, _, _, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))
    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "../schlimm.puls", "groesse": 10},
        headers=auth(t_owner),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_admin_zuweisung_statt_default_kontingent(
    client, _auth_signer, mock_s3, session_factory
):
    """Die 1-GB-Zuweisung aus den Server-Einstellungen (DropboxConfig,
    Legacy-Name der Community-Ablage-Verwaltung) gilt — nicht der
    Instanz-Default. Alte Belegung zählt mit, die Datei-Grenze ebenso."""
    from dcc_chat_gateway.models import DropboxConfig

    t_owner, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    gid = g["id"]
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))

    async with session_factory() as session:
        session.add(
            DropboxConfig(
                guild_id=gid,
                enabled=True,
                total_quota_bytes=1500,
                per_file_max_bytes=1000,
                used_bytes=200,  # Alt-Belegung aus dem früheren Speicherweg
            )
        )
        await session.commit()

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["kontingent_bytes"] == 1500
    assert r.json()["genutzt_bytes"] == 200

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 3 * 1024 * 1024},
        headers=auth(t_owner),
    )
    assert r.status_code == 413  # über per_file_max_bytes der Zuweisung

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 1000},
        headers=auth(t_owner),
    )
    assert r.status_code == 201
    await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
        json={"name": "a-01.puls"},
        headers=auth(t_owner),
    )
    # 200 alt + 1000 neu = 1200; 400 bleiben frei — und die Grenze je Datei
    # (1000) schließt den Rest sowieso aus.
    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-02.puls", "groesse": 500},
        headers=auth(t_owner),
    )
    assert r.status_code == 413


@pytest.mark.asyncio
async def test_deaktivierte_ablage_blockiert_neue_ankuendigung(
    client, _auth_signer, mock_s3, session_factory
):
    from dcc_chat_gateway.models import DropboxConfig

    t_owner, _ = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()
    gid = g["id"]
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))

    async with session_factory() as session:
        session.add(DropboxConfig(guild_id=gid, enabled=False, total_quota_bytes=1500))
        await session.commit()

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 10},
        headers=auth(t_owner),
    )
    assert r.status_code == 409


# ─── Super-Admin-Kette: Betreiber-Zuweisung steuert das Pulse-Kontingent ────


@pytest.mark.asyncio
async def test_super_admin_obergrenze_gilt_fuer_pulse_ablage(
    client, _auth_signer, mock_s3, owner_token, cloud_mode, session_factory
):
    owner_tok, _owner_uid = owner_token
    """Kette laut Festlegung: Betreiber gibt der Community 1000 Bytes →
    das Pulse-Laufwerk zeigt 1000 und weist Mehr ab. Der Kanal wird VOR
    der Zuweisung angelegt (Config mit der 1-GiB-Default-Decke geseedet),
    das Senken der Decke muss sofort nachziehen."""
    t_owner, _, _, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))
    r = await client.post(
        f"/guilds/{gid}/dropbox/channel",
        json={"name": "Ablage"},
        headers=auth(t_owner),
    )
    assert r.status_code in (200, 201), r.text

    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={"dropbox_allowed": True, "dropbox_quota_bytes": 2 * 1024 * 1024},
        headers=auth(owner_tok),
    )
    assert r.status_code == 200, r.text

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["kontingent_bytes"] == 2 * 1024 * 1024

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 3 * 1024 * 1024},
        headers=auth(t_owner),
    )
    assert r.status_code == 413
    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 1024 * 1024},
        headers=auth(t_owner),
    )
    assert r.status_code == 201
    await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
        json={"name": "a-01.puls"},
        headers=auth(t_owner),
    )
    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["genutzt_bytes"] == 1024 * 1024


@pytest.mark.asyncio
async def test_super_admin_senkung_beisst_sofort(
    cloud_mode, client, _auth_signer, mock_s3, owner_token, session_factory
):
    owner_tok, _owner_uid = owner_token
    """Decke später senken: bestehende Config wird runtergezogen (clamp),
    die Pulse-Ablage weist beim nächsten Upload ab — ohne dass die
    Community selbst speichert."""
    t_owner, _, _, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))
    await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-01.puls", "groesse": 800000},
        headers=auth(t_owner),
    )
    await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien/gelungen",
        json={"name": "a-01.puls"},
        headers=auth(t_owner),
    )

    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={"dropbox_quota_bytes": 1024 * 1024},
        headers=auth(owner_tok),
    )
    assert r.status_code == 200, r.text

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["kontingent_bytes"] == 1024 * 1024

    r = await client.post(
        f"/guilds/{gid}/ablage/pulse/dateien",
        json={"name": "a-02.puls", "groesse": 800000},
        headers=auth(t_owner),
    )
    assert r.status_code == 413


@pytest.mark.asyncio
async def test_community_eroschung_wird_auf_decke_geklemmt(
    client, _auth_signer, mock_s3, owner_token, cloud_mode
):
    owner_tok, _owner_uid = owner_token
    """Die Community kann ihre Ablage-Einstellung erhöhen, aber nie über
    die Betreiber-Decke hinaus (clamp statt Fehler — die Antwort trägt den
    wirklichen Wert)."""
    from dcc_chat_gateway import config as chat_config

    chat_config.get_settings().cloud_dropbox_enabled = True
    t_owner, _, _, _, gid = await _guild_mit_zwei_mitgliedern(client, _auth_signer)
    await client.put(f"/guilds/{gid}/ablage/pulse/laufwerk", headers=auth(t_owner))
    r = await client.patch(
        f"/owner/communities/{gid}/limits",
        json={"dropbox_allowed": True, "dropbox_quota_bytes": 2 * 1024 * 1024},
        headers=auth(owner_tok),
    )
    assert r.status_code == 200, r.text

    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 5 * 1024 * 1024},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    assert r.json()["total_quota_bytes"] == 2 * 1024 * 1024

    r = await client.get(f"/guilds/{gid}/ablage/pulse/status", headers=auth(t_owner))
    assert r.json()["kontingent_bytes"] == 2 * 1024 * 1024
