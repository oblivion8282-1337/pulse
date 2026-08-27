# Etappe B — Schlüsselverzeichnis am Server — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Gerät veröffentlicht seine Verschlüsselungsschlüssel beim
chat-gateway, und ein Absender kann die Schlüssel aller Geräte seines
Gegenübers abholen — je einen Einmalschlüssel, verbraucht.

**Architecture:** Das Verzeichnis lebt im chat-gateway (nicht im auth-svc),
weil ein Self-Host seine eigenen Gespräche führt und Dienste bei Pulse keine
Tabellen teilen. Ein Gerät weist sich **nicht über die Verbindung** aus — auf
der Cloud trägt der Access-Token kein Gerät —, sondern legt sein
Identitäts-Zertifikat und eine Unterschrift über das Bündel selbst bei.

**Tech Stack:** FastAPI · SQLAlchemy[asyncio] · Alembic · pytest

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` (§2 „Der Server
hält zwei Dinge", §10 Etappe B)

**Vorgänger:** Etappe A (`krypto/pulse-krypto`) ist fertig. Diese Etappe
benutzt sie **nicht** — sie bewegt nur Zeichenketten. Der Klient erzeugt die
Schlüssel, der Server bewahrt sie auf.

## Global Constraints

- **Alembic-Revision-ID ≤ 32 Zeichen.**
- **`down_revision` beim Schreiben gegen den tatsächlichen Kopf prüfen** (`alembic heads`). Zwei Zweige mit je einer Migration auf denselben Vorgänger brechen den Deploy; ein Test wacht seit dem 2026-08-28 darüber (`tests/test_alembic_koepfe.py`), er muss grün bleiben.
- **Quelldateien ≤ 350 Zeilen (hart 500).** Routen-Module notfalls splitten.
- **Niemals Schlüsselmaterial loggen** — auch keine Einmalschlüssel, auch nicht gekürzt, auch nicht in Fehlermeldungen.
- **Keine neuen Abhängigkeiten.**
- **Kein `git push`, kein `gh`.**
- **Changelog:** unsichtbar für Nutzer (keine Oberfläche) → **kein** Eintrag.
- Deutsche Kommentare und Commit-Nachrichten, echte Umlaute.

## Wichtige Fundstellen im Bestand

Am 2026-08-28 nachgesehen, nicht geraten:

| Was | Wo |
|---|---|
| Zertifikat prüfen → `CertClaims(cert_id, user_id, device_pubkey, …)` | `credential_validator.py::validate_cert(cert_jwt, redis)` (:45-56) |
| **Generische** Ed25519-Prüfung über beliebige Bytes | `credential_validator.py::verify_challenge_signature(payload, signature, device_pubkey_b64)` (:278) — der Name sagt „challenge", die Funktion prüft aber jede Nutzlast |
| Zuordnung Zertifikat → Nutzer dieser Instanz | `credential_validator.py::resolve_user_identifier(claims, instance_mode=…, instance_id=…)` (:257) |
| Angemeldeter Nutzer | `security.py::CurrentUser` → `AuthenticatedUser(id, username, is_admin, user_identifier, is_self_host, …)` (:263-280, :366) |
| DB-Sitzung | `db.py::SessionDep` |
| Sperrliste (Redis-Menge) | `credential_validator.py::REDIS_REVOKED_SET = "auth:revoked:certs"` (:39) |
| Router registrieren | `routes/__init__.py` (Import oben, `router.include_router(...)` unten) |
| Snowflake-ID | `next_id()` beim Einfügen, `mapped_column(BigInteger, primary_key=True)` |
| Schema | automatisch über `db.py::metadata = MetaData(schema=…)` |
| Test-Fixtures | `tests/conftest.py`: `client`, `session_factory`, `_auth_signer`, `access_token` → `(token, uid)`, `make_auth_header` |

**Die Falle, die man nur einmal übersieht:** `claims.user_id` ist die
**Cloud**-Nutzer-ID, `AuthenticatedUser.id` auf einem Self-Host dagegen eine
**synthetische**. Ein direkter Vergleich ist auf Self-Hosts immer falsch und
liesse dort jedes Zertifikat für jedes Konto zu. Verglichen wird über
`resolve_user_identifier(claims, …) == user.user_identifier` — dieser Wert ist
auf beiden Betriebsarten der richtige.

## Dateizuschnitt

| Datei | Verantwortung |
|---|---|
| `models/geraete_schluessel.py` | `DeviceKeyBundle`, `DeviceOneTimeKey` |
| `alembic/versions/<datum>_<n>_geraete_schluessel.py` | beide Tabellen |
| `schluessel_nachweis.py` | Zertifikat + Unterschrift prüfen — **eine** Stelle |
| `routes/schluessel.py` | Veröffentlichen, Vorrat, Abholen |
| `schemas.py` (ergänzen) | Ein-/Ausgabemodelle |
| `tests/test_schluessel.py` | alles davon |

---

### Task 1: Tabellen und Modelle

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/models/geraete_schluessel.py`
- Create: `services/chat-gateway/alembic/versions/<datum>_<n>_geraete_schluessel.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/models/__init__.py`
- Test: `services/chat-gateway/tests/test_schluessel.py`

