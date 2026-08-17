"""Aufräumwege beim Löschen von Communitys und Kanälen.

Bughunt 2026-08-17 (``docs/pruef/bughunt-2026-08-17/runde-2/{chat,ablage}.md``,
``docs/pruef/bughunt-2026-08-17/daten.md``) fand drei Lücken:

* Community-Löschung räumte die MinIO-Objekte der Sound-Overrides nicht ab
  (Zeilen fallen per ``ON DELETE CASCADE``, die Bytes blieben liegen).
* Community-Löschung entfernte das Community-Symbol nie vom Datenträger —
  es blieb unauthentifiziert unter seiner deterministischen Adresse abrufbar.
* Kanal- und Community-Löschung räumten das In-Prozess-Geräteregister nicht
  auf: eine gelöschte Zeile hinterließ Standplatz und Bildschirmliste dauerhaft
  im Speicher des Prozesses.

Diese Tests belegen, dass alle drei jetzt aufgeräumt werden.
"""

from __future__ import annotations

import uuid

import pytest
from dcc_chat_gateway import s3 as s3_mod
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE
from dcc_chat_gateway.routes import guild_icons as guild_icons_mod


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _user(_auth_signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _guild(client, token: str, name: str = "g") -> dict:
    r = await client.post("/guilds", json={"name": name}, headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()


async def _voice_channel(client, token: str, guild_id, name: str = "vc") -> dict:
    r = await client.post(
        f"/guilds/{guild_id}/channels",
        json={"name": name, "type": CHANNEL_TYPE_VOICE},
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()


def _register(client):
    """Das Geräte-Register sitzt am ConnectionManager der Test-App (Muster aus
    ``test_devices.py``)."""
    return client._transport.app.state.connection_manager


class _Sock:
    async def send_json(self, payload: dict) -> None:  # pragma: no cover
        pass


# ── Sound-Overrides ──────────────────────────────────────────────────────────


class _S3Mock:
    def __init__(self) -> None:
        self.put: dict[str, bytes] = {}
        self.deleted: list[str] = []

    async def put_object(self, key, *, body, content_type):
        self.put[key] = body

    async def presigned_get_url(self, key, *, filename=None, inline=True):
        return f"https://mock/{key}?sig"

    async def delete_object(self, key):
        self.deleted.append(key)
        self.put.pop(key, None)


@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "put_object", m.put_object)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    return m


def _ogg(body: bytes = b"OggS\x00fakeoggdata") -> dict:
    return {"file": ("custom.ogg", body, "audio/ogg")}


@pytest.mark.asyncio
async def test_guild_delete_purges_sound_override_objects(
    client, _auth_signer, mock_s3
):
    """Befund (chat.md, mittel): die Community-Löschung sammelte nur
    Anhänge und Ablage ein, nie die Sound-Override-Objekte — die Zeile
    verschwindet per CASCADE, das MinIO-Objekt blieb liegen."""
    token, _uid = await _user(_auth_signer)
    g = await _guild(client, token)
    gid = g["id"]

    r = await client.put(
        f"/guilds/{gid}/sounds/ui.send", files=_ogg(), headers=auth(token)
    )
    assert r.status_code == 200, r.text
    key = f"guild-sounds/{gid}/ui.send"
    assert key in mock_s3.put

    r = await client.delete(f"/guilds/{gid}", headers=auth(token))
    assert r.status_code == 204, r.text
    assert key in mock_s3.deleted
    assert key not in mock_s3.put


# ── Community-Symbol ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guild_delete_purges_icon_file(client, _auth_signer, tmp_path, monkeypatch):
    """Befund (ablage.md, mittel): das Community-Symbol liegt lokal auf der
    Platte (nicht in MinIO) und wurde von keiner Löschung angefasst — es blieb
    danach unter seiner deterministischen Adresse abrufbar."""
    monkeypatch.setattr(
        guild_icons_mod._config,
        "get_settings",
        lambda: type("S", (), {"guild_icon_upload_dir": str(tmp_path)})(),
    )

    token, _uid = await _user(_auth_signer)
    g = await _guild(client, token)
    gid = g["id"]

    icon_path = tmp_path / f"{gid}.webp"
    icon_path.write_bytes(b"fake-webp-bytes")
    assert icon_path.exists()

    r = await client.delete(f"/guilds/{gid}", headers=auth(token))
    assert r.status_code == 204, r.text
    assert not icon_path.exists()


@pytest.mark.asyncio
async def test_guild_delete_without_icon_does_not_raise(client, _auth_signer, tmp_path, monkeypatch):
    """Kein Symbol gesetzt → best-effort-Aufräumen darf die Löschung nicht
    scheitern lassen (kein Fehler, wenn es nichts zu löschen gibt)."""
    monkeypatch.setattr(
        guild_icons_mod._config,
        "get_settings",
        lambda: type("S", (), {"guild_icon_upload_dir": str(tmp_path)})(),
    )

    token, _uid = await _user(_auth_signer)
    g = await _guild(client, token)

    r = await client.delete(f"/guilds/{g['id']}", headers=auth(token))
    assert r.status_code == 204, r.text


# ── Geräte-Register ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_channel_delete_forgets_devices_in_registry(client, _auth_signer):
    """Befund (daten.md, niedrig): eine Kanal-Löschung nimmt die Geräte-Zeile
    per CASCADE mit, das In-Prozess-Register wusste bisher nichts davon —
    Standplatz und Bildschirmliste blieben für die gelöschte Kennung stehen."""
    token, _uid = await _user(_auth_signer)
    g = await _guild(client, token)
    gid = g["id"]
    vc = await _voice_channel(client, token, gid)
    cid = vc["id"]

    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(cid), "name": "werkstatt-pc"},
            headers=auth(token),
        )
    ).json()
    did = int(device["id"])

    mgr = _register(client)
    mgr.device_announce(_Sock(), did, int(gid), int(cid), [{"index": 1, "name": "HDMI-1"}])
    assert mgr.device_state(did) == ("ready", None)

    r = await client.delete(f"/channels/{cid}", headers=auth(token))
    assert r.status_code == 204, r.text

    assert did not in mgr._device_where
    assert did not in mgr._device_monitors
    assert mgr.device_state(did) == ("offline", None)


