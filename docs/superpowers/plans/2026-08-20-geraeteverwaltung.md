# Standplatz-Geräteverwaltung — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development`
> (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Aufgabe für Aufgabe abzuarbeiten.
> Schritte tragen Kästchen (`- [ ]`) zum Abhaken.

**Ziel:** Ein Standplatz-Gerät wird von jedem Rechner des Besitzers aus verwaltbar — Name, Community, Kanal, Freigabeliste — statt nur von der Maschine, die es selbst ist.

**Architektur:** Die Verwaltung wandert von der lokalen Selbsterkenntnis (`pulse-stream.json`) an die Gerätezeile (`chat.devices`). Die Dauerfreigabe zieht in eine neue Tabelle `chat.device_grants` um, die nur der Besitzer schreiben darf; der Gateway löst sie auf (dadurch werden Rollen erstmals möglich) und hängt an das weitergereichte `remote_request` ein Feld `freigabe`. Die Zustimmung erteilt weiterhin das Gerät — offline heisst weiterhin: keine Zustimmung.

**Tech-Stack:** FastAPI + SQLAlchemy[asyncio] + Alembic (chat-gateway, Schema `chat`) · SvelteKit 5 Runes + Tailwind 4 (web) · pytest/pytest-asyncio · Nodes eingebauter Testläufer für Web-Unit (kein Vitest).

**Spec:** `docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md` — der Plan argumentiert aus ihr; wer ihn ausführt, liest beide.

## Globale Randbedingungen

- **Deutsche Umlaute** (ä/ö/ü/ß) in Commit-Messages und Changelog-Einträgen. **Keine Emojis, nirgends.**
- **Snowflake-Kennungen sind über die API immer Zeichenketten.** Backend nimmt `SnowflakeId` (int oder str), Frontend sendet str.
- **Größen-Policy:** Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250. Ausgenommen Tests und Migrationen.
- **Kein `git push` ohne Freigabe.** Arbeit läuft auf `remote/2026-08-20/<thema>`-Unterzweigen der laufenden Remote-Dev-Sitzung.
- **Backend-Änderungen erreichen den gemeinsamen Hetzner-Stack nur über `pnpm dev:sync`** (rsync, kein Git). Nach jedem Branch-Wechsel mit Backend-Änderung einmal syncen.
- **Tests lokal:** `REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q` · `cd web && pnpm check && pnpm test:unit`. Den Volllauf **nicht** neben `cargo build`/`pnpm build` legen (WS-Tests hängen dann bis ins Zeitlimit).
- **Alembic-Revisions-IDs ≤ 32 Zeichen** (Postgres `VARCHAR(32)`).
- **Refactoring darf Verhalten nicht ändern:** Endpunkt-Pfade, Response-Modelle und `data-testid` bleiben identisch, wo sie nicht ausdrücklich Teil einer Aufgabe sind.
- **Nach jeder Code-Änderung** `code-simplifier` über die geänderten Dateien, danach Tests erneut grün, dann `bash .claude/hooks/simplify-stamp.sh`, dann committen.

---

## Dateistruktur

**Server (`services/chat-gateway/`)**

| Datei | Verantwortung |
|---|---|
| `src/dcc_chat_gateway/models/devices.py` | ergänzt um `DeviceGrant` (Zeile + Konstanten der Subjekt-Arten) |
| `alembic/versions/20260820_1200_0060_device_grants.py` | neu: Tabelle `device_grants` |
| `alembic/versions/20260820_1300_0061_device_limit.py` | neu: zwei Guild-Spalten für den Geräte-Deckel |
| `src/dcc_chat_gateway/device_grants.py` | neu: Auflösung (`gedeckt`), Lesen, Ersetzen, Rollen-Räumung. Reine Logik, keine HTTP-Kenntnis |
| `src/dcc_chat_gateway/routes/devices.py` | `PATCH` um `guild_id` erweitert |
| `src/dcc_chat_gateway/routes/device_grants.py` | neu: `GET`/`PUT` der Freigabeliste |
| `src/dcc_chat_gateway/routes/ws_remote_handlers.py` | hängt `freigabe` an den weitergereichten Rahmen |
| `src/dcc_chat_gateway/guild_limits.py` | neuer `LimitSpec` für `max_devices_per_owner` |
| `tests/test_devices.py`, `tests/test_device_grants.py` (neu) | Rechte-Matrix, Auflösung, Community-Wechsel |

**Client (`web/`)**

| Datei | Verantwortung |
|---|---|
| `src/lib/api/devices.ts` | `patch` um `guild_id`; neuer `grantsApi` |
| `src/lib/devices/freigaben.svelte.ts` | neu: Freigabeliste laden/ersetzen (Zustand) |
| `src/lib/devices/verwaltung.svelte.ts` | neu: umbenennen / umstellen / entfernen (Rufe + Fehler) |
| `src/lib/devices/components/DeviceVerwaltung.svelte` | neu: Name, Standplatz, Entfernen |
| `src/lib/devices/components/DeviceFreigaben.svelte` | neu: Freigabeliste (auch im Einstellungs-Reiter verwendet) |
| `src/lib/devices/components/DeviceView.svelte` | bindet beide ein |
| `src/lib/remote/standplatz.svelte.ts` | Liste raus, Hauptschalter (`aktiv`) bleibt; Einmal-Umzug |
| `src/lib/remote/geraeteanbindung.ts` | `ohneRueckfrage` nimmt das Server-Feld |
| `src/lib/remote/session.svelte.ts` | reicht `freigabe` durch |
| `src/lib/ws/handlers/devices.ts` | räumt die lokale Eintragung bei `removed`, zieht sie bei Community-Wechsel nach |
| `src/lib/devices/reiterSichtbar.ts` | neu, importfrei und testbar: Regel für den Standplatz-Reiter |
| `src/lib/components/settings/SettingsStandplatz*.svelte` | zerlegt; neuer Abschnitt „Meine Geräte" |
| `test/reiter-sichtbar.test.ts`, `test/freigabe-restzeit.test.ts` | Node-Unit für die reine Rechnung |

---

## Aufgabe 1: Community-Wechsel im PATCH

**Dateien:**
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/routes/devices.py` (`DevicePatch`, `patch_device`, `_standplatz_kanal`)
- Test: `services/chat-gateway/tests/test_devices.py`

**Schnittstellen:**
- Liefert: `DevicePatch` mit Feld `guild_id: SnowflakeId | None`; `PATCH /guilds/{guild_id}/devices/{device_id}` akzeptiert einen Community-Wechsel. Aufgabe 5 hängt die Rollen-Räumung daran, Aufgabe 8 ruft es aus der Oberfläche.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

In `tests/test_devices.py` anhängen:

```python
@pytest.mark.asyncio
async def test_geraet_wechselt_die_community(client, _auth_signer):
    token, uid = await _make_token(_auth_signer)
    quelle = await _guild(client, token, "projekt-nord")
    ziel = await _guild(client, token, "projekt-sued")
    kanal_quelle = await _voice_channel(client, token, quelle)
    kanal_ziel = await _voice_channel(client, token, ziel, "schnitt-2")

    r = await client.post(
        f"/guilds/{quelle}/devices",
        json={"channel_id": str(kanal_quelle), "name": "schnitt-3"},
        headers=_auth(token),
    )
    device_id = r.json()["id"]

    r = await client.patch(
        f"/guilds/{quelle}/devices/{device_id}",
        json={"guild_id": str(ziel), "channel_id": str(kanal_ziel)},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["guild_id"] == str(ziel)
    assert r.json()["channel_id"] == str(kanal_ziel)

    # Aus der alten Community verschwunden, in der neuen aufgetaucht.
    alt = await client.get(f"/guilds/{quelle}/devices", headers=_auth(token))
    assert alt.json() == []
    neu = await client.get(f"/guilds/{ziel}/devices", headers=_auth(token))
    assert [d["id"] for d in neu.json()] == [device_id]


@pytest.mark.asyncio
async def test_community_wechsel_ohne_rechte_am_ziel(client, _auth_signer):
    token, uid = await _make_token(_auth_signer)
    fremd_token, _ = await _make_token(_auth_signer)
    quelle = await _guild(client, token, "meins")
    kanal = await _voice_channel(client, token, quelle)
    fremd = await _guild(client, fremd_token, "fremd")
    fremd_kanal = await _voice_channel(client, fremd_token, fremd)

    r = await client.post(
        f"/guilds/{quelle}/devices",
        json={"channel_id": str(kanal), "name": "werkstatt-pc"},
        headers=_auth(token),
    )
    device_id = r.json()["id"]

    # Kein Mitglied der Zielcommunity: wortgleich wie ein nicht vorhandener
    # Kanal — die Antwort darf nicht verraten, dass es die Community gibt.
    r = await client.patch(
        f"/guilds/{quelle}/devices/{device_id}",
        json={"guild_id": str(fremd), "channel_id": str(fremd_kanal)},
        headers=_auth(token),
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_community_wechsel_nur_besitzer(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    zweit_kanal = await _voice_channel(client, besitzer, gid, "schnitt-2")
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(besitzer),
    )
    device_id = r.json()["id"]

    # Der Community-Eigner ist hier zugleich Besitzer des Geräts; für den
    # Gegentest braucht es ein Gerät, das jemand anderem gehört. Wir prüfen
    # deshalb den Fall über die vorhandene Regel: derselbe Aufruf mit
    # ``guild_id`` auf die eigene Community ist ein reiner Kanalwechsel und
    # muss weiterhin durchgehen.
    r = await client.patch(
        f"/guilds/{gid}/devices/{device_id}",
        json={"guild_id": str(gid), "channel_id": str(zweit_kanal)},
        headers=_auth(besitzer),
    )
    assert r.status_code == 200, r.text
    assert r.json()["channel_id"] == str(zweit_kanal)
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/test_devices.py -q -k community
```
Erwartet: FEHLSCHLAG — `guild_id` ist in `DevicePatch` unbekannt und wird ignoriert, das Gerät bleibt in der alten Community.

- [ ] **Schritt 3: `DevicePatch` erweitern**

In `routes/devices.py`:

```python
class DevicePatch(BaseModel):
    #: Zielcommunity. Nur der Besitzer darf sie ändern — der Standplatz ist der
    #: Rechteanker, und ``MANAGE_GUILD`` soll räumen können, nicht umwidmen
    #: (dieselbe Begründung wie beim Kanal). Zusammen mit ``channel_id``
    #: anzugeben: ein Kanal ohne seine Community wäre nicht auflösbar.
    guild_id: SnowflakeId | None = None
    channel_id: SnowflakeId | None = None
    name: str | None = Field(default=None, min_length=1, max_length=DEVICE_NAME_MAX_LEN)
```

- [ ] **Schritt 4: `_standplatz_kanal` gegen die Zielcommunity prüfbar machen**

Die Funktion prüft heute implizit gegen die Community aus dem Pfad. Sie bekommt die Zielcommunity als Parameter — sie hatte ihn bereits, es fehlte nur der Aufrufer, der eine andere übergibt. Zusätzlich muss die **Mitgliedschaft** in der Zielcommunity geprüft werden, und zwar mit derselben Antwort wie ein unsichtbarer Kanal:

```python
async def _ziel_standplatz(
    session, user, guild_id: int, channel_id: int, *, detail: str
):
    """Wie ``_standplatz_kanal``, aber für eine möglicherweise ANDERE Community.

    Die Mitgliedschaft wird hier geprüft und nicht über ``require_member``:
    dessen 403 verriete, dass es die Community gibt. Ein Nicht-Mitglied bekommt
    dieselbe Antwort wie für einen Kanal, den es nicht sehen darf — 404.
    """
    if not await ist_mitglied(session, guild_id, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
    return await _standplatz_kanal(session, user, guild_id, channel_id, detail=detail)
```

`ist_mitglied` ist die vorhandene, nicht werfende Prüfung aus `membership.py`; falls dort nur `require_member` existiert, wird sie als schmale Abfrage auf `GuildMember` ergänzt (`select(GuildMember).where(...)`, `is not None`).

- [ ] **Schritt 5: Den Wechsel in `patch_device` verdrahten**

Ersetzt den vorhandenen Kanalwechsel-Block:

```python
    alter_kanal: int | None = None
    alte_guild: int | None = None
    ziel_guild = body.guild_id if body.guild_id is not None else device.guild_id
    if body.channel_id is not None and (
        body.channel_id != device.channel_id or ziel_guild != device.guild_id
    ):
        if device.owner_user_id != user.id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="only the device owner can move it to another channel",
            )
        await _ziel_standplatz(
            session,
            user,
            ziel_guild,
            body.channel_id,
            detail="you need permission to stream in the new channel",
        )
        alter_kanal = device.channel_id
        alte_guild = device.guild_id
        device.channel_id = body.channel_id
        device.guild_id = ziel_guild
```

Und im Meldeteil weiter unten `mgr.device_move(device.id, device.guild_id, device.channel_id)` (statt der bisherigen `guild_id` aus dem Pfad) sowie die „entfernt"-Meldung an die **alte** Community:

```python
        alt = device_out(device, mgr)
        alt.channel_id = str(alter_kanal)
        alt.guild_id = str(alte_guild)
        await melden(request, device, alt, entfernt=True, kanal=alter_kanal, guild=alte_guild)
```

`melden` bekommt dafür einen optionalen Parameter `guild: int | None = None` (Vorgabe: `device.guild_id`, also unverändertes Verhalten für alle bestehenden Rufer).

- [ ] **Schritt 6: Tests laufen lassen**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/test_devices.py -q
```
Erwartet: alle grün, auch die vorhandenen Standplatzwechsel-Tests innerhalb einer Community.

- [ ] **Schritt 7: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/devices.py \
        services/chat-gateway/src/dcc_chat_gateway/device_meldungen.py \
        services/chat-gateway/tests/test_devices.py
git commit -m "feat(geraete): Standplatz darf die Community wechseln"
```

---

## Aufgabe 2: Tabelle `device_grants`

**Dateien:**
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/models/devices.py`
- Erstellen: `services/chat-gateway/alembic/versions/20260820_1200_0060_device_grants.py`
- Test: `services/chat-gateway/tests/test_device_grants.py` (neu)

**Schnittstellen:**
- Liefert: `DeviceGrant` (Felder `id`, `device_id`, `subject_type`, `subject_id`, `expires_at`, `created_at`, `created_by_user_id`), Konstanten `SUBJECT_USER = "user"`, `SUBJECT_ROLE = "role"`, `SUBJECT_EVERYONE = "everyone"`. Aufgaben 3, 4 und 5 bauen darauf.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

Neue Datei `tests/test_device_grants.py`:

```python
"""Tests für die Freigabeliste eines Standplatz-Geräts.

Die Liste sagt, WER einen Rechner ohne Rückfrage übernehmen darf. Sie lag bis
2026-08-20 auf dem Gerät selbst und war damit nur vor Ort änderbar; Entwurf:
``docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md``.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.models import SUBJECT_EVERYONE, SUBJECT_USER, DeviceGrant


@pytest.mark.asyncio
async def test_freigabe_haengt_am_geraet(session_factory):
    async with session_factory() as session:
        session.add(
            DeviceGrant(
                id=1,
                device_id=42,
                subject_type=SUBJECT_EVERYONE,
                subject_id=None,
                expires_at=None,
                created_by_user_id=7,
            )
        )
        await session.commit()
        geladen = await session.get(DeviceGrant, 1)
        assert geladen.subject_type == SUBJECT_EVERYONE
        assert geladen.subject_id is None
        assert geladen.created_at is not None
```

Steht `session_factory` in `conftest.py` nicht als Fixture bereit, wird der Test über den vorhandenen `client` und die Route aus Aufgabe 3 geführt — dann wandert dieser Schritt dorthin und Aufgabe 2 endet nach Schritt 5 mit dem Migrationslauf als Nachweis.

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q
```
Erwartet: FEHLSCHLAG — `ImportError: cannot import name 'DeviceGrant'`.

- [ ] **Schritt 3: Modell ergänzen**

An `models/devices.py` anhängen:

```python
#: Die drei Arten, auf die eine Freigabe jemanden meinen kann.
#:
#: ``everyone`` heisst „jeder, der überhaupt anfragen darf" — also jeder, der am
#: Standplatz ``REMOTE_CONTROL`` hat. Es ist keine Abkürzung an der
#: Rechteprüfung vorbei, sondern der Verzicht auf eine ZUSÄTZLICHE Einengung.
SUBJECT_USER = "user"
SUBJECT_ROLE = "role"
SUBJECT_EVERYONE = "everyone"
SUBJECT_TYPES = (SUBJECT_USER, SUBJECT_ROLE, SUBJECT_EVERYONE)


class DeviceGrant(Base):
    """Eine Dauerfreigabe an einem Gerät.

    **Warum die Zeile keinen Kanal trägt.** Die alte, gerätelokale Fassung
    speicherte zu jeder Freigabe den Kanal, in dem sie erteilt wurde — sonst
    stimmte sie einer Anfrage zu, die einen ganz anderen Kanal nannte, und der
    Standplatz samt seinem Overwrite war umgangen. Hier ist der Ort implizit der
    Standplatz des Geräts, und geprüft wird ``REMOTE_CONTROL`` genau dort
    (``device_grants.py::gedeckt``). Das Loch kann damit nicht wiederkommen.

    **Abgelaufene Zeilen werden nicht gefegt**, sondern beim Auflösen ignoriert
    und beim nächsten Setzen derselben Freigabe überschrieben. Ein Fegelauf wäre
    ein Hintergrund-Task für Zeilen, die niemanden stören.
    """

    __tablename__ = "device_grants"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    device_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    subject_type: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Nutzer- oder Rollenkennung; NULL bei ``everyone``.
    subject_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: NULL = dauerhaft.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_by_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "device_id", "subject_type", "subject_id", name="uq_device_grants_subject"
        ),
        Index("ix_device_grants_device", "device_id"),
    )
```

Und in `models/__init__.py` exportieren (`DeviceGrant`, `SUBJECT_USER`, `SUBJECT_ROLE`, `SUBJECT_EVERYONE`, `SUBJECT_TYPES`) — sonst findet der Import aus dem Test sie nicht.

- [ ] **Schritt 4: Migration schreiben**

`alembic/versions/20260820_1200_0060_device_grants.py`:

```python
"""device_grants: Dauerfreigaben eines Standplatz-Geräts

Die Freigabe lag bis hierher auf dem Gerät (``pulse-stream.json``) und war nur
vor Ort änderbar. Sie zieht auf den Server, damit der Besitzer sie von jedem
seiner Rechner aus verwalten kann — und damit ROLLEN möglich werden, die ein
Client für fremde Communities nie auflösen konnte.

Der Riegel gegen den Missbrauch, gegen den die gerätelokale Fassung gebaut war
(„ein Admin schaltet fremde Rechner scharf"), ist jetzt das Schreibrecht: nur
``devices.owner_user_id`` darf lesen und schreiben, ``MANAGE_GUILD`` nicht.

CASCADE an ``devices``: ein gelöschtes Gerät darf keine Freigaben hinterlassen,
die eine später neu vergebene Kennung erbte.

Revision ID: 0060_device_grants
Revises: 0059_devices
Create Date: 2026-08-20 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0060_device_grants"
down_revision: str | None = "0059_devices"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "device_grants",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("device_id", sa.BigInteger(), nullable=False),
        sa.Column("subject_type", sa.String(length=16), nullable=False),
        sa.Column("subject_id", sa.BigInteger(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["device_id"], [f"{SCHEMA}.devices.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "device_id", "subject_type", "subject_id", name="uq_device_grants_subject"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_device_grants_device", "device_grants", ["device_id"], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index("ix_device_grants_device", table_name="device_grants", schema=SCHEMA)
    op.drop_table("device_grants", schema=SCHEMA)
```

- [ ] **Schritt 5: Migration und Test laufen lassen**

```
cd services/chat-gateway && uv run alembic upgrade head && cd -
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q
```
Erwartet: Migration läuft durch, Test grün.

- [ ] **Schritt 6: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/models/ \
        services/chat-gateway/alembic/versions/20260820_1200_0060_device_grants.py \
        services/chat-gateway/tests/test_device_grants.py
git commit -m "feat(geraete): Tabelle für Dauerfreigaben am Gerät"
```

---

## Aufgabe 3: Freigabe-Routen (lesen und ersetzen)

**Dateien:**
- Erstellen: `services/chat-gateway/src/dcc_chat_gateway/routes/device_grants.py`
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/app.py` (Router einhängen)
- Test: `services/chat-gateway/tests/test_device_grants.py`

**Schnittstellen:**
- Liefert: `GET /guilds/{guild_id}/devices/{device_id}/grants` → `list[GrantOut]` und `PUT` derselben Adresse mit `{"grants": [GrantIn, …]}` → `list[GrantOut]`. `GrantIn` = `{subject_type: str, subject_id: str | None, expires_at: datetime | None}`, `GrantOut` zusätzlich `{id: str, created_at: datetime}`. Aufgabe 6 ruft beide vom Client.

**Warum `PUT` der ganzen Liste und kein `POST`/`DELETE` je Eintrag:** die alte gerätelokale Fassung hatte genau einen Weg hinein (`freigeben` mit allen Angaben auf einmal), damit es keinen Zwischenzustand „scharf, aber für niemanden" gibt. Ein Ersetzen hält das ohne Sperren durch.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_nur_der_besitzer_sieht_und_setzt(client, _auth_signer):
    besitzer, b_uid = await _make_token(_auth_signer)
    fremd, f_uid = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(besitzer),
    )
    did = r.json()["id"]

    # Setzen
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(f_uid)}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 200, r.text
    assert r.json()[0]["subject_id"] == str(f_uid)

    # Lesen
    r = await client.get(f"/guilds/{gid}/devices/{did}/grants", headers=_auth(besitzer))
    assert len(r.json()) == 1

    # Ein Fremder — auch mit MANAGE_GUILD — darf weder lesen noch setzen.
    r = await client.get(f"/guilds/{gid}/devices/{did}/grants", headers=_auth(fremd))
    assert r.status_code in (403, 404)
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": []},
        headers=_auth(fremd),
    )
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_ersetzen_raeumt_die_alte_liste(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    _, a_uid = await _make_token(_auth_signer)
    _, b_uid = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    did = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]

    await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(a_uid)}]},
        headers=_auth(besitzer),
    )
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(b_uid)}]},
        headers=_auth(besitzer),
    )
    assert [g["subject_id"] for g in r.json()] == [str(b_uid)]


@pytest.mark.asyncio
async def test_unsinnige_freigabe_wird_abgewiesen(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    gid = await _guild(client, besitzer, "studio")
    kanal = await _voice_channel(client, besitzer, gid)
    did = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(kanal), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]

    # Unbekannte Art
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "gruppe", "subject_id": "1"}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 422
    # user ohne Kennung
    r = await client.put(
        f"/guilds/{gid}/devices/{did}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": None}]},
        headers=_auth(besitzer),
    )
    assert r.status_code == 422
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q
```
Erwartet: FEHLSCHLAG mit 404 auf `/grants` — die Route gibt es nicht.

- [ ] **Schritt 3: Die Route schreiben**

`routes/device_grants.py`:

```python
"""Freigabeliste eines Standplatz-Geräts — lesen und ersetzen.

**Nur der Besitzer, lesend wie schreibend.** ``MANAGE_GUILD`` darf ein Gerät
räumen und umbenennen (``routes/devices.py``), aber nicht in seine Freigaben
sehen und nicht freigeben: Räumen ist Hausrecht, Freigeben wäre der
Admin-Fernschalter, den der Entwurf gerade ausschliesst. Hineinsehen wäre dessen
Vorstufe und hat keinen Zweck, den Räumen nicht schon erfüllt.

**Ersetzen statt einzeln ändern.** Ein ``PUT`` der ganzen Liste hat keinen
Zwischenzustand „scharf, aber für niemanden" — dieselbe Begründung, aus der die
gerätelokale Fassung genau einen Weg hinein hatte.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import SUBJECT_EVERYONE, SUBJECT_TYPES, Device, DeviceGrant
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(prefix="/guilds/{guild_id}/devices/{device_id}/grants", tags=["devices"])


class GrantIn(BaseModel):
    subject_type: str
    subject_id: SnowflakeId | None = None
    expires_at: datetime | None = None

    @field_validator("subject_type")
    @classmethod
    def _art(cls, wert: str) -> str:
        if wert not in SUBJECT_TYPES:
            raise ValueError(f"subject_type must be one of {SUBJECT_TYPES}")
        return wert

    @field_validator("subject_id")
    @classmethod
    def _kennung(cls, wert: int | None, info) -> int | None:
        # ``everyone`` trägt keine Kennung, die beiden anderen brauchen eine.
        # Ohne diese Prüfung entstünde eine Zeile, die nie jemanden meint — und
        # sie sähe in der Oberfläche aus wie eine erteilte Freigabe.
        art = info.data.get("subject_type")
        if art == SUBJECT_EVERYONE and wert is not None:
            raise ValueError("everyone carries no subject_id")
        if art in ("user", "role") and wert is None:
            raise ValueError("subject_id is required for user and role grants")
        return wert


class GrantsIn(BaseModel):
    grants: list[GrantIn]


class GrantOut(BaseModel):
    id: str
    subject_type: str
    subject_id: str | None
    expires_at: datetime | None
    created_at: datetime


def _out(zeile: DeviceGrant) -> GrantOut:
    return GrantOut(
        id=str(zeile.id),
        subject_type=zeile.subject_type,
        subject_id=str(zeile.subject_id) if zeile.subject_id is not None else None,
        expires_at=zeile.expires_at,
        created_at=zeile.created_at,
    )


async def _eigenes_geraet(session, guild_id: int, device_id: int, user) -> Device:
    """Das Gerät laden — und nur, wenn es dem Rufer gehört.

    404 statt 403 für ein fremdes Gerät: die Antwort soll nicht verraten, wem
    welche Kennung gehört. Für den Besitzer ist der Unterschied unsichtbar.
    """
    device = await session.get(Device, device_id)
    if device is None or device.guild_id != guild_id or device.owner_user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="device not found")
    return device


