"""Dropbox / Ablage routes — happy path + permission gates.
Covers:
- channel + config auto-provision on first access
- folder CRUD + listing
- rename, move, pin
- soft-delete + restore
- admin quota settings
- upload pipeline (presigned PUT mint + finish-upload HEAD)
MinIO is mocked — real binary put/get would require docker-compose.
"""
from __future__ import annotations
import uuid
import pytest
from botocore.exceptions import ClientError
from sqlalchemy import event
from dcc_chat_gateway import s3 as s3_mod
from dcc_chat_gateway.models import Guild
from dcc_chat_gateway.routes._dropbox_policy import DEFAULT_DROPBOX_QUOTA_BYTES
def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
async def _user(_auth_signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid
class _S3Mock:
    def __init__(self) -> None:
        self.put: dict[str, bytes] = {}
        self.deleted: list[str] = []
    async def put_object(self, key, *, body, content_type):
        self.put[key] = body
    async def presigned_put_url(self, key, *, content_type=None, content_length=None):
        return f"https://mock/{key}?put"
    async def presigned_get_url(self, key, *, filename=None, inline=True):
        suffix = "att" if (not inline and filename) else "sig"
        return f"https://mock/{key}?{suffix}"
    async def stream_object(self, key):
        body = self.put.get(key, b"")
        for i in range(0, len(body), 4096):
            yield body[i : i + 4096]
    async def head_object(self, key):
        if key not in self.put:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "no"}},
                "HeadObject",
            )
        return {"ContentLength": len(self.put[key]), "ContentType": "application/octet-stream"}
    async def delete_object(self, key):
        self.deleted.append(key)
        self.put.pop(key, None)
    async def _ensure_internal_client(self):
        """Stand-in for the aiobotocore client the production
        ``_ensure_internal_client`` would hand out. The purge path
        iterates ``list_objects_v2`` over a single page; we hand back
        a stub that paginates the in-memory ``put`` dict."""
        outer = self
        class _Paginator:
            def paginate(self, *, Bucket, Prefix=""):
                return _AsyncIter(
                    [
                        {
                            "Contents": [
                                {"Key": k, "Size": len(v)}
                                for k, v in outer.put.items()
                                if k.startswith(Prefix)
                            ]
                        }
                    ]
                )
        return _Client(_Paginator())
class _AsyncIter:
    def __init__(self, pages: list[dict]) -> None:
        self._pages = pages
    def __aiter__(self):
        return self
    async def __anext__(self):
        if not self._pages:
            raise StopAsyncIteration
        return self._pages.pop(0)
class _Client:
    def __init__(self, paginator) -> None:
        self._paginator = paginator
    def get_paginator(self, _name):
        return self._paginator
@pytest.fixture
def mock_s3(monkeypatch):
    m = _S3Mock()
    monkeypatch.setattr(s3_mod, "put_object", m.put_object)
    monkeypatch.setattr(s3_mod, "presigned_put_url", m.presigned_put_url)
    monkeypatch.setattr(s3_mod, "presigned_get_url", m.presigned_get_url)
    monkeypatch.setattr(s3_mod, "head_object", m.head_object)
    monkeypatch.setattr(s3_mod, "delete_object", m.delete_object)
    monkeypatch.setattr(s3_mod, "stream_object", m.stream_object)
    monkeypatch.setattr(s3_mod, "_ensure_internal_client", m._ensure_internal_client)
    return m
@pytest.fixture(autouse=True)
def _dropbox_unlocked_by_default():
    """In diesem Modul startet jede neue Community mit freigeschalteter Ablage.
    ``guilds.dropbox_allowed`` ist ab Migration 0056 standardmäßig aus (der
    Betreiber schaltet pro Community frei). Ohne diesen Seed müsste jeder der
    ~40 Tests hier erst den Betreiber-Schalter umlegen, bevor er zu seiner
    eigentlichen Aussage kommt — dieselbe Abwägung, die die conftest schon bei
    ``allow_guild_creation`` trifft.
    Die Tests, die das Gate SELBST prüfen, setzen das Flag explizit zurück und
    verlassen sich nicht auf diesen Default."""
    def _unlock(_mapper, _connection, target):
        target.dropbox_allowed = True
    event.listen(Guild, "before_insert", _unlock)
    yield
    event.remove(Guild, "before_insert", _unlock)