**Interfaces:**
- Produces: `DeviceKeyBundle(id, user_id, device_pubkey, curve25519, signatur, rueckfallschluessel, rueckfall_signatur, cert_id, created_at, updated_at)`
- Produces: `DeviceOneTimeKey(id, bundle_id, schluessel, created_at)`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
"""Das Geraete-Schluesselverzeichnis."""

import pytest


@pytest.mark.asyncio
async def test_ein_geraet_hat_hoechstens_ein_buendel(session_factory):
    """Zweimal dasselbe Geraet darf keine zweite Zeile anlegen.

    Sonst hielte das Verzeichnis zwei Identitaeten fuer dasselbe Geraet, und
    welche ein Absender bekaeme, entschiede die Zeilenreihenfolge.
    """
    from sqlalchemy.exc import IntegrityError

    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=next_id(), user_id=1, device_pubkey="AAA", curve25519="BBB",
            signatur="CCC", cert_id="c1",
        ))
        await s.commit()

    with pytest.raises(IntegrityError):
        async with session_factory() as s:
            s.add(DeviceKeyBundle(
                id=next_id(), user_id=1, device_pubkey="AAA", curve25519="XXX",
                signatur="YYY", cert_id="c2",
            ))
            await s.commit()


@pytest.mark.asyncio
async def test_einmalschluessel_verschwinden_mit_ihrem_buendel(session_factory):
    """Ein Geraet abmelden heisst: sein Vorrat ist weg, nicht verwaist."""
    from sqlalchemy import delete, select

    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id

    bid = next_id()
    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=bid, user_id=2, device_pubkey="DDD", curve25519="EEE",
            signatur="FFF", cert_id="c3",
        ))
        s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel="k1"))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DeviceKeyBundle).where(DeviceKeyBundle.id == bid))
        await s.commit()

    async with session_factory() as s:
        uebrig = (await s.execute(
            select(DeviceOneTimeKey).where(DeviceOneTimeKey.bundle_id == bid)
        )).scalars().all()
        assert uebrig == []
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest \
  services/chat-gateway/tests/test_schluessel.py -v