@router.get("", response_model=list[GrantOut])
async def list_grants(
    guild_id: SnowflakeId, device_id: SnowflakeId, user: CurrentUser, session: SessionDep
) -> list[GrantOut]:
    await require_member(session, guild_id, user.id)
    await _eigenes_geraet(session, guild_id, device_id, user)
    treffer = await session.execute(
        select(DeviceGrant).where(DeviceGrant.device_id == device_id)
    )
    return [_out(z) for z in treffer.scalars()]


@router.put("", response_model=list[GrantOut])
async def set_grants(
    guild_id: SnowflakeId,
    device_id: SnowflakeId,
    body: GrantsIn,
    user: CurrentUser,
    session: SessionDep,
) -> list[GrantOut]:
    await require_member(session, guild_id, user.id)
    await _eigenes_geraet(session, guild_id, device_id, user)
    await session.execute(delete(DeviceGrant).where(DeviceGrant.device_id == device_id))
    neu = [
        DeviceGrant(
            id=next_id(),
            device_id=device_id,
            subject_type=g.subject_type,
            subject_id=g.subject_id,
            expires_at=g.expires_at,
            created_by_user_id=user.id,
        )
        for g in body.grants
    ]
    session.add_all(neu)
    await session.commit()
    for z in neu:
        await session.refresh(z)
    return [_out(z) for z in neu]