async def _create_guild(client, token: str) -> dict:
    r = await client.post("/guilds", json={"name": "g"}, headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()
async def _set_dropbox_allowed(session_factory, gid: str, allowed: bool) -> None:
    """Den Betreiber-Schalter direkt setzen — der echte Weg (PATCH
    /owner/communities/{id}/limits) bräuchte einen Owner-Token, und darum geht
    es in den Tests hier nicht."""
    async with session_factory() as s:
        guild = await s.get(Guild, int(gid))
        guild.dropbox_allowed = allowed
        await s.commit()
async def _provision_dropbox(client, token: str, gid: str) -> None:
    """Allocate the dropbox channel + config row for a freshly created
    guild. Required by every endpoint that reads or mutates the config,
    because ``GET /quota`` / ``GET /entries`` / upload routes are now
    read-only and 404 when the dropbox was never provisioned
    (regression-guard for the bug where a sidebar ping auto-enabled the
    dropbox for every guild)."""
    r = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert r.status_code == 200, r.text
# ─── Channel + config auto-provision ────────────────────────────────────────
@pytest.mark.asyncio
async def test_dropbox_channel_create_idempotent(client, _auth_signer, mock_s3):
    """First call creates + config row + dropbox channel; second call
    is a no-op fetch that hands back the same id."""
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    r1 = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["created"] is True
    assert body1["type"] == 2
    r2 = await client.get(
        f"/guilds/{gid}/dropbox/channel", headers=auth(token)
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["created"] is False
    assert body2["id"] == body1["id"]
@pytest.mark.asyncio
async def test_create_dropbox_channel_honours_user_name(
    client, _auth_signer, mock_s3
):
    """Regression: ``POST /dropbox/channel`` must apply the user-supplied
    name on creation. The frontend's create-channel dialog used to call
    the GET endpoint (which hard-codes ``"ablage"``) for type=2,
    discarding whatever the admin typed."""
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    r1 = await client.post(
        f"/guilds/{gid}/dropbox/channel",
        json={"name": "dropbox"},
        headers=auth(token),
    )
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["created"] is True
    assert body1["name"] == "dropbox"
    # Second POST with a different name must NOT rename — singleton,
    # admin renames via PATCH.
    r2 = await client.post(
        f"/guilds/{gid}/dropbox/channel",
        json={"name": "files"},
        headers=auth(token),
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["created"] is False
    assert body2["id"] == body1["id"]
    assert body2["name"] == "dropbox"
@pytest.mark.asyncio
async def test_create_dropbox_channel_rejects_forbidden_name(
    client, _auth_signer, mock_s3
):
    """Display-string sink: dropbox channel name is a phishing surface
    — same ``validate_name`` hardening as entry basenames."""
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    # Hard-rejected: path-traversal, empty, "..".
    for bad in ("../etc/passwd", "", "."):
        r = await client.post(
            f"/guilds/{gid}/dropbox/channel",
            json={"name": bad},
            headers=auth(token),
        )
        assert r.status_code == 422, (bad, r.text)
    # Bidi-override chars are STRIPPED (not rejected) — the rendered
    # channel name is what the user sees, so stripping neutralises
    # the spoof rather than 422-ing. Same hardening as entry names.
    r_bidi = await client.post(
        f"/guilds/{gid}/dropbox/channel",
        json={"name": "evil‮vbs.exe"},
        headers=auth(token),
    )
    assert r_bidi.status_code == 200, r_bidi.text
    assert r_bidi.json()["name"] == "evilvbs.exe"
    # Singleton: the second call returns the same channel unchanged.
    assert r_bidi.json()["created"] is True
@pytest.mark.asyncio
async def test_quota_defaults_then_patch(client, _auth_signer, mock_s3):
    """Quota startet auf der Betreiber-Obergrenze (Instanz-Standard 1 GiB, weil
    ``guilds.dropbox_quota_bytes`` nicht gesetzt ist), pro Datei 100 MiB. Die
    Community-Leitung darf die Pro-Datei-Grenze senken, das bleibt haften."""
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)
    r = await client.get(f"/guilds/{gid}/dropbox/quota", headers=auth(token))
    assert r.status_code == 200, r.text
    q = r.json()
    assert q["total_quota_bytes"] == DEFAULT_DROPBOX_QUOTA_BYTES
    assert q["per_file_max_bytes"] == 100 * 1024**2
    patch_r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"per_file_max_bytes": 50 * 1024**2, "trash_retention_days": 14},
        headers=auth(token),
    )
    assert patch_r.status_code == 200, patch_r.text
    new = patch_r.json()
    assert new["per_file_max_bytes"] == 50 * 1024**2
    assert new["trash_retention_days"] == 14
    assert new["total_quota_bytes"] == DEFAULT_DROPBOX_QUOTA_BYTES  # unchanged