@pytest.mark.asyncio
async def test_guild_delete_forgets_devices_in_registry(client, _auth_signer):
    """Dieselbe Lücke, Community-Hälfte: ``delete_guild`` warf bisher weder
    einen Blick ins Geräteregister noch räumte es auf."""
    token, _uid = await _user(_auth_signer)
    g = await _guild(client, token)
    gid = g["id"]
    vc = await _voice_channel(client, token, gid)
    cid = vc["id"]

    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(cid), "name": "werkstatt-pc"},
            headers=auth(token),
        )
    ).json()
    did = int(device["id"])

    mgr = _register(client)
    mgr.device_announce(_Sock(), did, int(gid), int(cid), [{"index": 1, "name": "HDMI-1"}])
    assert mgr.device_state(did) == ("ready", None)

    r = await client.delete(f"/guilds/{gid}", headers=auth(token))
    assert r.status_code == 204, r.text

    assert did not in mgr._device_where
    assert did not in mgr._device_monitors
    assert mgr.device_state(did) == ("offline", None)


@pytest.mark.asyncio
async def test_guild_delete_without_devices_does_not_raise(client, _auth_signer):
    """Keine Geräte eingetragen → der neue Aufräumschritt darf die Löschung
    nicht stören (leerer Fall)."""
    token, _uid = await _user(_auth_signer)
    g = await _guild(client, token)

    r = await client.delete(f"/guilds/{g['id']}", headers=auth(token))
    assert r.status_code == 204, r.text