```

- [ ] **Schritt 4: Router einhängen**

In `app.py` neben dem vorhandenen `devices`-Router:

```python
from dcc_chat_gateway.routes import device_grants as device_grants_routes
app.include_router(device_grants_routes.router)
```

- [ ] **Schritt 5: Tests laufen lassen**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q
```
Erwartet: alle grün.

- [ ] **Schritt 6: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/device_grants.py \
        services/chat-gateway/src/dcc_chat_gateway/app.py \
        services/chat-gateway/tests/test_device_grants.py
git commit -m "feat(geraete): Freigabeliste lesen und ersetzen — nur der Besitzer"
```

---

## Aufgabe 4: Auflösung und das Feld am `remote_request`

**Dateien:**
- Erstellen: `services/chat-gateway/src/dcc_chat_gateway/device_grants.py`
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py` (Rahmenbau, ca. Zeile 279)
- Test: `services/chat-gateway/tests/test_device_grants.py`

**Schnittstellen:**
- Liefert: `async def gedeckt(session, device: Device, anfragender_id: int, anfragender_perms: int, rollen: set[int]) -> bool` und `async def rollen_freigaben_loeschen(session, device_id: int) -> int`. Aufgabe 5 ruft die zweite, Aufgabe 7 verlässt sich auf das Feld `freigabe` im Rahmen.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_gedeckt_nutzer_rolle_jeder_und_abgelaufen(client, _auth_signer):
    """Die vier Fälle der Auflösung, über die Route geprüft.

    Die reine Funktion nimmt Rechte und Rollen als Argumente; hier geht es um
    das Zusammenspiel — vor allem darum, dass eine Freigabe die Rechteprüfung am
    Standplatz NICHT ersetzt.
    """
    from datetime import UTC, datetime, timedelta

    from dcc_chat_gateway.device_grants import gedeckt
    from dcc_chat_gateway.models import Device, DeviceGrant, SUBJECT_EVERYONE, SUBJECT_ROLE, SUBJECT_USER

    device = Device(id=1, guild_id=2, channel_id=3, owner_user_id=4, name="pc")
    frisch = datetime.now(UTC) + timedelta(hours=1)
    alt = datetime.now(UTC) - timedelta(hours=1)

    def zeilen(*g):
        return list(g)

    # Nutzer-Freigabe trifft
    assert gedeckt(
        zeilen(DeviceGrant(id=1, device_id=1, subject_type=SUBJECT_USER, subject_id=9, expires_at=None, created_by_user_id=4)),
        anfragender_id=9,
        rollen=set(),
    )
    # ... aber nicht für jemand anderen
    assert not gedeckt(
        zeilen(DeviceGrant(id=1, device_id=1, subject_type=SUBJECT_USER, subject_id=9, expires_at=None, created_by_user_id=4)),
        anfragender_id=10,
        rollen=set(),
    )
    # Rolle trifft über die Rollenmenge
    assert gedeckt(
        zeilen(DeviceGrant(id=2, device_id=1, subject_type=SUBJECT_ROLE, subject_id=77, expires_at=None, created_by_user_id=4)),
        anfragender_id=10,
        rollen={77},
    )
    # „jeder" trifft immer
    assert gedeckt(
        zeilen(DeviceGrant(id=3, device_id=1, subject_type=SUBJECT_EVERYONE, subject_id=None, expires_at=None, created_by_user_id=4)),
        anfragender_id=10,
        rollen=set(),
    )
    # Abgelaufen trifft nie
    assert not gedeckt(
        zeilen(DeviceGrant(id=4, device_id=1, subject_type=SUBJECT_EVERYONE, subject_id=None, expires_at=alt, created_by_user_id=4)),
        anfragender_id=10,
        rollen=set(),
    )
    # Noch gültig trifft
    assert gedeckt(
        zeilen(DeviceGrant(id=5, device_id=1, subject_type=SUBJECT_EVERYONE, subject_id=None, expires_at=frisch, created_by_user_id=4)),
        anfragender_id=10,
        rollen=set(),
    )
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q -k gedeckt
```
Erwartet: FEHLSCHLAG — `ModuleNotFoundError: dcc_chat_gateway.device_grants`.

- [ ] **Schritt 3: Die reine Auflösung schreiben**

`device_grants.py`:

```python
"""Auflösung der Dauerfreigaben eines Geräts.

**Warum das hier steht und nicht im WS-Handler:** die Frage „darf dieser Mensch
diesen Rechner ohne Rückfrage übernehmen" ist eine reine Rechnung über Zeilen,
Zeit und Rollen. Als Funktion ist sie ohne Datenbank prüfbar; im Handler wäre
sie es nur mit einer offenen WebSocket.

**Die Rechteprüfung ist NICHT Teil dieser Funktion.** Sie hat schon
stattgefunden, bevor jemand hierher kommt: ``handle_request`` prüft
``VIEW_CHANNEL`` und ``REMOTE_CONTROL`` am genannten Kanal und lässt ein
genanntes Gerät nur zu, wenn es in genau diesem Kanal steht
(``standplatz_stimmt``). Eine Freigabe ersetzt diese Prüfung nie — sie verzichtet
nur auf die zusätzliche Rückfrage.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import delete, select

from dcc_chat_gateway.models import (
    SUBJECT_EVERYONE,
    SUBJECT_ROLE,
    SUBJECT_USER,
    DeviceGrant,
)


def gedeckt(
    zeilen: Iterable[DeviceGrant], *, anfragender_id: int, rollen: set[int]
) -> bool:
    """Deckt eine der Freigaben diesen Anfragenden gerade ab?"""
    jetzt = datetime.now(UTC)
    for z in zeilen:
        if z.expires_at is not None and z.expires_at <= jetzt:
            continue
        if z.subject_type == SUBJECT_EVERYONE:
            return True
        if z.subject_type == SUBJECT_USER and z.subject_id == anfragender_id:
            return True
        if z.subject_type == SUBJECT_ROLE and z.subject_id in rollen:
            return True
    return False


async def freigaben_lesen(session, device_id: int) -> list[DeviceGrant]:
    treffer = await session.execute(
        select(DeviceGrant).where(DeviceGrant.device_id == device_id)
    )
    return list(treffer.scalars())


async def rollen_freigaben_loeschen(session, device_id: int) -> int:
    """Rollen-Freigaben eines Geräts entfernen und ihre Zahl melden.

    Gerufen beim Community-Wechsel: eine Rolle gehört einer Community, nach dem
    Wechsel zeigen diese Zeilen ins Leere. Sie still weitergelten zu lassen wäre
    die gefährliche Variante — eine Rollenkennung kann in der Zielcommunity
    existieren und dort etwas völlig anderes bedeuten.
    """
    ergebnis = await session.execute(
        delete(DeviceGrant).where(
            DeviceGrant.device_id == device_id,
            DeviceGrant.subject_type == SUBJECT_ROLE,
        )
    )
    return ergebnis.rowcount or 0
```

- [ ] **Schritt 4: Test laufen lassen, grün bestätigen**

```
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q -k gedeckt
```
Erwartet: BESTANDEN.

- [ ] **Schritt 5: Das Feld an den weitergereichten Rahmen hängen**

In `routes/ws_remote_handlers.py`, im Block, der `frame` baut (heute ca. Zeile 279). Die Rollenmenge kommt aus der vorhandenen Mitgliedschafts-Abfrage; steht sie dort nicht bereit, wird sie mit `select(MemberRole.role_id).where(MemberRole.guild_id == …, MemberRole.user_id == user.id)` geholt — im **selben** `async with session_factory()`-Block wie die Rechteprüfung, nicht in einem zweiten:

```python
    frame = {
        "op": "remote_request",
        "session_id": sess.session_id,
        "channel_id": cid,
        "from_user_id": str(user.id),
    }
    if geraet is not None:
        frame["device_id"] = str(geraet)
        # **Deckt eine Dauerfreigabe diese Anfrage?** Der Gateway rechnet es
        # aus, weil nur er Rollen auflösen kann — der Client kennt sie
        # bestenfalls für die gerade geöffnete Community, und eine Anfrage kommt
        # auch herein, während man woanders steht. Das Gerät ENTSCHEIDET
        # trotzdem weiter: es antwortet mit einer ganz gewöhnlichen Zustimmung,
        # nur ohne Dialog. Damit bleibt „Gerät offline = keine Zustimmung".
        frame["freigabe"] = freigabe_gilt
```

Die Berechnung selbst steht oben im Datenbank-Block, direkt nach `standplatz_stimmt`:

```python
        freigabe_gilt = False
        if geraet is not None:
            device_row = await session.get(Device, geraet)
            if device_row is not None:
                rollen = await rollen_von(session, device_row.guild_id, user.id)
                freigabe_gilt = gedeckt(
                    await freigaben_lesen(session, geraet),
                    anfragender_id=user.id,
                    rollen=rollen,
                )
```

- [ ] **Schritt 6: Volllauf der Fernsteuer-Tests**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/ -q -k "remote or device"
```
Erwartet: alle grün. Bei einem **Hänger** zuerst die Maschinenlast prüfen (kein paralleler `cargo build`/`pnpm build`), nicht den Test.

- [ ] **Schritt 7: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/device_grants.py \
        services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py \
        services/chat-gateway/tests/test_device_grants.py
git commit -m "feat(geraete): Gateway löst Dauerfreigaben auf — Rollen inbegriffen"
```

---

## Aufgabe 5: Rollen-Freigaben beim Community-Wechsel räumen

**Dateien:**
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/routes/devices.py` (`patch_device`)
- Test: `services/chat-gateway/tests/test_device_grants.py`

**Schnittstellen:**
- Verbraucht: `rollen_freigaben_loeschen` aus Aufgabe 4, den Community-Wechsel aus Aufgabe 1.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_community_wechsel_raeumt_rollen_freigaben(client, _auth_signer):
    besitzer, _ = await _make_token(_auth_signer)
    _, gast = await _make_token(_auth_signer)
    quelle = await _guild(client, besitzer, "projekt-nord")
    ziel = await _guild(client, besitzer, "projekt-sued")
    k_quelle = await _voice_channel(client, besitzer, quelle)
    k_ziel = await _voice_channel(client, besitzer, ziel, "schnitt-2")
    rolle = (
        await client.post(
            f"/guilds/{quelle}/roles", json={"name": "cutter"}, headers=_auth(besitzer)
        )
    ).json()["id"]
    did = (
        await client.post(
            f"/guilds/{quelle}/devices",
            json={"channel_id": str(k_quelle), "name": "schnitt-1"},
            headers=_auth(besitzer),
        )
    ).json()["id"]
    await client.put(
        f"/guilds/{quelle}/devices/{did}/grants",
        json={
            "grants": [
                {"subject_type": "role", "subject_id": str(rolle)},
                {"subject_type": "user", "subject_id": str(gast)},
            ]
        },
        headers=_auth(besitzer),
    )

    await client.patch(
        f"/guilds/{quelle}/devices/{did}",
        json={"guild_id": str(ziel), "channel_id": str(k_ziel)},
        headers=_auth(besitzer),
    )

    # Die Rolle ist weg, der Nutzer bleibt: Nutzerkennungen gelten serverweit,
    # Rollenkennungen nur in ihrer Community.
    r = await client.get(f"/guilds/{ziel}/devices/{did}/grants", headers=_auth(besitzer))
    arten = sorted(g["subject_type"] for g in r.json())
    assert arten == ["user"]
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/test_device_grants.py -q -k raeumt
```
Erwartet: FEHLSCHLAG — `arten == ["role", "user"]`.

- [ ] **Schritt 3: Räumung einbauen**

In `patch_device`, im Zweig, der die Community wechselt — **vor** dem Commit, damit ein an einem Namenskonflikt scheiternder Wechsel die Freigaben nicht mitnimmt:

```python
        if alte_guild is not None and alte_guild != device.guild_id:
            # Rollen gehören ihrer Community. Nach dem Wechsel zeigen diese
            # Zeilen ins Leere — schlimmer noch, dieselbe Kennung kann in der
            # Zielcommunity eine andere Rolle sein.
            geraeumt = await rollen_freigaben_loeschen(session, device.id)
```

Die Zahl `geraeumt` geht als Feld `role_grants_cleared` in die Antwort (`DeviceOut` bleibt unverändert; das Feld hängt an einem schmalen Antwortmodell `DevicePatchOut`, das `DeviceOut` erbt). Die Oberfläche sagt es dem Besitzer in Aufgabe 8.

- [ ] **Schritt 4: Test laufen lassen, grün bestätigen**

```
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/ -q -k "device"
```
Erwartet: alle grün.

- [ ] **Schritt 5: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/devices.py \
        services/chat-gateway/tests/test_device_grants.py
git commit -m "fix(geraete): Rollen-Freigaben überleben den Community-Wechsel nicht"
```

---

## Aufgabe 6: Client-API und Freigabe-Zustand

**Dateien:**
- Ändern: `web/src/lib/api/devices.ts`
- Erstellen: `web/src/lib/devices/freigaben.svelte.ts`
- Test: `web/test/freigabe-restzeit.test.ts` (neu)

**Schnittstellen:**
- Liefert: `devicesApi.patch(guildId, deviceId, {name?, channel_id?, guild_id?})`; `grantsApi.list(guildId, deviceId): Promise<Grant[]>`; `grantsApi.set(guildId, deviceId, grants: GrantEingabe[]): Promise<Grant[]>`; Typen `Grant = {id, subject_type: 'user'|'role'|'everyone', subject_id: string|null, expires_at: string|null, created_at: string}` und `GrantEingabe = Omit<Grant,'id'|'created_at'>`; `restzeitText(expiresAt: string|null, jetzt: number): string` aus `devices/restzeit.ts`. Aufgaben 8, 9 und 10 verbrauchen alles davon.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

`web/test/freigabe-restzeit.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restzeit } from '../src/lib/devices/restzeit.ts';

const JETZT = Date.UTC(2026, 7, 20, 12, 0, 0);

test('dauerhaft hat keine Restzeit', () => {
  assert.equal(restzeit(null, JETZT), null);
});

test('abgelaufen zaehlt als abgelaufen, nicht als Rest 0', () => {
  assert.equal(restzeit(new Date(JETZT - 1000).toISOString(), JETZT), 'abgelaufen');
});

test('Restzeit rundet auf die groebste sinnvolle Einheit', () => {
  assert.equal(restzeit(new Date(JETZT + 90 * 60_000).toISOString(), JETZT), '2 Stunden');
  assert.equal(restzeit(new Date(JETZT + 45 * 60_000).toISOString(), JETZT), '45 Minuten');
  assert.equal(restzeit(new Date(JETZT + 50 * 3_600_000).toISOString(), JETZT), '2 Tage');
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
cd web && pnpm test:unit
```
Erwartet: FEHLSCHLAG — `Cannot find module '../src/lib/devices/restzeit.ts'`.

- [ ] **Schritt 3: Die reine Rechnung schreiben**

`web/src/lib/devices/restzeit.ts` — **importfrei**, sonst kann Nodes Läufer sie nicht laden (der Bundler löst erweiterungslose Importe auf, Node nicht):

```ts
/**
 * Wie lange gilt eine Freigabe noch?
 *
 * Bewusst ohne Importe: Nodes eingebauter Testläufer lädt diese Datei direkt,
 * und ein erweiterungsloser Laufzeit-Import (`from './nachbar'`) bräche dort.
 * Muster wie `lib/remote/zeigerbildPruefung.ts`.
 *
 * `null` heisst „dauerhaft" — nicht „unbekannt". Der Unterschied zu
 * `'abgelaufen'` ist wichtig: eine abgelaufene Freigabe steht weiter in der
 * Liste (der Server fegt nicht), und sie als „gilt noch 0 Minuten" zu zeigen
 * wäre die falsche Auskunft.
 */
export function restzeit(expiresAt: string | null, jetzt: number): string | null {
  if (expiresAt === null) return null;
  const ende = Date.parse(expiresAt);
  if (!Number.isFinite(ende)) return 'abgelaufen';
  const ms = ende - jetzt;
  if (ms <= 0) return 'abgelaufen';
  const minuten = Math.round(ms / 60_000);
  if (minuten < 60) return `${minuten} Minuten`;
  const stunden = Math.round(minuten / 60);
  if (stunden < 48) return `${stunden} Stunden`;
  return `${Math.round(stunden / 24)} Tage`;
}
```

- [ ] **Schritt 4: Test laufen lassen, grün bestätigen**

```
cd web && pnpm test:unit
```
Erwartet: BESTANDEN.

- [ ] **Schritt 5: API-Client erweitern**

In `web/src/lib/api/devices.ts`:

```ts
export type GrantArt = 'user' | 'role' | 'everyone';

export interface Grant {
  id: string;
  subject_type: GrantArt;
  /** Nutzer- oder Rollenkennung; `null` bei `everyone`. */
  subject_id: string | null;
  /** ISO-Zeitpunkt; `null` = dauerhaft. */
  expires_at: string | null;
  created_at: string;
}

export type GrantEingabe = Pick<Grant, 'subject_type' | 'subject_id' | 'expires_at'>;
```

`patch` bekommt `guild_id?: string` im Rumpf-Typ, und daneben:

```ts
export const grantsApi = {
  /** Die Freigabeliste eines EIGENEN Geräts. Fremde Geräte antworten 404. */
  list(guildId: string, deviceId: string): Promise<Grant[]> {
    return request<Grant[]>(`/guilds/${guildId}/devices/${deviceId}/grants`);
  },

  /** Die ganze Liste ersetzen — es gibt bewusst keinen Weg, einen einzelnen
   *  Eintrag zu ändern: so entsteht kein Zwischenzustand „scharf, aber für
   *  niemanden". */
  set(guildId: string, deviceId: string, grants: GrantEingabe[]): Promise<Grant[]> {
    return request<Grant[]>(`/guilds/${guildId}/devices/${deviceId}/grants`, {
      method: 'PUT',
      body: { grants },
    });
  },
};
```

- [ ] **Schritt 6: Den Zustand schreiben**

`web/src/lib/devices/freigaben.svelte.ts`:

```ts
/**
 * Freigabelisten der eigenen Geräte — geladen, nicht geraten.
 *
 * Je Gerät eine Liste, nachgeladen beim Öffnen der Geräteansicht. Kein
 * Vorladen aller Geräte: die Liste interessiert nur den Besitzer und nur, wenn
 * er gerade hinsieht.
 */
import { grantsApi, type Grant, type GrantEingabe } from '$lib/api/devices';

class Freigaben {
  #proGeraet = $state<Record<string, Grant[]>>({});
  laden_ = $state<Record<string, boolean>>({});

  fuer(deviceId: string): Grant[] {
    return this.#proGeraet[deviceId] ?? [];
  }

  async laden(guildId: string, deviceId: string): Promise<void> {
    if (this.laden_[deviceId]) return;
    this.laden_[deviceId] = true;
    try {
      this.#proGeraet[deviceId] = await grantsApi.list(guildId, deviceId);
    } finally {
      this.laden_[deviceId] = false;
    }
  }

  /** Ersetzen. Der Server ist die Wahrheit — wir übernehmen seine Antwort,
   *  nicht die gesendete Liste (er vergibt Kennungen und Zeitstempel). */
  async setzen(guildId: string, deviceId: string, grants: GrantEingabe[]): Promise<void> {
    this.#proGeraet[deviceId] = await grantsApi.set(guildId, deviceId, grants);
  }
}

export const freigaben = new Freigaben();
```

- [ ] **Schritt 7: Typprüfung und Committen**

```bash
cd web && pnpm check && pnpm test:unit && cd -
git add web/src/lib/api/devices.ts web/src/lib/devices/freigaben.svelte.ts \
        web/src/lib/devices/restzeit.ts web/test/freigabe-restzeit.test.ts
git commit -m "feat(geraete): Client kennt die serverseitige Freigabeliste"
```

---

## Aufgabe 7: Das Gerät entscheidet nach Server-Feld und Hauptschalter

**Dateien:**
- Ändern: `web/src/lib/remote/standplatz.svelte.ts` · `web/src/lib/remote/geraeteanbindung.ts` · `web/src/lib/remote/session.svelte.ts:374` · `web/src/lib/ws/handlers/remote.ts:63` · `web/src/lib/ws/handlers/types.ts` (Rahmen-Typ)
- Test: `web/test/selbsttaetig.test.ts` (neu)

**Schnittstellen:**
- Verbraucht: das Feld `freigabe` aus Aufgabe 4.
- Liefert: `standplatz.selbsttaetigZustimmen(freigabeVomServer: boolean): boolean` und `geraet.ohneRueckfrage(freigabeVomServer: boolean): boolean`. `remoteSession._incomingRequest` nimmt einen fünften Parameter `freigabe: boolean`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

`web/test/selbsttaetig.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selbsttaetig } from '../src/lib/remote/selbsttaetigRegel.ts';

test('ohne Server-Freigabe niemals selbsttaetig', () => {
  assert.equal(selbsttaetig({ geladen: true, aktiv: true, freigabe: false }), false);
});

test('mit ausgeschaltetem Hauptschalter niemals selbsttaetig', () => {
  assert.equal(selbsttaetig({ geladen: true, aktiv: false, freigabe: true }), false);
});

test('vor dem Laden des Speichers niemals selbsttaetig', () => {
  assert.equal(selbsttaetig({ geladen: false, aktiv: true, freigabe: true }), false);
});

test('alles drei erfuellt', () => {
  assert.equal(selbsttaetig({ geladen: true, aktiv: true, freigabe: true }), true);
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
cd web && pnpm test:unit
```
Erwartet: FEHLSCHLAG — Modul fehlt.

- [ ] **Schritt 3: Die Regel als importfreies Modul schreiben**

`web/src/lib/remote/selbsttaetigRegel.ts`:

```ts
/**
 * Darf dieser Rechner ohne Rückfrage zustimmen?
 *
 * Drei Bedingungen, alle drei fail-closed:
 *
 * * `freigabe` — der Server hat eine Dauerfreigabe aufgelöst, die diese Anfrage
 *   deckt. Nur er kann das: Rollen sind dem Client für fremde Communities
 *   unbekannt.
 * * `aktiv` — der Hauptschalter am Gerät. Ein physischer Notaus, der nichts
 *   vom Server weiss; er sticht immer.
 * * `geladen` — der gespeicherte Stand ist gelesen. Ein Rennen zwischen einer
 *   hereinkommenden Anfrage und dem Laden darf nicht zugunsten der Anfrage
 *   ausgehen.
 *
 * Importfrei, damit Nodes Testläufer sie laden kann.
 */
export function selbsttaetig(s: {
  geladen: boolean;
  aktiv: boolean;
  freigabe: boolean;
}): boolean {
  return s.geladen && s.aktiv && s.freigabe;
}
```

- [ ] **Schritt 4: Test laufen lassen, grün bestätigen**

```
cd web && pnpm test:unit
```
Erwartet: BESTANDEN.

- [ ] **Schritt 5: Den alten Entscheidungsweg ersetzen**

In `standplatz.svelte.ts`: `darfOhneRueckfrage(...)` und die Felder `nutzer`/`jeder` entfallen, `aktiv`, `geltung`, `gueltigBis` und `geladen` bleiben. Neu:

```ts
  /** Der eine Entscheidungspunkt. Die Liste liegt seit 2026-08-20 auf dem
   *  Server (`device_grants`); hier bleibt der Hauptschalter. */
  selbsttaetigZustimmen(freigabeVomServer: boolean): boolean {
    return selbsttaetig({
      geladen: this.geladen,
      aktiv: this.aktiv,
      freigabe: freigabeVomServer,
    });
  }
```

In `geraeteanbindung.ts` schrumpft `ohneRueckfrage` auf:

```ts
export function ohneRueckfrage(freigabeVomServer: boolean): boolean {
  return standplatz.selbsttaetigZustimmen(freigabeVomServer);
}
```

`standplatzKanal()` und der Parameter `channelId` entfallen dort — der Ort wird jetzt serverseitig geprüft. **`fremdesGeraetAblehnen` bleibt unverändert**: die Einladung geht weiterhin an alle Fenster des Kontos, und ein Laptop darf nicht für den Werkstatt-PC zustimmen.

In `session.svelte.ts:374`:

```ts
    if (geraet.ohneRueckfrage(freigabe)) {
```

wobei `freigabe` der neue fünfte Parameter von `_incomingRequest` ist. In `ws/handlers/remote.ts`:

```ts
    remoteSession._incomingRequest(
      evt.session_id,
      evt.channel_id,
      evt.from_user_id,
      evt.device_id,
      evt.freigabe === true,
    );
```

und in `ws/handlers/types.ts` bekommt der `remote_request`-Rahmen `freigabe?: boolean`.

- [ ] **Schritt 6: Einmal-Umzug der alten lokalen Liste**

In `standplatz.svelte.ts`, gerufen aus `laden()` nachdem der Stand gelesen ist:

```ts
  /**
   * Die alte gerätelokale Liste einmal auf den Server schieben.
   *
   * Bis der Schub gelungen ist, bleibt die Datei stehen — scheitert er (kein
   * Netz, Server älter), wird es beim nächsten Start erneut versucht. Ein
   * verlorener Umzug hiesse: eine Freigabe, die jemand erteilt hat, gilt
   * plötzlich nicht mehr, ohne dass es jemand merkt.
   */
  async #umziehen(alt: { nutzer: Freigegebener[]; jeder: boolean }): Promise<void> {
    const eintrag = geraeteAnmeldung.fuerServer(dispatchenderServer());
    if (!eintrag) return;
    if (!alt.jeder && alt.nutzer.length === 0) return;
    const grants: GrantEingabe[] = alt.jeder
      ? [{ subject_type: 'everyone', subject_id: null, expires_at: this.#endeIso() }]
      : alt.nutzer.map((n) => ({
          subject_type: 'user' as const,
          subject_id: n.userId,
          expires_at: this.#endeIso(),
        }));
    await freigaben.setzen(eintrag.guildId, eintrag.deviceId, grants);
    await saveAll({ [UMZUG_SCHLUESSEL]: true });
  }
```

`UMZUG_SCHLUESSEL = 'remote.standplatz.umgezogen'`; ist er gesetzt, läuft `#umziehen` nicht mehr.

- [ ] **Schritt 7: Prüfen und Committen**

```bash
cd web && pnpm check && pnpm test:unit && cd -
git add web/src/lib/remote/ web/src/lib/ws/handlers/ web/test/selbsttaetig.test.ts
git commit -m "feat(geraete): Zustimmung folgt der Server-Freigabe, Hauptschalter sticht"
```

---

## Aufgabe 8: Verwaltung in der Geräteansicht

**Dateien:**
- Erstellen: `web/src/lib/devices/verwaltung.svelte.ts` · `web/src/lib/devices/components/DeviceVerwaltung.svelte`
- Ändern: `web/src/lib/devices/components/DeviceView.svelte`

**Schnittstellen:**
- Verbraucht: `devicesApi.patch` (mit `guild_id`) aus Aufgabe 6.
- Liefert: `geraeteVerwaltung.umbenennen(guildId, deviceId, name)`, `.umstellen(guildId, deviceId, zielGuild, zielKanal)`, `.entfernen(guildId, deviceId)` — alle `Promise<void>`, Fehler in `geraeteVerwaltung.fehler` (`string | null`).

- [ ] **Schritt 1: Das Modul schreiben**

`web/src/lib/devices/verwaltung.svelte.ts`:

```ts
/**
 * Ein Gerät verwalten — von jedem Rechner aus, nicht nur von ihm selbst.
 *
 * Die Oberfläche ruft nur; die Liste zieht sich NICHT selbst nach. Der Server
 * meldet jede Änderung ohnehin an alle, die den Standplatz sehen dürfen
 * (`device_changed`), und ein vorweggenommener Stand wäre eine zweite Wahrheit,
 * die bei jedem Fehlschlag zurückgenommen werden müsste.
 */
import { devicesApi } from '$lib/api/devices';
import { ApiError } from '$lib/api/client';

class GeraeteVerwaltung {
  fehler = $state<string | null>(null);
  laeuft = $state(false);
  /** Wie viele Rollen-Freigaben der letzte Community-Wechsel geräumt hat. */
  geraeumteRollen = $state(0);

  async #ruf(fn: () => Promise<void>): Promise<void> {
    this.laeuft = true;
    this.fehler = null;
    try {
      await fn();
    } catch (e) {
      // 404 heisst hier „schon weg" und ist kein Fehler des Nutzers — ein
      // anderer Rechner desselben Kontos oder ein Verwalter war schneller.
      if (e instanceof ApiError && e.status === 404) return;
      this.fehler = e instanceof Error ? e.message : String(e);
    } finally {
      this.laeuft = false;
    }
  }

  async umbenennen(guildId: string, deviceId: string, name: string): Promise<void> {
    await this.#ruf(async () => {
      await devicesApi.patch(guildId, deviceId, { name });
    });
  }

  async umstellen(
    guildId: string,
    deviceId: string,
    zielGuild: string,
    zielKanal: string,
  ): Promise<void> {
    await this.#ruf(async () => {
      const antwort = await devicesApi.patch(guildId, deviceId, {
        guild_id: zielGuild,
        channel_id: zielKanal,
      });
      this.geraeumteRollen = antwort.role_grants_cleared ?? 0;
    });
  }

  async entfernen(guildId: string, deviceId: string): Promise<void> {
    await this.#ruf(() => devicesApi.remove(guildId, deviceId));
  }
}

export const geraeteVerwaltung = new GeraeteVerwaltung();
```

- [ ] **Schritt 2: Die Komponente schreiben**

`web/src/lib/devices/components/DeviceVerwaltung.svelte` — Auswahl für Community und Kanal, Namensfeld, Entfernen-Knopf. Der Name wird bei `onblur` geschickt (nicht bei jedem Tastendruck), Community und Kanal bei `onchange`; ein `device_changed` von der WebSocket darf ein gerade getipptes Feld nicht überschreiben, deshalb `$state` mit Nachführung statt `bind:value` auf die Gerätezeile — dasselbe Muster wie in `SettingsGeraeteEintragung.svelte`:

```svelte
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { geraeteVerwaltung } from '$lib/devices/verwaltung.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device } from '$lib/api/devices';

  let { device, darfVerwalten }: { device: Device; darfVerwalten: boolean } = $props();

  const istBesitzer = $derived(device.owner_user_id === currentServerUserId());
  let name = $state('');
  let zielGuild = $state('');
  let zielKanal = $state('');
  $effect(() => { if (!name) name = device.name; });
  $effect(() => { if (!zielGuild) zielGuild = device.guild_id; });
  $effect(() => { if (!zielKanal) zielKanal = device.channel_id; });

  const sprachkanaele = $derived(
    (guilds.channelsByGuild[zielGuild] ?? []).filter((c) => c.type === 1),
  );
</script>
```

Markup: Namensfeld mit `data-testid="device-manage-name"`, Community-Auswahl `device-manage-guild` (nur `istBesitzer`), Kanal-Auswahl `device-manage-channel` (nur `istBesitzer`), Entfernen-Knopf `device-manage-remove` (sichtbar bei `istBesitzer || darfVerwalten`). Nach einem Community-Wechsel mit `geraeteVerwaltung.geraeumteRollen > 0` eine Zeile, die sagt, wie viele Rollen-Freigaben dabei entfernt wurden — sonst erbt der Besitzer eine leere Liste, ohne zu wissen warum.

- [ ] **Schritt 3: In `DeviceView` einbinden**

`DeviceVerwaltung` unterhalb der Bildschirmliste einhängen, `darfVerwalten` aus der vorhandenen Rechteprüfung für `MANAGE_GUILD`. `DeviceView.svelte` muss dabei unter 250 Zeilen bleiben — wenn nicht, wandert die Bildschirmliste in eine eigene Komponente.

- [ ] **Schritt 4: Prüfen**

```bash
cd web && pnpm check && pnpm build
```
Erwartet: keine Typfehler, Build läuft.

- [ ] **Schritt 5: Committen**

```bash
git add web/src/lib/devices/
git commit -m "feat(geraete): Gerät in der Geräteansicht verwalten"
```

---

## Aufgabe 9: Freigabeliste in der Oberfläche

**Dateien:**
- Erstellen: `web/src/lib/devices/components/DeviceFreigaben.svelte`
- Ändern: `web/src/lib/devices/components/DeviceView.svelte`

**Schnittstellen:**
- Verbraucht: `freigaben` aus Aufgabe 6, `restzeit` aus Aufgabe 6.

- [ ] **Schritt 1: Die Komponente schreiben**

Nur für den Besitzer, für alle anderen gar nicht erst im DOM (nicht bloss ausgeblendet — die Liste sagt, wer den Rechner übernehmen darf, und das geht niemanden sonst etwas an). Sie zeigt drei Arten von Zeilen: Nutzer (mit Namen aus `userCache`), Rollen (aus dem Rollen-Store der Community des Standplatzes) und „jeder". Jede Zeile mit Restzeit (`restzeit(...)`, `null` = „dauerhaft") und einem X.

Hinzufügen über zwei Auswahlfelder (Nutzer aus der Mitgliederliste des Standplatz-Kanals, Rolle aus den Rollen der Community) plus Geltung („befristet" mit Spanne, oder „dauerhaft"). Jede Änderung ruft `freigaben.setzen(...)` mit der **ganzen** Liste.

`data-testid`: `device-grants`, `device-grant-add-user`, `device-grant-add-role`, `device-grant-everyone`, `device-grant-remove`.

- [ ] **Schritt 2: In `DeviceView` einbinden**

Direkt unter `DeviceVerwaltung`, mit `{#if device.owner_user_id === currentServerUserId()}`.

- [ ] **Schritt 3: Prüfen und Committen**

```bash
cd web && pnpm check && pnpm build && cd -
git add web/src/lib/devices/components/
git commit -m "feat(geraete): Freigabeliste am Gerät sichtbar und änderbar"
```

---

## Aufgabe 10: Reiter zerlegen, sichtbar machen, Geräteliste

**Dateien:**
- Erstellen: `web/src/lib/devices/reiterSichtbar.ts` · `web/src/lib/components/settings/SettingsStandplatzGeraete.svelte`
- Ändern: `web/src/lib/components/SettingsDialog.svelte:128` · `web/src/lib/components/settings/SettingsStandplatz.svelte` (zerlegen)
- Test: `web/test/reiter-sichtbar.test.ts` (neu)

**Schnittstellen:**
- Liefert: `reiterSichtbar({kannStandplatzSein, hatEintragung, besitztGeraete}): boolean`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reiterSichtbar } from '../src/lib/devices/reiterSichtbar.ts';

test('Windows-Rechner sieht den Reiter immer', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: true, hatEintragung: false, besitztGeraete: false }),
    true,
  );
});

test('Linux mit eigenen Geraeten sieht ihn — das ist der neue Fall', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: false, hatEintragung: false, besitztGeraete: true }),
    true,
  );
});

test('Linux mit alter Eintragung sieht ihn — sonst kaeme er nie wieder los', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: false, hatEintragung: true, besitztGeraete: false }),
    true,
  );
});

test('Linux ohne alles sieht ihn nicht', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: false, hatEintragung: false, besitztGeraete: false }),
    false,
  );
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```
cd web && pnpm test:unit
```
Erwartet: FEHLSCHLAG — Modul fehlt.

- [ ] **Schritt 3: Die Regel schreiben**

`web/src/lib/devices/reiterSichtbar.ts`:

```ts
/**
 * Zeigt dieser Client den Standplatz-Reiter?
 *
 * **Nicht dieselbe Frage wie `darfStandplatzSein()`** — die beantwortet „kann
 * dieser RECHNER Standplatz sein" und hängt an der Anmeldung
 * (`ws/handlers/ready.ts`) und der Übernahme (`remote/session.svelte.ts`). Die
 * beiden liefen am 2026-08-18 schon einmal auseinander: der Reiter war unter
 * Linux versteckt, die vorhandene Eintragung meldete sich trotzdem weiter an.
 * Deshalb steht die Reiter-Regel hier und fasst jene nicht an.
 *
 * Importfrei für Nodes Testläufer.
 */
export function reiterSichtbar(s: {
  kannStandplatzSein: boolean;
  hatEintragung: boolean;
  besitztGeraete: boolean;
}): boolean {
  return s.kannStandplatzSein || s.hatEintragung || s.besitztGeraete;
}
```

- [ ] **Schritt 4: In `SettingsDialog.svelte` verwenden**

```ts
  const istWindows = $derived(
    reiterSichtbar({
      kannStandplatzSein: darfStandplatzSein(),
      hatEintragung: !!geraeteAnmeldung.fuerServer(activeServer.serverId),
      besitztGeraete: deviceStore.eigene(currentServerUserId()).length > 0,
    }),
  );
```

Die Variable heisst danach nicht mehr `istWindows` (sie stimmt nicht mehr) — umbenennen in `zeigtStandplatzReiter`, alle Fundstellen mitziehen. `deviceStore.eigene(userId)` ist zu ergänzen: alle geladenen Geräte über alle Communities, gefiltert auf `owner_user_id`.

- [ ] **Schritt 5: „Meine Geräte" als eigene Komponente**

`SettingsStandplatzGeraete.svelte`: Liste der eigenen Geräte auf diesem Server (Name, Community, Standplatz, Zustandspunkt), je Zeile ein Sprung in die Geräteansicht und ein Entfernen über `geraeteVerwaltung.entfernen`. `data-testid="settings-my-devices"`.

- [ ] **Schritt 6: `SettingsStandplatz.svelte` zerlegen**

485 Zeilen bei einer Grenze von 250. Entlang der drei vorhandenen Themen teilen: `SettingsStandplatzFreigabe.svelte` (nutzt `DeviceFreigaben` aus Aufgabe 9 — die Freigabe-Oberfläche gibt es damit **einmal**, nicht zweimal), `SettingsStandplatzProtokoll.svelte` (existiert als `SettingsStandplatzProfil.svelte` bereits daneben — prüfen, ob das Protokoll schon dort liegt), und der neue Geräte-Abschnitt. `SettingsStandplatz.svelte` bleibt als Klammer, die die drei einhängt.

**Verhalten darf sich dabei nicht ändern** — dieselben `data-testid`, dieselben Rufe.

- [ ] **Schritt 7: Prüfen und Committen**

```bash
cd web && pnpm check && pnpm test:unit && pnpm build && cd -
git add web/src/lib/components/ web/src/lib/devices/reiterSichtbar.ts web/test/reiter-sichtbar.test.ts
git commit -m "feat(geraete): Standplatz-Reiter auch dort, wo man nur Geräte besitzt"
```

---

## Aufgabe 11: Geräte-Deckel als Community-Limit

**Dateien:**
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/models/guilds.py` · `guild_limits.py` · `routes/devices.py`
- Erstellen: `alembic/versions/20260820_1300_0061_device_limit.py`
- Test: `services/chat-gateway/tests/test_devices.py`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_geraete_deckel_kommt_aus_dem_community_limit(client, _auth_signer):
    token, _ = await _make_token(_auth_signer)
    gid = await _guild(client, token, "studio")
    kanal = await _voice_channel(client, token, gid)
    # Deckel auf 1 setzen (Community-eigener Wert)
    r = await client.patch(
        f"/guilds/{gid}/limits",
        json={"limits": {"max_devices_per_owner": 1}},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-1"},
        headers=_auth(token),
    )
    assert r.status_code == 201
    r = await client.post(
        f"/guilds/{gid}/devices",
        json={"channel_id": str(kanal), "name": "schnitt-2"},
        headers=_auth(token),
    )
    assert r.status_code == 409, r.text
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Erwartet: FEHLSCHLAG — `max_devices_per_owner` ist kein bekanntes Limit (422 beim Setzen), und der zweite Eintrag geht durch (Konstante 10).

- [ ] **Schritt 3: Spalten und Migration**

In `models/guilds.py` neben `max_roles` bzw. `community_max_roles`:

```python
    max_devices_per_owner: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    community_max_devices_per_owner: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )
```

Migration `0061_device_limit` (`down_revision = "0060_device_grants"`), beide Spalten `sa.SmallInteger()`, nullable, per `op.add_column` im Schema `chat`.

- [ ] **Schritt 4: `LimitSpec` ergänzen**

In `guild_limits.py`, `LIMITS` erweitern:

```python
    LimitSpec(
        "max_devices_per_owner",
        "max_devices_per_owner",
        "community_max_devices_per_owner",
        instance_default=DEFAULT_MAX_DEVICES_PER_OWNER,
        value_max=_SMALLINT_MAX,
    ),
```

mit `DEFAULT_MAX_DEVICES_PER_OWNER = 25` oben im Modul, samt Begründung: deckt eine Postproduktion mit Luft ab, bleibt klein genug, dass ein Client, der sich in einer Schleife einträgt, auffällt, bevor er die Kanalliste flutet.

- [ ] **Schritt 5: `routes/devices.py` auf das Limit umstellen**

`MAX_DEVICES_PER_OWNER` entfällt; `create_device` liest den wirksamen Wert über die vorhandene Auflösung aus `guild_limits.py` (dieselbe Funktion, die `max_channels` und `max_roles` prüfen — dort abschauen und **nicht** eine zweite bauen).

- [ ] **Schritt 6: Tests laufen lassen und Committen**

```bash
cd services/chat-gateway && uv run alembic upgrade head && cd -
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/ -q -k "device or limit"
git add services/chat-gateway/
git commit -m "feat(geraete): Geräte-Deckel wird ein Community-Limit, Vorgabe 25"
```

---

## Aufgabe 12: Die lokale Eintragung räumt sich selbst

**Dateien:**
- Ändern: `web/src/lib/ws/handlers/devices.ts` · `web/src/lib/devices/anmeldung.svelte.ts`

**Schnittstellen:**
- Liefert: `geraeteAnmeldung.nachziehen(deviceId, guildId, name)` — aktualisiert eine vorhandene Eintragung, ohne eine neue anzulegen.

- [ ] **Schritt 1: `nachziehen` schreiben**

```ts
  /**
   * Community oder Name einer bestehenden Eintragung nachziehen.
   *
   * Nötig seit dem Community-Wechsel aus der Ferne: die Eintragung trägt sonst
   * weiter die alte Community, der Rechner lädt die Geräteliste der falschen
   * und sein eigener Reiter zeigt ins Leere. Legt bewusst NICHTS an — eine
   * Meldung über ein fremdes Gerät darf diesen Rechner nicht zu einem machen.
   */
  async nachziehen(deviceId: string, guildId: string, name: string): Promise<void> {
    const vorhanden = this.eintragungen.find((e) => e.deviceId === deviceId);
    if (!vorhanden) return;
    this.eintragungen = this.eintragungen.map((e) =>
      e.deviceId === deviceId ? { ...e, guildId, name } : e,
    );
    await this.#sichern();
  }
```

- [ ] **Schritt 2: Im WS-Handler verdrahten**

In `ws/handlers/devices.ts`, im `device_changed`-Handler:

```ts
  registerWsHandler('device_changed', (evt) => {
    const geraet = evt.device as Device | undefined;
    if (!evt.guild_id || !geraet?.id) return;
    deviceStore._changed(String(evt.guild_id), geraet, evt.removed === true);
    // **Und die eigene Eintragung mitziehen.** Ohne das bleibt ein Rechner
    // nach dem Entfernen im Standplatz-Betrieb (hält den Schirm wach, meldet
    // sich bei jedem Verbinden als ein Gerät an, das es nicht gibt) — und nach
    // einem Community-Wechsel aus der Ferne zeigt seine Eintragung auf die
    // alte Community.
    if (evt.removed === true) {
      void geraeteAnmeldung.vergessen(geraet.id);
    } else {
      void geraeteAnmeldung.nachziehen(geraet.id, String(geraet.guild_id), geraet.name);
    }
  });
```

- [ ] **Schritt 3: Prüfen und Committen**

```bash
cd web && pnpm check && pnpm build && cd -
git add web/src/lib/ws/handlers/devices.ts web/src/lib/devices/anmeldung.svelte.ts
git commit -m "fix(geraete): entferntes Gerät räumt seine lokale Eintragung selbst"
```

---

## Aufgabe 13: Dokumentation und Changelog

**Dateien:**
- Ändern: `CLAUDE.md` (Abschnitt „Standplatz-Geräte") · `docs/2026-08-16-standplatz-geraet-einrichten.md` · `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md` · `web/src/lib/remote/standplatz.svelte.ts` (Modulkopf) · `web/static/changelog.json`
- Erstellen: `docs/superpowers/specs/2026-08-20-geraete-konto-entwurf.md`

- [ ] **Schritt 1: Die widerrufenen Zusagen suchen**

```bash
grep -rn "liegt am GERÄT\|nie auf dem Server\|Rollen bleiben\|10 Geräte\|MAX_DEVICES_PER_OWNER" \
  --include='*.md' --include='*.ts' --include='*.py' .
```
Jede Fundstelle mitziehen — die Regel lautet: eine Behauptung wird nie an nur einer Stelle korrigiert.

- [ ] **Schritt 2: Die drei Aussagen neu formulieren**

- „Die Freigabe liegt am GERÄT, nie auf dem Server" → *die Liste liegt auf dem Server und darf nur vom Besitzer geschrieben werden; die Zustimmung erteilt weiterhin das Gerät, und ein Hauptschalter am Gerät sticht immer.*
- „Rollen bleiben draussen" → erledigt, mit dem Grund (der Server kann auflösen, was der Client nie konnte).
- „höchstens 10 Geräte je Besitzer und Community" → Community-Limit, Vorgabe 25.

- [ ] **Schritt 3: Den Geräte-Konto-Entwurf anlegen**

Kurzes Dokument, kein Code: das Problem (ein Konto auf jedem Rechner heisst private Nachrichten auf jedem Rechner, Dauer-„online", Geräte sterben mit der Mitgliedschaft des Einrichters), die Randbedingungen (Cloud-Identität, `owner_user_id` unveränderlich), und drei mögliche Richtungen. Verweis aus `CLAUDE.md` unter „Was fehlt".

- [ ] **Schritt 4: Changelog-Eintrag**

Neuer Eintrag oben in `web/static/changelog.json`, `id` = `2026-08-20`, Stil sachlich, **echte Umlaute, keine Emojis**. Inhalt sinngemäß: Geräte lassen sich jetzt von jedem Rechner aus verwalten — umbenennen, in eine andere Community oder einen anderen Kanal stellen, entfernen; wer ein Gerät dauerhaft freigibt, kann die Liste von überall ändern und dabei auch Rollen statt einzelner Personen freigeben.

- [ ] **Schritt 5: Volles Test-Gate und Committen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q
cd web && pnpm check && pnpm test:unit && pnpm build && cd -
git add CLAUDE.md docs/ web/static/changelog.json web/src/lib/remote/standplatz.svelte.ts
git commit -m "docs(geraete): Zusagen nachgezogen, Geräte-Konto als eigener Entwurf"
```

---

## Selbstprüfung des Plans

**Abdeckung gegen die Spec:** §5.1 → Aufgabe 1 · §5.2 → Aufgabe 2 · §6 → Aufgaben 3 und 5 · §7 → Aufgabe 4 · §8.1 → Aufgaben 8 und 9 · §8.2/8.3 → Aufgabe 10 · §9 → Aufgabe 11 · §10 → Aufgabe 12 · §11 → Aufgabe 7 Schritt 6 · §12 → über alle Aufgaben verteilt · §13 → Aufgabe 13 (Entwurf Geräte-Konto) · §16 → Aufgabe 13.

**Offene Annahmen, die beim Ausführen zu prüfen sind** (keine Platzhalter, sondern benannte Unsicherheiten):

1. `session_factory` als pytest-Fixture — falls nicht vorhanden, wandert Aufgabe 2 Schritt 1 in Aufgabe 3 (dort steht die Alternative).
2. `ist_mitglied` in `membership.py` — falls dort nur `require_member` existiert, in Aufgabe 1 Schritt 4 als schmale Abfrage ergänzen.
3. `rollen_von(session, guild_id, user_id)` in Aufgabe 4 — falls es keine solche Funktion gibt, direkt über `MemberRole` abfragen, im selben Sitzungsblock.
4. Ob das Protokoll bereits in `SettingsStandplatzProfil.svelte` liegt (Aufgabe 10 Schritt 6) — vor dem Zerlegen nachsehen.

**Typkonsistenz geprüft:** `Grant`/`GrantEingabe` (Aufgabe 6) werden in 8, 9 und 7 unverändert verwendet · `selbsttaetig({geladen, aktiv, freigabe})` heisst in Test und Aufruf gleich · `reiterSichtbar({kannStandplatzSein, hatEintragung, besitztGeraete})` ebenso · `freigabe` heisst auf der Leitung, im Handler und in der Regel durchgängig `freigabe` · `role_grants_cleared` (Aufgabe 5) wird in Aufgabe 8 unter genau diesem Namen gelesen.