@pytest.mark.asyncio
async def test_quota_shrink_within_floor_is_accepted(client, _auth_signer, mock_s3):
    """Shrinking within the ge=1 MiB floor is allowed (no files have
    been uploaded yet, so used_bytes=0). Verifies the lower-bound does
    not block legitimate smaller quotas."""
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 5 * 1024 * 1024},  # 5 MiB (passes ge=1 MiB)
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["total_quota_bytes"] == 5 * 1024 * 1024
@pytest.mark.asyncio
async def test_quota_below_1mib_floor_rejected(client, _auth_signer, mock_s3):
    """The 1 MiB floor rejects quota shrinks below it — protects the
    admin from accidentally setting an unusably small cap."""
    token, _uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 1024},  # 1 KiB — below the ge=1 MiB floor
        headers=auth(token),
    )
    assert r.status_code == 422, r.text
# ─── Folder CRUD + listing ──────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_content_type_text_html_relabeled_to_octet_stream():
    """A member uploading ``evil.html`` with content_type ``text/html``
    must land in the DB as ``application/octet-stream`` — the
    presigned GET is signed with ``inline=False``, the browser is
    forced to download, and the inline-XSS vector is closed.
    Regression for the 2026-06-30 finding #3."""
    from dcc_chat_gateway.routes._dropbox_helpers import (
        is_safe_inline_content_type,
        normalize_content_type,
    )
    assert normalize_content_type("text/html") == "application/octet-stream"
    assert (
        normalize_content_type("text/html; charset=utf-8")
        == "application/octet-stream"
    )
    assert (
        normalize_content_type("application/javascript")
        == "application/octet-stream"
    )
    # The safe-inline whitelist keeps the listed prefixes.
    assert is_safe_inline_content_type("image/png") is True
    assert is_safe_inline_content_type("application/pdf") is True
    assert is_safe_inline_content_type("text/plain") is True
    assert is_safe_inline_content_type("TEXT/PLAIN") is True
    # SVG is the lone denied type — it can carry inline <script>.
    assert is_safe_inline_content_type("image/svg+xml") is False
    assert normalize_content_type("image/svg+xml") == "application/octet-stream"
@pytest.mark.asyncio
async def test_sweep_purges_object_of_expired_pending_upload(
    client, _auth_signer, mock_s3, session_factory, monkeypatch
):
    """Once a mint's ``expires_at`` is in the past the upload is
    genuinely abandoned — the orphan half must still reclaim its
    bytes, same as before this fix, just gated on expiry instead of
    being unconditional."""
    from datetime import datetime, timedelta, timezone
    from dcc_chat_gateway.models import DropboxPendingUpload
    from dcc_chat_gateway.routes import dropbox_admin
    from dcc_chat_gateway.routes._dropbox_helpers import storage_path_for
    monkeypatch.setattr(dropbox_admin, "SessionLocal", session_factory)
    token, uid = await _user(_auth_signer)
    g = await _create_guild(client, token)
    gid = g["id"]
    await _provision_dropbox(client, token, gid)
    expired_id = int(datetime.now().timestamp() * 1000) * 1000
    long_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    async with session_factory() as s:
        s.add(
            DropboxPendingUpload(
                id=expired_id,
                uploader_id=uid,
                guild_id=int(gid),
                parent_path="",
                name="abandoned.bin",
                size_bytes=5,
                expires_at=long_ago,
            )
        )
        await s.commit()
    key = storage_path_for(int(gid), expired_id)
    mock_s3.put[key] = b"never-finished"
    await dropbox_admin._sweep_once(connection_manager=None)
    assert key not in mock_s3.put
    assert key in mock_s3.deleted