```
Erwartet: `ImportError` — `DeviceKeyBundle` gibt es nicht.

- [ ] **Schritt 3: Das Modell schreiben**

`models/geraete_schluessel.py`, am Muster von `models/devices.py`:

```python
"""Das Verzeichnis der Verschluesselungs-Schluessel je Geraet.

Geführt wird ueber ``device_pubkey``, NICHT ueber ``cert_id``: die
Zertifikatserneuerung stellt alle 30 Tage ein neues Zertifikat fuer denselben
Pubkey aus (``cert-rotation.svelte.ts``). An der cert_id haengende Buendel
wuerden monatlich verwaisen.

``cert_id`` wird trotzdem mitgeschrieben — sie ist der Schluessel, unter dem
die Sperrliste (``auth:revoked:certs``) ein widerrufenes Geraet fuehrt.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class DeviceKeyBundle(Base):
    __tablename__ = "device_key_bundles"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: Base64, Ed25519 — die Identitaet des Geraets, stabil ueber Erneuerungen.
    device_pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    #: Base64, Curve25519 — der Schluessel, mit dem verschluesselt wird.
    curve25519: Mapped[str] = mapped_column(Text, nullable=False)
    #: Base64, Ed25519-Unterschrift des Geraets ueber sein eigenes Buendel.
    signatur: Mapped[str] = mapped_column(Text, nullable=False)
    #: Greift, wenn der Vorrat an Einmalschluesseln leer ist.
    rueckfallschluessel: Mapped[str | None] = mapped_column(Text, nullable=True)
    rueckfall_signatur: Mapped[str | None] = mapped_column(Text, nullable=True)
    cert_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("user_id", "device_pubkey", name="uq_device_key_bundles_geraet"),
        Index("ix_device_key_bundles_user", "user_id"),
    )


class DeviceOneTimeKey(Base):
    __tablename__ = "device_one_time_keys"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    bundle_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("device_key_bundles.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Base64, Curve25519. Wird beim Abholen GELOESCHT, nicht markiert —
    #: „einmal" ist sonst nur eine Absichtserklaerung.
    schluessel: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("bundle_id", "schluessel", name="uq_device_otk"),
        Index("ix_device_otk_bundle", "bundle_id"),
    )
```

**Zur Fremdschlüssel-Angabe:** `ForeignKey("device_key_bundles.id")` ohne
Schema-Präfix genügt, weil `Base.metadata` bereits ein Schema trägt
(`db.py:25`). Bricht der Test mit „NoReferencedTableError", **erst nachsehen,
wie andere Modelle mit Fremdschlüsseln es schreiben** (z. B.
`models/messages.py`), statt ein Schema hart hineinzuschreiben.

- [ ] **Schritt 4: Re-Export ergänzen** in `models/__init__.py` (Import **und** `__all__`).

- [ ] **Schritt 5: Migration schreiben**

Vorher `alembic heads` im Dienstverzeichnis laufen lassen und
`down_revision` auf den **tatsächlichen** Kopf setzen. Revision-ID ≤ 32
Zeichen. `downgrade()` löscht beide Tabellen in der richtigen Reihenfolge
(erst die Einmalschlüssel, dann die Bündel).

- [ ] **Schritt 6: Tests laufen lassen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest \
  services/chat-gateway/tests/ -q -n 4
```
Erwartet: alle grün, darunter der neue Kopf-Wächter.

- [ ] **Schritt 7: Committen**

```bash
git add services/chat-gateway/
git commit -m "feat(krypto): Tabellen fuer das Geraete-Schluesselverzeichnis"
```

---

### Task 2: Veröffentlichen — mit Nachweis

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/schluessel_nachweis.py`
- Create: `services/chat-gateway/src/dcc_chat_gateway/routes/schluessel.py`
- Modify: `routes/__init__.py`, `schemas.py`
- Test: `services/chat-gateway/tests/test_schluessel.py`

**Interfaces:**
- Consumes: `DeviceKeyBundle`, `DeviceOneTimeKey` aus Task 1
- Produces: `schluessel_nachweis.pruefe_geraet(cert_jwt, nutzlast: bytes, signatur_b64: str, user, redis) -> CertClaims` — wirft `HTTPException` bei jedem Fehlschlag
- Produces: `PUT /keys/bundle`, `POST /keys/onetime`, `GET /keys/onetime/count`

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

Ergänze in `tests/test_schluessel.py`. Der Aufbau braucht ein echtes
Ed25519-Paar und ein Zertifikat; sieh in `tests/test_cert_login.py` nach, wie
dort eines gebaut wird, und benutze **denselben** Weg statt einen eigenen zu
erfinden.

```python
@pytest.mark.asyncio
async def test_buendel_veroeffentlichen_und_wieder_abrufen(client, ...):
    """Der Normalfall: Geraet legt Zertifikat und Unterschrift bei."""
    # ... Buendel mit gueltiger Unterschrift PUTen -> 200
    # ... GET /keys/onetime/count -> {"vorrat": 0}


@pytest.mark.asyncio
async def test_falsche_unterschrift_wird_abgewiesen(client, ...):
    """Ohne diese Pruefung koennte jeder fuer jedes fremde Geraet einen
    Schluessel hinterlegen und saemtliche Nachrichten an dieses Geraet
    mitlesen. Das ist die Stelle, an der das ganze Verfahren haengt."""
    # ... Buendel mit Unterschrift ueber ANDERE Nutzlast -> 403


@pytest.mark.asyncio
async def test_fremdes_zertifikat_wird_abgewiesen(client, ...):
    """Ein gueltiges Zertifikat eines ANDEREN Kontos darf nicht genuegen."""
    # ... Zertifikat von Nutzer B, angemeldet als Nutzer A -> 403


@pytest.mark.asyncio
async def test_erneutes_veroeffentlichen_ersetzt_statt_zu_haeufen(client, ...):
    """Dasselbe Geraet nach einer Zertifikatserneuerung: eine Zeile, nicht zwei."""
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen** (Route gibt es nicht → 404).

- [ ] **Schritt 3: `schluessel_nachweis.py` schreiben**

Die **einzige** Stelle, an der geprüft wird. Vier Bedingungen, alle
fail-closed:

```python
"""Beweist, dass ein Geraet fuer SICH SELBST veroeffentlicht.

