"""Ablage: Rennen, Namensfaltung, Sicht-Tor und Ordner-Kaskade.

Deckt die Befunde des Bughunts vom 17.08.2026 ab, die in ``routes/dropbox.py``
und ``routes/_dropbox_helpers.py`` behoben wurden. Was jeder Test wirklich
herstellt, steht in seinem eigenen Docstring — bei einem Rennen ist genau das
die entscheidende Frage.

Bewusst eigene Datei: ``test_dropbox.py`` liegt bei über 2000 Zeilen.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import event, select

from dcc_chat_gateway import s3 as s3_mod
from dcc_chat_gateway.models import (
    DROPBOX_KIND_FILE,
    DROPBOX_KIND_FOLDER,
    DropboxConfig,
    DropboxFile,
    Guild,
    PermissionOverwrite,
)
from dcc_chat_gateway.permissions import Permissions
from dcc_chat_gateway.routes._dropbox_helpers import validate_name
from dcc_chat_gateway.routes._dropbox_writes import perform_restore, perform_trash
from dcc_chat_gateway.snowflake import next_id


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _user(_auth_signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


@pytest.fixture(autouse=True)
def _dropbox_unlocked_by_default():
    """Jede neue Community startet hier mit freigeschalteter Ablage — gleiche
    Abwägung wie in ``test_dropbox.py``."""

    def _unlock(_mapper, _connection, target):
        target.dropbox_allowed = True

    event.listen(Guild, "before_insert", _unlock)
    yield
    event.remove(Guild, "before_insert", _unlock)


@pytest.fixture(autouse=True)
def _stub_s3(monkeypatch):
    """``serialize_entry`` mintet für jede Datei eine signierte Adresse. Ohne
    Stub liefe das gegen ein echtes MinIO."""

    async def _url(key, *, filename=None, inline=True):
        return f"https://mock/{key}"

    async def _delete(key):
        return None

    monkeypatch.setattr(s3_mod, "presigned_get_url", _url)
    monkeypatch.setattr(s3_mod, "delete_object", _delete)


@pytest_asyncio.fixture
async def unique_name_index(engine):
    """Den partiellen Unique-Index aus Migration 0043 in die Test-Datenbank
    nachziehen.

    **Wichtig fürs Verständnis der Testlage:** ``models/dropbox.py`` führt
    diesen Index nicht in ``__table_args__``. Die Testschemata entstehen aber
    über ``Base.metadata.create_all`` — der Index, der in Produktion die
    Namenskollision entscheidet, existiert dort also gar nicht. Ohne diese
    Fixture liefe der Kollisionstest ins Leere und behauptete grün, was in
    Produktion ein anderer Code-Pfad ist."""

    async with engine.begin() as conn:
        await conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_dropbox_files_unique_name "
            "ON dropbox_files (guild_id, parent_path, name) "
            "WHERE deleted_at IS NULL"
        )
    return True


async def _create_guild(client, token: str) -> dict:
    r = await client.post("/guilds", json={"name": "g"}, headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()


async def _provision(client, token: str, gid: str) -> int:
    """Ablage-Kanal + Konfigurationszeile anlegen. Gibt die Kanalkennung."""

    r = await client.get(f"/guilds/{gid}/dropbox/channel", headers=auth(token))
    assert r.status_code == 200, r.text
    return int(r.json()["id"])


async def _seed(
    session_factory,
    *,
    gid: str,
    channel_id: int,
    owner_id: int,
    name: str,
    parent_path: str = "",
    size: int | None = None,
) -> int:
    """Eine Zeile direkt anlegen (Datei mit ``size``, sonst Ordner) und das
    Kontingent so buchen, wie es ein echter Upload täte."""

    now = datetime.now(timezone.utc)
    entry_id = next_id()
    async with session_factory() as s:
        s.add(
            DropboxFile(
                id=entry_id,
                guild_id=int(gid),
                channel_id=channel_id,
                parent_path=parent_path,
                name=name,
                kind=DROPBOX_KIND_FILE if size is not None else DROPBOX_KIND_FOLDER,
                size_bytes=size,
                content_type="text/plain" if size is not None else None,
                storage_key=f"dropbox/{gid}/.o/{entry_id}" if size is not None else None,
                version=1,
                uploaded_by_id=owner_id,
                uploaded_at=now,
                updated_at=now,
                pinned=False,
            )
        )
        if size:
            cfg = await s.get(DropboxConfig, int(gid))
            cfg.used_bytes += size
        await s.commit()
    return entry_id


async def _used_bytes(session_factory, gid: str) -> int:
    async with session_factory() as s:
        cfg = await s.get(DropboxConfig, int(gid))
        return int(cfg.used_bytes)


async def _row(session_factory, entry_id: int) -> DropboxFile | None:
    async with session_factory() as s:
        return await s.get(DropboxFile, entry_id)


# ─── Befund 2: Namensfaltung vor der Prüfung ────────────────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        "\uff0e\uff0e",  # FULLWIDTH FULL STOP  → ".."
        "\u2024\u2024",  # ONE DOT LEADER       → ".."
        "\uff0e\uff0e\uff0fevil.txt",  # → "../evil.txt"
        "a\uff0fb",  # FULLWIDTH SOLIDUS → echter Schrägstrich
        "\u3000name",  # IDEOGRAPHIC SPACE → führendes Leerzeichen
        ".\u200b.",  # Zero-Width dazwischen → ".."
        "boot\r\n.txt",  # Steuerzeichen
    ],
)
def test_validate_name_prueft_die_gespeicherte_form(raw: str):
    """Sicherheitszusage: kein Eingabename darf zu einem gespeicherten Namen
    werden, der ``..`` ist, einen echten Schrägstrich trägt oder Steuerzeichen
    enthält.

    Der alte Code normalisierte erst den Rückgabewert; alle sieben Fälle hier
    kamen deshalb an den Prüfungen vorbei und wurden in ihrer gefährlichen
    Form gespeichert — und von ``dropbox_downloads.py`` wörtlich als
    ZIP-Eintragsname geschrieben."""

    with pytest.raises(ValueError):
        validate_name(raw)


def test_validate_name_laesst_harmlose_namen_durch():
    """Gegenprobe: die Faltung darf gewöhnliche Namen nicht wegwerfen."""

    assert validate_name("Urlaub 2026.txt") == "Urlaub 2026.txt"
    assert validate_name(".env") == ".env"
    assert validate_name("東京.png") == "東京.png"
    # NFKC faltet Kompatibilitätszeichen — das ist gewollt und war schon vorher so.
    assert validate_name("\uff41\uff42") == "ab"


def test_validate_name_ist_idempotent():
    """Der Rückgabewert muss die Prüfung ein zweites Mal bestehen — sonst
    stünde derselbe Name in zwei Schreibweisen vor dem Unique-Index."""

    for raw in ("Urlaub 2026.txt", ".env", "\uff41\uff42", "e\u200d\u0301"):
        once = validate_name(raw)
        assert validate_name(once) == once


@pytest.mark.asyncio
async def test_ordner_mit_vollbreiten_punkten_wird_abgelehnt(
    client, _auth_signer
):
    """Derselbe Fall über die Route — 422 statt eines gespeicherten ``..``."""

    token, _uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    await _provision(client, token, gid)

    r = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "．．", "parent_path": ""},
        headers=auth(token),
    )
    assert r.status_code == 422, r.text


# ─── Befund 5: VIEW_CHANNEL am Ablage-Kanal ─────────────────────────────────


@pytest.mark.asyncio
async def test_mitglied_ohne_view_channel_sieht_die_ablage_nicht(
    client, _auth_signer, second_member, session_factory
):
    """Der Ablage-Kanal ist der Rechteanker. Ein Mitglied der Community, dem
    genau dieser Kanal verboten ist, darf weder Liste noch Kontingent sehen —
    und zwar mit 404, damit das Statuspaar nicht verrät, dass es hier etwas zu
    sehen gäbe.

    Der Ereignisweg (``pubsub_channel_guild.py``) filtert dieselben Daten seit
    jeher; geprüft wird hier die zweite, bis dahin fehlende Stelle."""

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)
    await _seed(
        session_factory,
        gid=gid,
        channel_id=channel_id,
        owner_id=uid,
        name="geheim.txt",
        size=100,
    )

    fremd_token, fremd_uid = await _user(_auth_signer)
    await second_member(int(gid), fremd_uid)
    async with session_factory() as s:
        s.add(
            PermissionOverwrite(
                channel_id=channel_id,
                target_id=fremd_uid,
                target_type=1,  # 1 = Nutzer
                allow_bf=0,
                deny_bf=int(Permissions.VIEW_CHANNEL),
            )
        )
        await s.commit()

    liste = await client.get(
        f"/guilds/{gid}/dropbox/entries", headers=auth(fremd_token)
    )
    assert liste.status_code == 404, liste.text
    quota = await client.get(
        f"/guilds/{gid}/dropbox/quota", headers=auth(fremd_token)
    )
    assert quota.status_code == 404, quota.text

    # Gegenprobe: der Besitzer sieht sie weiterhin.
    ok = await client.get(f"/guilds/{gid}/dropbox/entries", headers=auth(token))
    assert ok.status_code == 200, ok.text


# ─── Befund 1 + 3: Kontingent-Rennen ────────────────────────────────────────


@pytest.mark.asyncio
async def test_zweimal_papierkorb_bucht_nur_einmal_ab(
    client, _auth_signer, session_factory
):
    """**Wie das Rennen hergestellt wird:** zwei Sitzungen lesen denselben
    Eintrag, beide sehen ihn als lebend — genau der Zustand, in dem zwei
    parallele HTTP-Anfragen nach ihrem SELECT stehen, bevor eine von beiden
    bucht. Danach laufen beide durch ``perform_trash``.

    Der Test braucht keine echte Gleichzeitigkeit, weil der Fehler nicht am
    Zeitpunkt hing, sondern an der veralteten Kopie: der alte Code schrieb
    ``entry.deleted_at`` aus der eigenen Kopie und buchte bedingungslos ab,
    also ein zweites Mal. Das bedingte UPDATE lässt nur einen gewinnen."""

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)
    fid = await _seed(
        session_factory,
        gid=gid,
        channel_id=channel_id,
        owner_id=uid,
        name="a.bin",
        size=500,
    )
    assert await _used_bytes(session_factory, gid) == 500

    async with session_factory() as s1, session_factory() as s2:
        e1 = await s1.get(DropboxFile, fid)
        e2 = await s2.get(DropboxFile, fid)
        assert e1.deleted_at is None and e2.deleted_at is None

        await perform_trash(s1, guild_id=int(gid), entry=e1, actor_id=uid)
        with pytest.raises(HTTPException) as verloren:
            await perform_trash(s2, guild_id=int(gid), entry=e2, actor_id=uid)
        assert verloren.value.status_code == 404

    assert await _used_bytes(session_factory, gid) == 0


@pytest.mark.asyncio
async def test_zweimal_wiederherstellen_schreibt_nur_einmal_gut(
    client, _auth_signer, session_factory
):
    """Spiegelbild zum Löschweg, gleiche Herstellung: zwei Sitzungen halten
    denselben Papierkorb-Eintrag, beide sehen ihn als gelöscht."""

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)
    fid = await _seed(
        session_factory,
        gid=gid,
        channel_id=channel_id,
        owner_id=uid,
        name="a.bin",
        size=500,
    )
    r = await client.delete(
        f"/guilds/{gid}/dropbox/entries/{fid}", headers=auth(token)
    )
    assert r.status_code == 204, r.text
    assert await _used_bytes(session_factory, gid) == 0

    async with session_factory() as s1, session_factory() as s2:
        e1 = await s1.get(DropboxFile, fid)
        e2 = await s2.get(DropboxFile, fid)
        assert e1.deleted_at is not None and e2.deleted_at is not None

        await perform_restore(s1, guild_id=int(gid), entry=e1)
        with pytest.raises(HTTPException) as verloren:
            await perform_restore(s2, guild_id=int(gid), entry=e2)
        assert verloren.value.status_code == 404

    assert await _used_bytes(session_factory, gid) == 500


# ─── Befund 4: Namenskollision im Rennen ────────────────────────────────────


@pytest.mark.asyncio
async def test_kollision_nach_bestandener_vorpruefung_gibt_409(
    client, _auth_signer, session_factory, monkeypatch, unique_name_index
):
    """**Wie das Rennen hergestellt wird:** in das Fenster zwischen
    Kollisionsprüfung und Commit legt der Test die konkurrierende Zeile hinein
    — über eine eigene Sitzung, aus ``_get_or_create_dropbox_channel`` heraus
    (die einzige Await-Stelle dazwischen). Die Anfrage hat ihre Prüfung dann
    nachweislich bestanden und läuft trotzdem in einen belegten Namen.

    Bewusst ohne ``asyncio.gather``: die Testdatenbank ist ein einziges
    SQLite-``:memory:`` an einem ``StaticPool``, zwei gleichzeitige Sitzungen
    teilen sich also dieselbe Verbindung und damit dieselbe Transaktion — ein
    ``rollback`` der einen risse die andere mit, und der Test misse das
    Prüfgerüst statt den Code. Der eingespielte Fremdschreiber erzeugt
    denselben Endzustand deterministisch.

    Gegen den alten Stand ist dieser Test rot (dort schlägt die
    ``IntegrityError`` als unbehandelter 500er durch) — vorausgesetzt, der
    Unique-Index aus Migration 0043 existiert. Genau den zieht die Fixture
    ``unique_name_index`` nach: ``models/dropbox.py`` führt ihn nicht, und die
    Testschemata entstehen über ``create_all``."""

    import dcc_chat_gateway.routes.dropbox as dropbox_mod

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)

    echt = dropbox_mod._get_or_create_dropbox_channel
    gelegt = False

    async def dazwischen(*args, **kwargs):
        nonlocal gelegt
        if not gelegt:
            gelegt = True
            await _seed(
                session_factory,
                gid=gid,
                channel_id=channel_id,
                owner_id=uid,
                name="Doppelt",
            )
        return await echt(*args, **kwargs)

    monkeypatch.setattr(dropbox_mod, "_get_or_create_dropbox_channel", dazwischen)

    r = await client.post(
        f"/guilds/{gid}/dropbox/folders",
        json={"name": "Doppelt", "parent_path": ""},
        headers=auth(token),
    )
    assert r.status_code == 409, r.text
    assert "already exists" in r.json()["detail"]


# ─── Befund 6: Ordner-Kaskade ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ordner_in_den_papierkorb_nimmt_den_teilbaum_mit(
    client, _auth_signer, session_factory
):
    """Ohne Kaskade blieben die Kinder als lebende Zeilen unter einem
    Elternpfad zurück, den keine Ansicht mehr betreten kann — und nach dem
    endgültigen Purge des Ordners als unerreichbare, aber weiter
    kontingent-belastende Datenleichen."""

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)
    seed = dict(session_factory=session_factory, gid=gid, channel_id=channel_id, owner_id=uid)

    ordner = await _seed(**seed, name="Album")
    unterordner = await _seed(**seed, name="Tief", parent_path="Album")
    kind = await _seed(**seed, name="a.bin", parent_path="Album", size=300)
    enkel = await _seed(**seed, name="b.bin", parent_path="Album/Tief", size=200)
    # Ein Nachbar, dessen Name ein LIKE-Platzhalter ist — er darf NICHT
    # mitgerissen werden (``_`` ist in LIKE ein Joker).
    nachbar_ordner = await _seed(**seed, name="Alb_m")
    nachbar_datei = await _seed(**seed, name="c.bin", parent_path="Alb_m", size=100)
    assert await _used_bytes(session_factory, gid) == 600

    r = await client.delete(
        f"/guilds/{gid}/dropbox/entries/{ordner}", headers=auth(token)
    )
    assert r.status_code == 204, r.text

    for eid in (ordner, unterordner, kind, enkel):
        assert (await _row(session_factory, eid)).deleted_at is not None
    for eid in (nachbar_ordner, nachbar_datei):
        assert (await _row(session_factory, eid)).deleted_at is None
    # 300 + 200 abgebucht, die 100 des Nachbarn bleiben stehen.
    assert await _used_bytes(session_factory, gid) == 100

    # Zurückholen bringt genau denselben Teilbaum wieder.
    r = await client.post(
        f"/guilds/{gid}/dropbox/entries/{ordner}/restore", headers=auth(token)
    )
    assert r.status_code == 200, r.text
    for eid in (ordner, unterordner, kind, enkel):
        assert (await _row(session_factory, eid)).deleted_at is None
    assert await _used_bytes(session_factory, gid) == 600


@pytest.mark.asyncio
async def test_vorher_einzeln_geloeschtes_kind_bleibt_im_papierkorb(
    client, _auth_signer, session_factory
):
    """Die Kaskade erkennt ihren Teilbaum am gemeinsamen Zeitstempel. Ein
    Kind, das der Nutzer vorher einzeln weggelegt hat, trägt einen anderen —
    und soll beim Zurückholen des Ordners liegen bleiben, so wie abgelegt."""

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)
    seed = dict(session_factory=session_factory, gid=gid, channel_id=channel_id, owner_id=uid)

    ordner = await _seed(**seed, name="Album")
    frueh = await _seed(**seed, name="alt.bin", parent_path="Album", size=100)
    spaet = await _seed(**seed, name="neu.bin", parent_path="Album", size=200)

    assert (
        await client.delete(
            f"/guilds/{gid}/dropbox/entries/{frueh}", headers=auth(token)
        )
    ).status_code == 204
    assert (
        await client.delete(
            f"/guilds/{gid}/dropbox/entries/{ordner}", headers=auth(token)
        )
    ).status_code == 204
    assert await _used_bytes(session_factory, gid) == 0

    assert (
        await client.post(
            f"/guilds/{gid}/dropbox/entries/{ordner}/restore", headers=auth(token)
        )
    ).status_code == 200

    assert (await _row(session_factory, spaet)).deleted_at is None
    assert (await _row(session_factory, frueh)).deleted_at is not None
    assert await _used_bytes(session_factory, gid) == 200


@pytest.mark.asyncio
async def test_papierkorb_leeren_raeumt_den_kaskadierten_teilbaum(
    client, _auth_signer, session_factory
):
    """Nach der Kaskade steht der ganze Teilbaum im Papierkorb — das
    Leeren muss ihn vollständig abräumen, sonst bleiben genau die Zeilen
    zurück, die der Befund beschreibt."""

    token, uid = await _user(_auth_signer)
    gid = (await _create_guild(client, token))["id"]
    channel_id = await _provision(client, token, gid)
    seed = dict(session_factory=session_factory, gid=gid, channel_id=channel_id, owner_id=uid)

    ordner = await _seed(**seed, name="Album")
    await _seed(**seed, name="a.bin", parent_path="Album", size=300)

    assert (
        await client.delete(
            f"/guilds/{gid}/dropbox/entries/{ordner}", headers=auth(token)
        )
    ).status_code == 204
    assert (
        await client.post(f"/guilds/{gid}/dropbox/trash/empty", headers=auth(token))
    ).status_code == 200

    async with session_factory() as s:
        rest = list(
            (
                await s.execute(
                    select(DropboxFile).where(DropboxFile.guild_id == int(gid))
                )
            ).scalars()
        )
    assert rest == [], f"übrig: {[(r.id, r.name) for r in rest]}"
    assert await _used_bytes(session_factory, gid) == 0