@pytest.mark.asyncio
async def test_dropbox_gate_off_on_cloud(client, _auth_signer, mock_s3, cloud_mode):
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    # Every surface is gone, not just the upload mint — otherwise existing
    # files would stay listable and downloadable.
    for method, path in (
        ("get", f"/guilds/{gid}/dropbox/channel"),
        ("get", f"/guilds/{gid}/dropbox/entries"),
        ("get", f"/guilds/{gid}/dropbox/quota"),
    ):
        r = await getattr(client, method)(path, headers=auth(t))
        assert r.status_code == 404, f"{method.upper()} {path} → {r.status_code}"
    r = await client.post(
        f"/guilds/{gid}/dropbox/upload-url",
        json={"name": "x.bin", "parent_path": "/", "size_bytes": 10,
              "content_type": "application/octet-stream"},
        headers=auth(t),
    )
    assert r.status_code == 404, r.text
@pytest.mark.asyncio
async def test_dropbox_gate_reversible_via_flag(
    client, _auth_signer, mock_s3, cloud_mode
):
    """CLOUD_DROPBOX_ENABLED=true re-arms the feature without a code change."""
    cloud_mode.cloud_dropbox_enabled = True
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    r = await client.get(f"/guilds/{g['id']}/dropbox/channel", headers=auth(t))
    assert r.status_code == 200, r.text
@pytest.mark.asyncio
async def test_dropbox_unaffected_on_self_host(client, _auth_signer, mock_s3):
    """Default test mode is self-host — the gate must never fire there."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    r = await client.get(f"/guilds/{g['id']}/dropbox/channel", headers=auth(t))
    assert r.status_code == 200, r.text
# ─── Betreiber-Ebene: Freischaltung + Speicher-Obergrenze ───────────────────
@pytest.mark.asyncio
async def test_locked_community_404s_every_dropbox_route(
    client, _auth_signer, mock_s3, session_factory
):
    """Ohne Freischaltung durch den Betreiber ist die Ablage komplett zu —
    nicht nur der Upload. Ein Gate allein auf der Mint-Route ließe Auflisten
    und Herunterladen vorhandener Dateien offen."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    await _provision_dropbox(client, t, gid)
    await _set_dropbox_allowed(session_factory, gid, False)
    for method, path in (
        ("get", f"/guilds/{gid}/dropbox/channel"),
        ("get", f"/guilds/{gid}/dropbox/entries"),
        ("get", f"/guilds/{gid}/dropbox/quota"),
        ("post", f"/guilds/{gid}/dropbox/folders"),
        ("patch", f"/guilds/{gid}/dropbox/settings"),
    ):
        r = await getattr(client, method)(
            path, **({"json": {}} if method != "get" else {}), headers=auth(t)
        )
        assert r.status_code == 404, f"{method.upper()} {path} → {r.status_code}"