Der naheliegende Weg — den Absender aus der Verbindung ablesen — traegt nicht:
auf einem Self-Host meldet sich der Klient per Cert-Login und der Gateway
kennt das Geraet, auf der Cloud kommt ein Access-Token ohne jede
Geraeteangabe. Ein Verzeichnis, das nur auf Self-Hosts befuellbar waere, ist
nutzlos.

Das Geraet legt den Nachweis deshalb selbst bei: sein Identitaets-Zertifikat
(cloud-signiert, gegen JWKS und Sperrliste geprueft) und eine Unterschrift
ueber die Nutzlast, geprueft gegen den Pubkey AUS diesem Zertifikat.
"""
```

Ablauf:
1. `claims = await validate_cert(cert_jwt, redis)` — `None` → **403**
   (Sperrliste und Ablauf sind darin bereits abgedeckt).
2. `resolve_user_identifier(claims, instance_mode=…, instance_id=…)` muss
   `user.user_identifier` **gleichen** → sonst 403.
   **Nicht** `claims.user_id == user.id` vergleichen (s. Falle oben).
3. `verify_challenge_signature(nutzlast, signatur_bytes, claims.device_pubkey)`
   → falsch: 403.
4. Bei Erfolg `claims` zurückgeben; der Aufrufer schreibt `cert_id` und
   `device_pubkey` daraus, **nie** aus dem Rumpf der Anfrage.

Die unterschriebene Nutzlast muss **eindeutig** sein: ein fester Kontext-Text,
der Zweck (`buendel` bzw. `einmalschluessel`), und der Inhalt in fester
Reihenfolge. Sonst liesse sich eine Unterschrift von einem Zweck auf den
anderen übertragen. Die Bauvorschrift gehört als Kommentar an die Funktion,
weil der Klient sie **zeichengenau** nachbauen muss.

- [ ] **Schritt 4: `routes/schluessel.py` schreiben** und in `routes/__init__.py` registrieren.

- `PUT /keys/bundle` — legt an oder **ersetzt** anhand `(user_id, device_pubkey)`.
- `POST /keys/onetime` — hängt Schlüssel an; eine Obergrenze je Gerät (Vorschlag 100) verhindert, dass jemand die Tabelle vollschreibt.
- `GET /keys/onetime/count` — der Klient füllt unterhalb einer Schwelle nach.

- [ ] **Schritt 5: Tests laufen lassen** (voller Dienst, `-n 4`).

- [ ] **Schritt 6: Committen**

```bash
git commit -m "feat(krypto): Geraete veroeffentlichen ihre Schluessel mit Nachweis"
```

---

### Task 3: Abholen — einmal ist einmal

**Files:**
- Modify: `routes/schluessel.py`, `schemas.py`
- Test: `tests/test_schluessel.py`

**Interfaces:**
- Consumes: alles aus Task 1 und 2
- Produces: `POST /keys/claim` — Rumpf `{"user_ids": ["…"]}`, Antwort je Nutzer eine Liste von `{device_pubkey, curve25519, signatur, einmalschluessel | null, rueckfallschluessel | null}`

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
@pytest.mark.asyncio
async def test_abholen_verbraucht_den_einmalschluessel(client, ...):
    """Zweimal abholen darf nie denselben Schluessel liefern."""


@pytest.mark.asyncio
async def test_zwei_gleichzeitige_abholungen_bekommen_verschiedene(client, ...):
    """Der Kern der Sache. Zwei Abholungen gleichzeitig (asyncio.gather)
    duerfen NIE denselben Einmalschluessel liefern — sonst benutzen zwei
    Absender dasselbe Geheimnis. Ein blosses SELECT-dann-DELETE hat genau
    dieses Loch, und es faellt in keinem seriellen Test auf."""


@pytest.mark.asyncio
async def test_leerer_vorrat_liefert_den_rueckfallschluessel(client, ...):
    """Sonst koennte niemand mehr an ein laenger ausgeschaltetes Geraet
    schreiben. Der Rueckfallschluessel wird NICHT verbraucht."""


@pytest.mark.asyncio
async def test_widerrufenes_geraet_wird_nicht_geliefert(client, ...):
    """Ein gestohlenes, gesperrtes Geraet darf keine neuen Nachrichten mehr
    bekommen — sonst waere der Widerruf wirkungslos."""


@pytest.mark.asyncio
async def test_nutzer_ohne_geraete_liefert_leer_statt_fehler(client, ...):
    """Jemand, der die App nie installiert hat. Das ist der Normalfall der
    Koexistenz-Regel, kein Fehlerfall."""
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen.**

- [ ] **Schritt 3: Das atomare Abholen schreiben**

**Kein `SELECT … FOR UPDATE`** — die Tests laufen auf SQLite, das es nicht
kennt, und ein Verhalten, das nur in Produktion greift, ist kein Schutz.
Stattdessen das Muster, das dieses Projekt bereits benutzt (bewachtes
`UPDATE`/`DELETE`, wie bei den Registrierungs-Einladungen, Migration 0022):

```python
async def _einmalschluessel_holen(session, bundle_id: int) -> str | None:
    """Nimmt genau einen Schluessel aus dem Vorrat — oder keinen.

    Die Schleife ist kein Schoenheitsfehler: zwischen Auswaehlen und Loeschen
    kann ein anderer Absender denselben Schluessel greifen. Wer dann nicht
    erneut auswaehlt, gibt zwei Absendern dasselbe Geheimnis. Das DELETE mit
    Bedingung auf die ID ist der Schiedsrichter — genau einer bekommt
    rowcount 1.
    """
    for _ in range(5):
        zeile = (await session.execute(
            select(DeviceOneTimeKey)
            .where(DeviceOneTimeKey.bundle_id == bundle_id)
            .order_by(DeviceOneTimeKey.id)
            .limit(1)
        )).scalar_one_or_none()
        if zeile is None:
            return None
        ergebnis = await session.execute(
            delete(DeviceOneTimeKey).where(DeviceOneTimeKey.id == zeile.id)
        )
        if ergebnis.rowcount == 1:
            return zeile.schluessel
    return None
```

**Die Anzahl der Versuche ist eine Aussage:** fünf Fehlschläge hintereinander
heissen, dass der Vorrat gerade leergeräumt wird — dann ist „keiner da" die
richtige Antwort, und der Rückfallschlüssel greift.

- [ ] **Schritt 4: Den Sperrlisten-Filter einbauen**

Beim Abholen die `cert_id` jedes Bündels gegen die Redis-Menge
`auth:revoked:certs` prüfen (Konstante `REDIS_REVOKED_SET`) und gesperrte
Geräte **auslassen**.

**Ehrlich zu den Grenzen dieses Filters, und das gehört als Kommentar in den
Code:** die gespeicherte `cert_id` ist die des Zertifikats, mit dem zuletzt
veröffentlicht wurde. Nach einer Erneuerung (alle 30 Tage) widerruft ein
Sperren das **neue** Zertifikat, während im Bündel noch das alte steht — der
Filter griffe dann nicht. Weil das Gerät bei jeder Anmeldung neu
veröffentlicht, ist das Fenster in der Praxis klein, aber es ist nicht null.
Der vollständige Weg wäre ein Signal vom auth-svc („dieses Gerät ist weg"),
das das Bündel löscht; das gibt es heute nicht und ist **eine eigene
Aufgabe**. Wer hier später aufräumt, findet diesen Absatz.

- [ ] **Schritt 5: Tests laufen lassen** (voller Dienst, `-n 4`).

- [ ] **Schritt 6: `bash scripts/gate.sh`** — grün, bevor committet wird.

- [ ] **Schritt 7: Committen**

```bash
git commit -m "feat(krypto): Schluessel abholen, Einmalschluessel atomar verbrauchen"
```

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §2 „Der Server hält ein Verzeichnis" → Task 1 und 2.
„Ein Gerät darf nur für sich selbst veröffentlichen" → Task 2, `schluessel_nachweis.py`.
§2 Einmalschlüssel und Rückfallschlüssel → Task 3. §9 „die Schlüssel-Route
liefert Bündel für eine **Liste** von Nutzern" → Task 3, `POST /keys/claim`
nimmt `user_ids`.

**Nicht in dieser Etappe:** das Postfach (Etappe D), der lokale Verlauf
(Etappe C), die Oberfläche. Diese Etappe bewegt nur Zeichenketten und benutzt
`pulse-krypto` nicht.

**Bewusst offen, mit Begründung im Code:** das Löschen eines Bündels, wenn ein
Gerät gesperrt wird — der Filter beim Abholen deckt den Normalfall, nicht das
Fenster nach einer Zertifikatserneuerung. Braucht ein Signal vom auth-svc und
ist eine eigene Aufgabe.

**Der Test, der am meisten wert ist**, und der deshalb nicht wegfallen darf,
wenn er unbequem wird: `test_zwei_gleichzeitige_abholungen_bekommen_verschiedene`.
Ein Einmalschlüssel, den zwei Absender bekommen, ist kein Schönheitsfehler,
sondern hebt die Zusicherung auf, für die es ihn gibt.