@pytest.mark.asyncio
async def test_community_admin_cannot_lift_the_operator_lock(
    client, _auth_signer, mock_s3, session_factory
):
    """Der eigentliche Grund für die zweite Ebene: MANAGE_GUILD darf die
    Sperre des Betreibers nicht aufheben können. Der Guild-Owner hat hier
    volle Rechte und kommt trotzdem nicht durch."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    await _set_dropbox_allowed(session_factory, gid, False)
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"enabled": True},
        headers=auth(t),
    )
    assert r.status_code == 404, r.text
    async with session_factory() as s:
        guild = await s.get(Guild, int(gid))
        assert guild.dropbox_allowed is False, "Sperre wurde unterlaufen"
@pytest.mark.asyncio
async def test_community_quota_is_clamped_to_operator_ceiling(
    client, _auth_signer, mock_s3, session_factory
):
    """Die Community darf sich unter der Obergrenze frei bewegen, aber nicht
    darüber — ohne das Klemmen wäre der Betreiber-Wert wirkungslos, weil
    ``total_quota_bytes`` an MANAGE_GUILD hängt."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    await _provision_dropbox(client, t, gid)
    async with session_factory() as s:
        guild = await s.get(Guild, int(gid))
        guild.dropbox_quota_bytes = 2 * 1024**3  # 2 GiB
        await s.commit()
    # Darunter: unverändert übernommen.
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 1024**3},
        headers=auth(t),
    )
    assert r.status_code == 200, r.text
    assert r.json()["total_quota_bytes"] == 1024**3
    # Darüber: auf die Obergrenze geklemmt, kein Fehler — und die Antwort
    # zeigt den gespeicherten Wert, damit der Editor nicht lügt.
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"total_quota_bytes": 500 * 1024**3},
        headers=auth(t),
    )
    assert r.status_code == 200, r.text
    assert r.json()["total_quota_bytes"] == 2 * 1024**3
@pytest.mark.asyncio
async def test_fresh_config_starts_at_operator_ceiling(
    client, _auth_signer, mock_s3, session_factory
):
    """Eine frisch angelegte Config startet auf der Obergrenze statt auf dem
    alten 5-GiB-Spaltendefault — sonst stünde jede neue Community sofort über
    dem Limit und würde erst beim ersten Speichern zurechtgestutzt."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    async with session_factory() as s:
        guild = await s.get(Guild, int(gid))
        guild.dropbox_quota_bytes = 3 * 1024**3
        await s.commit()
    await _provision_dropbox(client, t, gid)
    r = await client.get(f"/guilds/{gid}/dropbox/quota", headers=auth(t))
    assert r.status_code == 200, r.text
    assert r.json()["total_quota_bytes"] == 3 * 1024**3
# ─── Community-Master-Schalter blockt die Kanal-ERSTELLUNG ──────────────────
@pytest.mark.asyncio
async def test_disabled_community_dropbox_blocks_channel_creation(
    client, _auth_signer, mock_s3
):
    """Hat die Community-Leitung die Ablage abgeschaltet (enabled=false), darf
    kein neuer Ablage-Kanal entstehen — auch wenn der Betreiber sie freigegeben
    hat. Vorher ließ sich ein Kanal anlegen, der dann unbenutzbar dastand."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    # Community schaltet die Ablage ab (legt die Config mit enabled=false an).
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"enabled": False},
        headers=auth(t),
    )
    assert r.status_code == 200, r.text
    # POST (Create-Dialog) und GET (Auto-Provision) müssen beide 409en.
    for method in ("post", "get"):
        kwargs = {"json": {"name": "ablage"}} if method == "post" else {}
        r = await getattr(client, method)(
            f"/guilds/{gid}/dropbox/channel", **kwargs, headers=auth(t)
        )
        assert r.status_code == 409, f"{method.upper()} → {r.status_code}: {r.text}"
@pytest.mark.asyncio
async def test_existing_channel_stays_reachable_when_disabled(
    client, _auth_signer, mock_s3
):
    """Ein bereits vorhandener Ablage-Kanal bleibt nach dem Abschalten
    abrufbar (created=false) — nur die Nutzung ist geblockt, der Kanal
    verschwindet nicht. Die Sperre trifft nur die Neu-Erstellung."""
    t, _uid = await _user(_auth_signer)
    g = await _create_guild(client, t)
    gid = g["id"]
    # Erst Kanal anlegen (enabled default true), dann abschalten.
    await _provision_dropbox(client, t, gid)
    r = await client.patch(
        f"/guilds/{gid}/dropbox/settings",
        json={"enabled": False},
        headers=auth(t),
    )
    assert r.status_code == 200, r.text
    # GET gibt den vorhandenen Kanal weiter zurück, kein 409.
    r = await client.get(f"/guilds/{gid}/dropbox/channel", headers=auth(t))
    assert r.status_code == 200, r.text
    assert r.json()["created"] is False
