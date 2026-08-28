# Self-Host-Anmeldung über Cloud-Ticket — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Aufgabe für Aufgabe umzusetzen. Die Schritte nutzen Checkbox-Syntax (`- [ ]`).

**Ziel:** Der Self-Host-Zugang läuft über ein kurzlebiges, von der Cloud ausgestelltes Ticket statt über ein Gerätezertifikat mit lokalem Schlüsselpaar.

**Architektur:** Der Browser holt bei der Cloud ein auf genau eine Instanz ausgestelltes JWT (60 s), legt es dem Self-Host vor, der prüft eine Signatur gegen die zwischengespeicherten Cloud-JWKS und gibt seine eigene Sitzung aus. Im Browser liegt danach kein Langzeitgeheimnis mehr. Der alte Cert-Weg bleibt während der Übergangszeit vollständig erhalten; entschieden wird über die Fähigkeit `server-ticket` im `hello`-Rahmen.

**Tech-Stack:** FastAPI, pydantic v2, SQLAlchemy[asyncio], pyjwt (RS256 Cloud, EdDSA Self-Host), Redis; SvelteKit 5 Runes, Node-eigener Testläufer (`pnpm test:unit`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-selfhost-identitaet-vereinfachung-design.md`

## Umfang dieses Plans

Dieser Plan setzt **Phase 1** der Spec um: den neuen Weg hinzufügen, ohne etwas zu löschen. Phase 2 (die Umschreibung wandert durch den Bestand) läuft danach von selbst, weil der Code aus Aufgabe 6 bei der ersten neuen Anmeldung feuert. **Phase 3 (Löschliste) ist NICHT Teil dieses Plans** — sie beginnt erst, wenn niemand mehr über `cert-login` anmeldet, und bekommt einen eigenen Plan.

## Global Constraints

- **Antworten und Commit-Nachrichten auf Deutsch.** Echte Umlaute in Changelog-Einträgen; Commit-Nachrichten ohne `Co-Authored-By`-Footer.
- **Keine neuen Abhängigkeiten** ohne Rückfrage. Alles hier kommt mit vorhandenen Paketen aus.
- **Ruff:** `line-length=100`, `target-version=py313`, `ignore=["E501"]`.
- **Größen-Policy** (`PLAN.md` §12.1): Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250. `routes/cert_login.py` steht bei 578 Zeilen und ist bereits darüber — **nichts Neues dort hineinschreiben**, neue Module anlegen.
- **Frontend-Unit-Tests laufen unter Nodes eigenem Läufer**, nicht Vitest. Eine geprüfte Datei darf **keinen erweiterungslosen Laufzeit-Import** haben (`from './nachbar'`) — reine Rechnungen gehören in ein importfreies Modul (Muster: `web/src/lib/navigation/tabs.ts`).
- **Niemals Token, Zertifikate, Signaturen oder Schlüssel loggen.**
- **Ticketlaufzeit 60 s, Uhrentoleranz 60 s, Sitzungsdauer 3600 s.** Diese drei Zahlen stehen je einmal im Code und werden importiert, nicht kopiert.
- **Backend-Tests:** `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q`. Vollgate: `bash scripts/gate.sh`.
- **Zweig-Workflow:** Feature-Zweig von frisch gepulltem `main`, Landen über `bash scripts/ship.sh`. Kein `git push` ohne Freigabe.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `services/auth/src/dcc_auth/server_ticket.py` (neu) | Ticket bauen und signieren; `legacy_uid` berechnen. Reine Funktionen, keine Route. |
| `services/auth/src/dcc_auth/routes_server_ticket.py` (neu) | `POST /me/server-ticket` — Sitzung prüfen, Instanz prüfen, Ticket ausgeben. |
| `shared/src/dcc_shared/session_tokens.py` (ändern) | `issue_session_token` bekommt `ttl_seconds`. |
| `services/chat-gateway/src/dcc_chat_gateway/ticket_pruefung.py` (neu) | Ticket prüfen: Signatur, `iss`/`aud`/`purpose`/`exp`, Einmal-Einlösung. Kennt keine Route. |
| `services/chat-gateway/src/dcc_chat_gateway/identitaet_umschreiben.py` (neu) | Die 25 unbedingten und 5 bedingten Spalten von `legacy_uid` auf die Cloud-Kennung heben. |
| `services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py` (neu) | `POST /session` — Ticket einlösen, Gates, Umschreibung, Sitzung ausgeben. |
| `services/chat-gateway/src/dcc_chat_gateway/routes/gates.py` (neu) | `_enforce_join_gate` und das Bann-Gate aus `cert_login.py` herausgezogen, damit beide Wege dieselbe Fassung nutzen. |
| `web/src/lib/servers/anmeldeweg.ts` (neu) | **Importfrei.** Entscheidet aus den Fähigkeiten, welcher Anmeldeweg gilt. |
| `web/src/lib/api/server-ticket.ts` (neu) | Ticket holen und einlösen. |
| `web/src/lib/api/anmelde-fehler.ts` (neu) | Ablehnungscode → Meldung mit Handgriff. |

---

### Aufgabe 1: Ticket bauen und signieren (Cloud)

**Dateien:**
- Anlegen: `services/auth/src/dcc_auth/server_ticket.py`
- Test: `services/auth/tests/test_server_ticket.py`

**Schnittstellen:**
- Verbraucht: `dcc_auth.security.get_signer()` (liefert `JwtSigner` mit `._private_key`), `get_settings().jwt_key_id`, `get_settings().pulse_oidc_issuer`.
- Stellt bereit: `ZWECK: str`, `TICKET_FRIST_S: int`, `baue_ticket(...) -> str`, `legacy_uid(user_id: str, instance_id: int, pairwise_salt: bytes) -> int`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
# services/auth/tests/test_server_ticket.py
import time

import jwt as pyjwt
import pytest

from dcc_auth.server_ticket import TICKET_FRIST_S, ZWECK, baue_ticket, legacy_uid


def test_ticket_traegt_zweck_publikum_und_frist():
    roh = baue_ticket(
        user_id="73315227868860416",
        instance_id=86083174400004096,
        name="GordonBradley",
        avatar="abc123",
        amr=["pwd"],
        acr="0",
        pairwise_salt=b"\x01" * 32,
    )
    c = pyjwt.decode(roh, options={"verify_signature": False}, audience="86083174400004096")
    assert c["purpose"] == ZWECK
    assert c["aud"] == "86083174400004096"
    assert c["sub"] == "73315227868860416"
    assert c["name"] == "GordonBradley"
    assert c["amr"] == ["pwd"]
    assert c["exp"] - c["iat"] == TICKET_FRIST_S
    # jti ist da und je Aufruf verschieden - daran haengt die Einmal-Einloesung.
    zweites = pyjwt.decode(
        baue_ticket(
            user_id="73315227868860416",
            instance_id=86083174400004096,
            name="G",
            avatar=None,
            amr=[],
            acr="0",
            pairwise_salt=b"\x01" * 32,
        ),
        options={"verify_signature": False},
        audience="86083174400004096",
    )
    assert c["jti"] != zweites["jti"]


def test_legacy_uid_stimmt_mit_der_selfhost_rechnung_ueberein():
    """Die Cloud muss dieselbe Zahl treffen, die der Self-Host bisher speichert.

    Sonst zeigt die Umschreibung (Aufgabe 6) auf Zeilen, die es nicht gibt.
    """
    from dcc_chat_gateway.credential_validator import compute_pairwise_sub
    from dcc_shared.session_tokens import synthesize_self_host_user_id

    salt = b"\x02" * 32
    seed = __import__("base64").urlsafe_b64encode(salt).rstrip(b"=").decode()
    erwartet = synthesize_self_host_user_id(
        compute_pairwise_sub("73315227868860416", 86083174400004096, seed)
    )
    assert legacy_uid("73315227868860416", 86083174400004096, salt) == erwartet


def test_ticket_ist_mit_dem_cloud_schluessel_signiert_und_traegt_kid():
    roh = baue_ticket(
        user_id="1", instance_id=2, name="x", avatar=None, amr=[], acr="0",
        pairwise_salt=b"\x03" * 32,
    )
    assert pyjwt.get_unverified_header(roh)["kid"]
    assert pyjwt.get_unverified_header(roh)["alg"] == "RS256"
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/auth/tests/test_server_ticket.py -q`
Erwartet: FAIL mit `ModuleNotFoundError: No module named 'dcc_auth.server_ticket'`

- [ ] **Schritt 3: Umsetzen**

```python
# services/auth/src/dcc_auth/server_ticket.py
"""Serverticket — der Ausweis, mit dem ein Nutzer sich bei EINEM Self-Host meldet.

Warum es das gibt
-----------------
Bis 2026-08 trug der Browser ein Gerätezertifikat mit einem Jahr Laufzeit und ein
Ed25519-Schlüsselpaar in der IndexedDB. Beides konnte verlorengehen, und die
Zuordnung „welches Gerät" hing an einem Etikett, das keine Identität war. Das
Ticket dreht die Richtung um: Nichts Langlebiges liegt beim Nutzer, die Cloud
stellt bei jeder Anmeldung einen frischen, auf genau einen Empfänger
ausgestellten Ausweis aus.

Warum die Frist so kurz ist
---------------------------
Ein Ticket ist unterwegs ein Inhaberpapier. Gegen Missbrauch wirken drei Dinge
zusammen, keines allein: die Frist, die Bindung an ein ``aud`` und die
Einmal-Einlösung über ``jti`` beim Empfänger (``ticket_pruefung.py``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
import uuid
from typing import Any

import jwt

from dcc_auth.config import get_settings
from dcc_auth.security import get_signer

#: Muss mit ``dcc_chat_gateway.ticket_pruefung.ZWECK`` übereinstimmen. Ein
#: Cloud-Token gilt nur für den Zweck, für den es ausgestellt wurde — sonst
#: genügte ein abgefangenes Token für jeden Zweck, den die Cloud kennt.
ZWECK = "server-session"

#: Lebensdauer des Tickets in Sekunden. Es reist zu einem fremden Server und ist
#: dort so lange ein Nachschlüssel. Gleicher Wert wie beim Betreiber-Check.
TICKET_FRIST_S = 60


def legacy_uid(user_id: str, instance_id: int, pairwise_salt: bytes) -> int:
    """Die synthetische Nutzer-ID, die dieser Nutzer auf DIESER Instanz bisher hatte.

    Der Self-Host kann sie nicht zurückrechnen (SHA-256), die Cloud aber
    vorwärts — sie hat den Salt. Nur dadurch ist die Umschreibung der
    Bestandszeilen überhaupt möglich.

    Die Rechnung ist bewusst hier nachgebaut statt importiert: ``dcc_auth`` hängt
    nicht von ``dcc_chat_gateway`` ab, und ein Import quer über die Dienstgrenze
    wäre eine Abhängigkeit, die es sonst nirgends gibt. Dass beide Fassungen
    dasselbe liefern, hält ein Test fest
    (``test_legacy_uid_stimmt_mit_der_selfhost_rechnung_ueberein``).
    """
    nachricht = f"{user_id}:{instance_id}".encode()
    abdruck = hmac.new(pairwise_salt, nachricht, hashlib.sha256).digest()
    pairwise_sub = base64.urlsafe_b64encode(abdruck).rstrip(b"=").decode()[:16]
    digest = hashlib.sha256(pairwise_sub.encode()).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFF_FFFF_FFFF_FFFF


def baue_ticket(
    *,
    user_id: str,
    instance_id: int,
    name: str,
    avatar: str | None,
    amr: list[str],
    acr: str,
    pairwise_salt: bytes,
) -> str:
    """Signiert ein Serverticket für genau eine Instanz."""
    settings = get_settings()
    jetzt = int(time.time())
    nutzlast: dict[str, Any] = {
        "iss": settings.pulse_oidc_issuer,
        "aud": str(instance_id),
        "sub": user_id,
        "purpose": ZWECK,
        "jti": str(uuid.uuid4()),
        "name": name,
        "avatar": avatar,
        # Übernommen aus dem bisherigen Zertifikat: daran hängt, ob ein Server
        # für heikle Aktionen einen zweiten Faktor verlangen kann. Ohne sie wäre
        # diese Möglichkeit stillschweigend weg.
        "amr": amr,
        "acr": acr,
        # Nur für die Übergangszeit, s. Spec „Migration". Fällt mit Phase 3.
        "legacy_uid": legacy_uid(user_id, instance_id, pairwise_salt),
        "iat": jetzt,
        "exp": jetzt + TICKET_FRIST_S,
    }
    return jwt.encode(
        nutzlast,
        get_signer()._private_key,
        algorithm="RS256",
        headers={"kid": settings.jwt_key_id},
    )
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/auth/tests/test_server_ticket.py -q`
Erwartet: 3 passed

- [ ] **Schritt 5: Committen**

```bash
git add services/auth/src/dcc_auth/server_ticket.py services/auth/tests/test_server_ticket.py
git commit -m "feat(auth): Serverticket bauen und signieren"
```

---

### Aufgabe 2: Die Route, die das Ticket ausgibt (Cloud)

**Dateien:**
- Anlegen: `services/auth/src/dcc_auth/routes_server_ticket.py`
- Ändern: `services/auth/src/dcc_auth/app.py` (Router einhängen)
- Test: `services/auth/tests/test_server_ticket_route.py`

**Schnittstellen:**
- Verbraucht: `baue_ticket` aus Aufgabe 1; `dcc_auth.routes_instance_applications._require_user(request, db) -> User`; `dcc_auth.models_instances.RegisteredInstance`; `dcc_auth.models_instances.SuspendedInstance`.
- Stellt bereit: `POST /me/server-ticket` mit Rumpf `{"instance_id": "<str>"}` → `{"ticket": "<jwt>", "expires_in": 60}`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
# services/auth/tests/test_server_ticket_route.py
import jwt as pyjwt
import pytest

from tests.test_credentials_endpoints import _reg_and_login  # bestehende Helfer


async def _instanz_anlegen(app, *, iid: int, hostname: str, besitzer: int, status: str = "active"):
    from dcc_auth.models_instances import RegisteredInstance

    async with app.state.session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid, hostname=hostname, client_id=f"c{iid}", client_secret="x",
                worker_id_chat=iid % 900 + 1, worker_id_voice=iid % 900 + 2,
                worker_id_media=iid % 900 + 3, status=status, registered_by=besitzer,
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_ticket_wird_auf_die_angefragte_instanz_ausgestellt(client, app):
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(app, iid=900001, hostname="a.example.com", besitzer=int(user_id))

    r = await client.post(
        "/me/server-ticket", json={"instance_id": "900001"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 200, r.text
    c = pyjwt.decode(
        r.json()["ticket"], options={"verify_signature": False}, audience="900001"
    )
    assert c["aud"] == "900001"
    assert c["sub"] == str(user_id)
    assert r.json()["expires_in"] == 60


@pytest.mark.asyncio
async def test_ohne_anmeldung_kein_ticket(client, app):
    await _instanz_anlegen(app, iid=900002, hostname="b.example.com", besitzer=1)
    r = await client.post("/me/server-ticket", json={"instance_id": "900002"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_unbekannte_instanz_gibt_404(client, app):
    cookie, _ = await _reg_and_login(client)
    r = await client.post(
        "/me/server-ticket", json={"instance_id": "999999"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_gesperrte_instanz_bekommt_kein_ticket(client, app):
    """Die Sperre wirkt schon beim Ausstellen, nicht erst beim Einloesen.

    Sonst reist ein gueltiges Ticket zu einem Server, der es ohnehin ablehnt -
    und der Nutzer sieht einen Fehler des Servers statt der wahren Ursache.
    """
    from dcc_auth.models_instances import SuspendedInstance

    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(app, iid=900003, hostname="c.example.com", besitzer=int(user_id))
    async with app.state.session_factory() as s:
        s.add(SuspendedInstance(instance_id=900003, reason="Test"))
        await s.commit()

    r = await client.post(
        "/me/server-ticket", json={"instance_id": "900003"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "instance_suspended"
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/auth/tests/test_server_ticket_route.py -q`
Erwartet: FAIL — alle vier mit 404, weil die Route nicht existiert.

- [ ] **Schritt 3: Umsetzen**

```python
# services/auth/src/dcc_auth/routes_server_ticket.py
"""``POST /me/server-ticket`` — den Ausweis für EINEN Self-Host holen.

Die Route entscheidet ausdrücklich NICHT, ob der Nutzer auf diesen Server darf.
Das bleibt die Sache des Betreibers (Beitritts-Gate im chat-gateway). Das Ticket
sagt „das ist dieser Mensch", nicht „lass ihn rein".
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.server_ticket import TICKET_FRIST_S, baue_ticket

router = APIRouter(tags=["self-host"])


class TicketEin(BaseModel):
    instance_id: str = Field(..., min_length=1, max_length=32)


class TicketAus(BaseModel):
    ticket: str
    expires_in: int


@router.post("/me/server-ticket", response_model=TicketAus)
async def server_ticket(
    payload: TicketEin,
    request: Request,
    db: SessionDep,
    accept_language: Annotated[str | None, Header()] = None,
) -> TicketAus:
    from dcc_auth.routes_instance_applications import _require_user

    user = await _require_user(request, db)

    try:
        iid = int(payload.instance_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found") from exc

    inst = await db.get(RegisteredInstance, iid)
    # 404 statt 403 fuer „gibt es nicht" UND „nicht aktiv": ein Fremder soll aus
    # der Antwort nicht ablesen koennen, welche Instanz-Kennungen vergeben sind.
    if inst is None or inst.status != "active":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    gesperrt = (
        await db.execute(
            select(SuspendedInstance.instance_id).where(
                SuspendedInstance.instance_id == iid
            )
        )
    ).scalar_one_or_none()
    if gesperrt is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance_suspended")

    return TicketAus(
        ticket=baue_ticket(
            user_id=str(user.id),
            instance_id=iid,
            name=user.username,
            avatar=user.avatar_hash,
            amr=["pwd"],
            acr="0",
            pairwise_salt=user.pairwise_salt,
        ),
        expires_in=TICKET_FRIST_S,
    )
```

Router einhängen in `services/auth/src/dcc_auth/app.py` — dort, wo die übrigen `include_router`-Zeilen stehen:

```python
from dcc_auth.routes_server_ticket import router as server_ticket_router
app.include_router(server_ticket_router)
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/auth/tests/test_server_ticket_route.py -q`
Erwartet: 4 passed

Die Feldnamen sind geprüft (`models.py::User`): `username`, `avatar_hash`, `pairwise_salt`. **`avatar_hash`, nicht `avatar_url`** — ein Self-Host holt Cloud-Avatare inhaltsadressiert über den Hash, damit die Cloud nicht erfährt, wer bei wem zuschaut.

- [ ] **Schritt 5: Ratenlimit setzen**

Die Spec verlangt den Ratenschutz **hier**, im auth-svc — er ist der einzige der beiden Dienste, der einen Begrenzer führt. Das ist der Gewinn gegenüber heute: Der Cert-Weg musste sich im chat-gateway einen eigenen In-Prozess-Zähler halten, weil dort keiner existiert.

**Nicht der `slowapi`-Dekorator.** `Limiter` ist zwar importiert (`routes.py:75`), das tatsächliche Limit läuft aber über `_check_rate()` — ein gleitendes Fenster im Prozess. Der Kommentar an Ort und Stelle nennt den Grund: slowapis Starlette-Middleware hängt an globalem Zustand und macht die Testisolierung unbrauchbar.

```python
from dcc_auth.routes import _check_rate

await _check_rate(
    request, "server_ticket", settings.rate_limit_server_ticket, account=str(user.id)
)
```

Dazu `rate_limit_server_ticket: str = "60/minute"` in `config.py`, bei den übrigen `rate_limit_*`.

60 pro Minute und IP: Ein Ticket gilt 60 s, und ein Nutzer mit mehreren Geräten und Tabs hinter einer NAT-Adresse holt in der Spitze mehrere pro Minute. Der frühere Wert am Cert-Weg war zu knapp gewählt (10) und musste auf 30 nachgezogen werden, nachdem er echte Anmeldungen abwies — hier von vornherein grosszügiger, weil die Route eine bestehende Cloud-Anmeldung voraussetzt und damit kein anonymes Ziel ist.

Ein Test dafür:

```python
@pytest.mark.asyncio
async def test_ratenlimit_greift(client, app):
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(app, iid=900004, hostname="d.example.com", besitzer=int(user_id))
    letzte = None
    for _ in range(61):
        letzte = await client.post(
            "/me/server-ticket", json={"instance_id": "900004"}, headers={"Cookie": cookie}
        )
    assert letzte.status_code == 429
```

- [ ] **Schritt 6: Committen**

```bash
git add services/auth/src/dcc_auth/routes_server_ticket.py services/auth/src/dcc_auth/app.py services/auth/tests/test_server_ticket_route.py
git commit -m "feat(auth): POST /me/server-ticket gibt den Ausweis fuer einen Self-Host aus"
```

---

### Aufgabe 3: Sitzungsdauer parametrisierbar machen

**Dateien:**
- Ändern: `shared/src/dcc_shared/session_tokens.py:220-246`
- Test: `services/chat-gateway/tests/test_session_tokens.py`

**Schnittstellen:**
- Stellt bereit: `issue_session_token(user_identifier, cert_id, *, key_path=..., admin=False, ttl_seconds=SESSION_TTL_SECONDS)`.

Warum: Die Fünf-Minuten-Frist war die Antwort auf die Zertifikats-Sperrliste. Mit dem Ticket-Weg entfällt ihr Grund; die Spec setzt eine Stunde. Der alte Cert-Weg behält 300 s, deshalb ein Vorgabewert statt einer Änderung der Konstanten.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
# ans Ende von services/chat-gateway/tests/test_session_tokens.py
def test_ttl_ist_ueberschreibbar_und_bleibt_sonst_bei_fuenf_minuten(tmp_path):
    from dcc_shared.session_tokens import (
        SESSION_TTL_SECONDS,
        issue_session_token,
        validate_session_token,
    )

    pfad = str(tmp_path / "session_signing.pem")
    kurz = issue_session_token("nutzer", "kein-cert", key_path=pfad)
    lang = issue_session_token("nutzer", "kein-cert", key_path=pfad, ttl_seconds=3600)

    k = validate_session_token(kurz, key_path=pfad)
    l = validate_session_token(lang, key_path=pfad)
    assert k.exp - k.iat == SESSION_TTL_SECONDS
    assert l.exp - l.iat == 3600
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_session_tokens.py -k ttl_ist_ueberschreibbar -q`
Erwartet: FAIL mit `TypeError: issue_session_token() got an unexpected keyword argument 'ttl_seconds'`

- [ ] **Schritt 3: Umsetzen**

In `shared/src/dcc_shared/session_tokens.py` die Signatur erweitern und die Nutzlast anpassen:

```python
def issue_session_token(
    user_identifier: str,
    cert_id: str,
    *,
    key_path: str = "./data/jwt_keys/session_signing.pem",
    admin: bool = False,
    ttl_seconds: int = SESSION_TTL_SECONDS,
) -> str:
```

und in der Nutzlast `"exp": now + SESSION_TTL_SECONDS` ersetzen durch `"exp": now + ttl_seconds`.

Über den neuen Parameter dieser Kommentar:

```python
    #: ``ttl_seconds`` ist Vorgabe, nicht Konstante: Der Cert-Weg behält seine
    #: fünf Minuten (sie waren die Antwort auf die Zertifikats-Sperrliste, die es
    #: dort noch gibt), der Ticket-Weg setzt eine Stunde. Zwei Wege, zwei Fristen,
    #: eine Funktion.
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_session_tokens.py -q`
Erwartet: alle grün, keine Regression bei den bestehenden Tests.

- [ ] **Schritt 5: Committen**

```bash
git add shared/src/dcc_shared/session_tokens.py services/chat-gateway/tests/test_session_tokens.py
git commit -m "feat(shared): Sitzungsdauer je Anmeldeweg waehlbar"
```

---

### Aufgabe 4: Ticket prüfen (Self-Host)

**Dateien:**
- Anlegen: `services/chat-gateway/src/dcc_chat_gateway/ticket_pruefung.py`
- Test: `services/chat-gateway/tests/test_ticket_pruefung.py`

**Schnittstellen:**
- Verbraucht: `dcc_chat_gateway.credential_validator._get_jwks_keys(redis) -> dict[str, RSAPublicKey]`.
- Stellt bereit: `ZWECK`, `ZEITTOLERANZ_S`, `TicketFehler(Exception)` mit `.code: str`, `TicketDaten` (Dataclass: `sub`, `name`, `avatar`, `amr`, `acr`, `legacy_uid`, `jti`), `async pruefe_ticket(roh: str, *, instanz_id: int, cloud_issuer: str, redis) -> TicketDaten`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
# services/chat-gateway/tests/test_ticket_pruefung.py
import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from dcc_chat_gateway.ticket_pruefung import TicketFehler, ZWECK, pruefe_ticket

SCHLUESSEL = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = "test-1"
ISS = "https://howispulse.com"


def _ticket(**ueberschreiben):
    jetzt = int(time.time())
    n = {
        "iss": ISS, "aud": "42", "sub": "7", "purpose": ZWECK, "jti": "j1",
        "name": "G", "avatar": None, "amr": [], "acr": "0", "legacy_uid": 123,
        "iat": jetzt, "exp": jetzt + 60,
    }
    n.update(ueberschreiben)
    return pyjwt.encode(n, SCHLUESSEL, algorithm="RS256", headers={"kid": KID})


@pytest.fixture(autouse=True)
def jwks(monkeypatch):
    async def _keys(_redis):
        return {KID: SCHLUESSEL.public_key()}

    monkeypatch.setattr("dcc_chat_gateway.ticket_pruefung._get_jwks_keys", _keys)


class FakeRedis:
    def __init__(self):
        self.gesetzt = {}

    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.gesetzt:
            return None
        self.gesetzt[key] = value
        return True


@pytest.mark.asyncio
async def test_gueltiges_ticket_wird_angenommen():
    d = await pruefe_ticket(_ticket(), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis())
    assert d.sub == "7"
    assert d.legacy_uid == 123


@pytest.mark.asyncio
async def test_fremdes_publikum_wird_abgelehnt():
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(_ticket(aud="99"), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis())
    assert e.value.code == "ticket_wrong_audience"


@pytest.mark.asyncio
async def test_falscher_zweck_wird_abgelehnt():
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(purpose="owner-check"), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis()
        )
    assert e.value.code == "ticket_wrong_purpose"


@pytest.mark.asyncio
async def test_abgelaufenes_ticket_wird_abgelehnt():
    jetzt = int(time.time())
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(iat=jetzt - 300, exp=jetzt - 240),
            instanz_id=42, cloud_issuer=ISS, redis=FakeRedis(),
        )
    assert e.value.code == "ticket_expired"


@pytest.mark.asyncio
async def test_zweite_einloesung_desselben_tickets_wird_abgelehnt():
    r = FakeRedis()
    roh = _ticket()
    await pruefe_ticket(roh, instanz_id=42, cloud_issuer=ISS, redis=r)
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(roh, instanz_id=42, cloud_issuer=ISS, redis=r)
    assert e.value.code == "ticket_replayed"


@pytest.mark.asyncio
async def test_kalte_jwks_sind_ein_eigener_befund(monkeypatch):
    """Ohne Cloud-Schluessel ist die Signatur nicht pruefbar - das ist kein
    ungueltiges Ticket, sondern ein Server, der die Cloud nie erreicht hat.
    Zwei verschiedene Handgriffe, deshalb zwei Codes."""
    async def _leer(_redis):
        return {}

    monkeypatch.setattr("dcc_chat_gateway.ticket_pruefung._get_jwks_keys", _leer)
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(_ticket(), instanz_id=42, cloud_issuer=ISS, redis=FakeRedis())
    assert e.value.code == "jwks_cold"
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_ticket_pruefung.py -q`
Erwartet: FAIL mit `ModuleNotFoundError: No module named 'dcc_chat_gateway.ticket_pruefung'`

- [ ] **Schritt 3: Umsetzen**

```python
# services/chat-gateway/src/dcc_chat_gateway/ticket_pruefung.py
"""Serverticket prüfen — die einzige Stelle, an der ein Cloud-Ausweis gilt.

Drei Eigenschaften ersetzen zusammen die frühere Signatur über eine
Server-Nonce; keine davon genügt allein:

* **Frist** (60 s plus Uhrentoleranz) — ein abgefangenes Ticket veraltet schnell.
* **``aud``** — es taugt nur für genau diese Instanz, nicht für eine andere.
* **``jti`` einmalig** — es taugt nur ein einziges Mal.

Kennt bewusst keine Route und keine Datenbank: Was „gültig" heisst, gehört nicht
in denselben Kasten wie „wer darf rein" (das ist das Beitritts-Gate) und „wer ist
das" (das ist die Sitzung).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import jwt

from dcc_chat_gateway.credential_validator import _get_jwks_keys

#: Muss mit ``dcc_auth.server_ticket.ZWECK`` übereinstimmen.
ZWECK = "server-session"

#: Zugestandener Uhrenversatz gegenüber der Cloud, in Sekunden. Gleich der
#: Lebensdauer des Tickets: mehr wäre geschenkte Gültigkeit, weniger liesse einen
#: leicht falsch gehenden Server durchfallen, obwohl an ihm nichts fehlt.
ZEITTOLERANZ_S = 60

_VERBRAUCHT_PREFIX = "ticket:verbraucht:"


class TicketFehler(Exception):
    """Ablehnung mit einem Code, der bis in die Oberfläche reist.

    Der Code ist der ganze Zweck dieser Klasse. Die Vorgängerlösung warf jeden
    Grund weg und zeigte „Anmeldung abgelaufen oder Server nicht erreichbar" —
    eine Meldung, aus der niemand einen Handgriff ableiten konnte.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TicketDaten:
    sub: str
    name: str
    avatar: str | None
    amr: list[str]
    acr: str
    legacy_uid: int | None
    jti: str


async def pruefe_ticket(
    roh: str, *, instanz_id: int, cloud_issuer: str, redis: Any
) -> TicketDaten:
    """Prüft ein Serverticket und gibt seinen Inhalt zurück. Wirft ``TicketFehler``."""
    try:
        kopf = jwt.get_unverified_header(roh)
    except jwt.PyJWTError as exc:
        raise TicketFehler("ticket_malformed") from exc

    schluessel = await _get_jwks_keys(redis)
    if not schluessel:
        # Kein Schlüssel da heisst nicht „falsches Ticket", sondern „dieser
        # Server hat die Cloud noch nie erreicht". Anderer Handgriff, anderer Code.
        raise TicketFehler("jwks_cold")
    pubkey = schluessel.get(kopf.get("kid", ""))
    if pubkey is None:
        raise TicketFehler("jwks_cold")

    try:
        c = jwt.decode(
            roh,
            pubkey,
            algorithms=["RS256"],
            audience=str(instanz_id),
            issuer=cloud_issuer,
            leeway=ZEITTOLERANZ_S,
        )
    except jwt.ExpiredSignatureError as exc:
        raise TicketFehler("ticket_expired") from exc
    except jwt.InvalidAudienceError as exc:
        raise TicketFehler("ticket_wrong_audience") from exc
    except jwt.InvalidIssuerError as exc:
        raise TicketFehler("ticket_wrong_issuer") from exc
    except jwt.PyJWTError as exc:
        raise TicketFehler("ticket_invalid") from exc

    if c.get("purpose") != ZWECK:
        raise TicketFehler("ticket_wrong_purpose")

    jti = str(c.get("jti") or "")
    if not jti:
        raise TicketFehler("ticket_invalid")
    # Einmal-Einlösung. Der Ablauf ist grosszügiger als die Ticketfrist, damit
    # die Marke ein Ticket überlebt, das mit voller Uhrentoleranz ankommt.
    frisch = await redis.set(
        f"{_VERBRAUCHT_PREFIX}{jti}", "1", nx=True, ex=ZEITTOLERANZ_S * 4
    )
    if not frisch:
        raise TicketFehler("ticket_replayed")

    legacy = c.get("legacy_uid")
    return TicketDaten(
        sub=str(c["sub"]),
        name=str(c.get("name") or ""),
        avatar=c.get("avatar"),
        amr=list(c.get("amr") or []),
        acr=str(c.get("acr") or "0"),
        legacy_uid=int(legacy) if isinstance(legacy, int) else None,
        jti=jti,
    )
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_ticket_pruefung.py -q`
Erwartet: 6 passed

- [ ] **Schritt 5: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/ticket_pruefung.py services/chat-gateway/tests/test_ticket_pruefung.py
git commit -m "feat(chat): Serverticket pruefen - Frist, Publikum, Einmal-Einloesung"
```

---

### Aufgabe 5: Beitritts- und Bann-Gate herausziehen

**Dateien:**
- Anlegen: `services/chat-gateway/src/dcc_chat_gateway/routes/gates.py`
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/routes/cert_login.py` (importiert statt selbst zu definieren)
- Test: `services/chat-gateway/tests/test_join_gate.py` (bestehend, muss unverändert grün bleiben)

Warum vor der neuen Route: Beide Anmeldewege müssen **dieselbe** Fassung der Gates benutzen. Zwei Kopien wären genau die Bauform, gegen die dieser ganze Umbau gerichtet ist — und die eine würde still von der anderen abweichen, sobald jemand nur eine anfasst. Ausserdem steht `cert_login.py` bei 578 Zeilen über der Größen-Policy; das Herausziehen bringt sie darunter.

- [ ] **Schritt 1: Bestandstests als Netz laufen lassen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_join_gate.py services/chat-gateway/tests/test_cert_login.py -q`
Erwartet: alle grün. Diese Zahl ist der Massstab für Schritt 4 — notieren.

- [ ] **Schritt 2: Verschieben, nicht umschreiben**

`_enforce_join_gate` (ab `cert_login.py:390`) und den Bann-Block (`cert_login.py:536-547`) nach `routes/gates.py` verschieben. Der Bann-Block wird dabei zur Funktion:

```python
# services/chat-gateway/src/dcc_chat_gateway/routes/gates.py
"""Beitritts- und Bann-Gate — geteilt von beiden Anmeldewegen.

Herausgezogen aus ``cert_login.py``, als der Ticket-Weg dazukam. Zwei Kopien
dieser Entscheidungen wären die Bauform, gegen die der Umbau gerichtet ist: die
eine wiche still von der anderen ab, sobald jemand nur eine anfasst.
"""

from fastapi import HTTPException
from sqlalchemy import select

from dcc_chat_gateway.models import CachedUserProfile


async def enforce_ban_gate(session, identifier: str, is_owner_admin: bool) -> None:
    """403 ``instance banned``, wenn dieser Nutzer auf dieser Instanz gesperrt ist.

    Der Betreiber ist ausgenommen, damit ein Admin sich nicht dauerhaft selbst
    aussperren kann (versehentlicher Selbstbann).
    """
    if is_owner_admin:
        return
    banned_at = (
        await session.execute(
            select(CachedUserProfile.banned_at).where(
                CachedUserProfile.user_identifier == identifier
            )
        )
    ).scalar_one_or_none()
    if banned_at is not None:
        raise HTTPException(status_code=403, detail="instance banned")
```

`_enforce_join_gate` unverändert mitverschieben, als `enforce_join_gate` (ohne Unterstrich, weil jetzt öffentlich). In `cert_login.py` beide importieren und die Aufrufstellen anpassen.

- [ ] **Schritt 3: Reihenfolge prüfen**

Im Ticket-Weg wie im Cert-Weg gilt: erst Bann, dann Beitritt. Die Begründung steht im Kommentar bei `enforce_join_gate` und darf beim Verschieben nicht verlorengehen.

- [ ] **Schritt 4: Dieselben Tests erneut laufen lassen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_join_gate.py services/chat-gateway/tests/test_cert_login.py -q`
Erwartet: **exakt dieselbe Zahl grüner Tests wie in Schritt 1.** Bricht hier etwas, ist die Verschiebung falsch — nicht der Test.

Ausführen: `wc -l services/chat-gateway/src/dcc_chat_gateway/routes/cert_login.py`
Erwartet: unter 500.

- [ ] **Schritt 5: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/gates.py services/chat-gateway/src/dcc_chat_gateway/routes/cert_login.py
git commit -m "refactor(chat): Beitritts- und Bann-Gate in ein gemeinsames Modul"
```

---

### Aufgabe 6: Die Umschreibung der Nutzer-IDs

**Dateien:**
- Anlegen: `services/chat-gateway/src/dcc_chat_gateway/identitaet_umschreiben.py`
- Test: `services/chat-gateway/tests/test_identitaet_umschreiben.py`

**Schnittstellen:**
- Stellt bereit: `SPALTEN: list[tuple[str, str]]`, `BEDINGTE_SPALTEN: list[tuple[str, str, str, str]]`, `TEXT_SPALTEN: list[tuple[str, str]]`, `async umschreiben(session, *, alt_uid: int, neu_uid: int, alt_text: str, neu_text: str) -> int`.

**Achtung, der gefährlichste Teil des Plans.** Er fasst als einziger Bestandsdaten an, und ein Fehler ist nicht zurückzunehmen. Die Spaltenliste stammt aus dem Anhang der Spec; sie wird hier **neu erhoben** und gegen die Spec verglichen, statt sie abzuschreiben.

- [ ] **Schritt 1: Die Liste neu erheben und gegen die Spec halten**

```bash
python3 - <<'PY'
import re, pathlib
mdir = pathlib.Path("services/chat-gateway/src/dcc_chat_gateway/models")
for f in sorted(mdir.glob("*.py")):
    tab = None
    for z in f.read_text().splitlines():
        m = re.search(r'__tablename__\s*=\s*["\']([^"\']+)', z)
        if m: tab = m.group(1)
        m2 = re.match(r'\s*(\w*(?:user_id|author_id|owner_id|actor_id|user_identifier|synthetic_user_id))\s*:\s*Mapped', z)
        if m2 and tab: print(tab, m2.group(1), "TEXT" if "Text" in z else "BIGINT")
PY
```

Erwartet: 25 Zeilen, 21 Tabellen — identisch mit dem Anhang der Spec. **Weicht etwas ab, ist seit dem 2026-08-28 eine Tabelle dazugekommen; dann diesen Plan anhalten und die Spec nachziehen, bevor es weitergeht.**

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

```python
# services/chat-gateway/tests/test_identitaet_umschreiben.py
import pytest
from sqlalchemy import text

from dcc_chat_gateway.identitaet_umschreiben import (
    BEDINGTE_SPALTEN,
    SPALTEN,
    TEXT_SPALTEN,
    umschreiben,
)

ALT = 4611686018427387904
NEU = 73315227868860416


@pytest.mark.asyncio
async def test_jede_einzelne_spalte_wandert(session_factory):
    """Jede Spalte einzeln geprueft, nicht stichprobenartig.

    Eine vergessene Spalte faellt sonst erst Monate spaeter als verwaister
    Datensatz auf - und dann ist die Ursache nicht mehr auffindbar.
    """
    async with session_factory() as s:
        for tabelle, spalte in SPALTEN:
            await s.execute(
                text(f"INSERT INTO {tabelle} ({spalte}) VALUES (:v)").bindparams(v=ALT)
            )
        await s.commit()

    async with session_factory() as s:
        await umschreiben(s, alt_uid=ALT, neu_uid=NEU, alt_text="pw", neu_text=str(NEU))
        await s.commit()

    async with session_factory() as s:
        for tabelle, spalte in SPALTEN:
            uebrig = (
                await s.execute(
                    text(f"SELECT count(*) FROM {tabelle} WHERE {spalte} = :v").bindparams(v=ALT)
                )
            ).scalar_one()
            assert uebrig == 0, f"{tabelle}.{spalte} wurde nicht umgeschrieben"


@pytest.mark.asyncio
async def test_bedingte_spalte_ruehrt_rollen_nicht_an(session_factory):
    """permission_overwrites.target_id traegt bei target_type=0 eine ROLLE.

    Wuerde die Umschreibung sie mitnehmen, verloere ein Kanal seine
    Rollen-Rechte - und zwar lautlos.
    """
    async with session_factory() as s:
        await s.execute(
            text(
                "INSERT INTO permission_overwrites (channel_id, target_type, target_id, allow, deny) "
                "VALUES (1, 0, :v, 0, 0), (2, 1, :v, 0, 0)"
            ).bindparams(v=ALT)
        )
        await s.commit()
        await umschreiben(s, alt_uid=ALT, neu_uid=NEU, alt_text="pw", neu_text=str(NEU))
        await s.commit()

        rolle = (
            await s.execute(
                text("SELECT target_id FROM permission_overwrites WHERE target_type = 0")
            )
        ).scalar_one()
        nutzer = (
            await s.execute(
                text("SELECT target_id FROM permission_overwrites WHERE target_type = 1")
            )
        ).scalar_one()
    assert rolle == ALT, "die Rolle wurde faelschlich mitgenommen"
    assert nutzer == NEU


@pytest.mark.asyncio
async def test_kollision_bricht_ab_statt_zu_ueberschreiben(session_factory):
    """Traegt die Ziel-Kennung schon eine andere Identitaet, wird nicht
    geschrieben. Rechnerisch ausgeschlossen ist kein Grund, die Pruefung
    wegzulassen, wenn sie eine Zeile kostet."""
    async with session_factory() as s:
        await s.execute(
            text("INSERT INTO guild_members (guild_id, user_id) VALUES (1, :alt), (2, :neu)")
            .bindparams(alt=ALT, neu=NEU)
        )
        await s.commit()
        with pytest.raises(ValueError, match="Kollision"):
            await umschreiben(s, alt_uid=ALT, neu_uid=NEU, alt_text="pw", neu_text=str(NEU))
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_identitaet_umschreiben.py -q`
Erwartet: FAIL mit `ModuleNotFoundError: No module named 'dcc_chat_gateway.identitaet_umschreiben'`

- [ ] **Schritt 4: Umsetzen**

```python
# services/chat-gateway/src/dcc_chat_gateway/identitaet_umschreiben.py
"""Bestandszeilen von der synthetischen ID auf die Cloud-Kennung heben.

Warum es das gibt
-----------------
Bis zum Ticket-Weg trug ein Self-Host je Nutzer eine synthetische ID
(``SHA256(pairwise_sub)[:8]``). Der Server kann sie nicht zurückrechnen, die
Cloud aber vorwärts — sie liefert sie als ``legacy_uid`` im Ticket mit. Beim
ersten Anmelden auf dem neuen Weg wandern die Zeilen dieses einen Nutzers.

Warum die bedingten Spalten getrennt stehen
-------------------------------------------
``target_id``, ``subject_id`` und Geschwister heissen nicht nach einem Nutzer und
sind es nur manchmal — abhängig von einer Nachbarspalte. Eine Liste, die über
Spaltennamen entsteht, findet sie nicht. Genau diese Fehlerklasse hat im Projekt
schon bei Bau-Rezepten und Lizenztexten zugeschlagen: Was in keinem Namensmuster
steht, fällt aus der Liste und in keinem Test auf.

Was NICHT umgeschrieben wird
----------------------------
Verlaufsdaten. ``admin_audit_log.target_id`` hat gar keinen Diskriminator (der
Typ steckt implizit in ``action``), und beide Audit-Tabellen führen freies
``payload``-JSON, in das kein ``UPDATE`` hineinsieht. Ein Audit-Eintrag hält
fest, was unter der damals gültigen Identität geschah; ihn nachträglich
umzuschreiben wäre eine Fälschung des Protokolls. Preis, bewusst und
dokumentiert: Ein solcher Eintrag verweist danach auf eine Kennung, die nirgends
mehr auflöst.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

#: (Tabelle, Spalte) — trägt IMMER eine Nutzer-ID.
SPALTEN: list[tuple[str, str]] = [
    ("devices", "owner_user_id"),
    ("device_grants", "created_by_user_id"),
    ("user_privacy", "user_id"),
    ("guilds", "owner_id"),
    ("guild_members", "user_id"),
    ("guild_bans", "user_id"),
    ("community_invite_notifications", "inviter_user_id"),
    ("community_invite_notifications", "invitee_user_id"),
    ("messages", "author_id"),
    ("message_reactions", "user_id"),
    ("cached_user_profiles", "synthetic_user_id"),
    ("reports", "reporter_user_id"),
    ("reports", "target_user_id"),
    ("reports", "resolver_user_id"),
    ("web_push_subscriptions", "user_id"),
    ("instance_plugin_allowlist", "added_by_user_id"),
    ("guild_plugins", "enabled_by_user_id"),
    ("guild_plugin_state", "updated_by_user_id"),
    ("member_roles", "user_id"),
    ("user_preferences", "user_id"),
    ("channel_voice_pulls", "user_id"),
]

#: (Tabelle, Spalte, Bedingungsspalte, Wert) — Nutzer-ID nur bei diesem Wert.
BEDINGTE_SPALTEN: list[tuple[str, str, str, str]] = [
    ("permission_overwrites", "target_id", "target_type", "1"),
    ("message_mentions", "target_id", "mention_type", "0"),
    ("device_grants", "subject_id", "subject_type", "'user'"),
    ("mod_audit_log", "target_id", "target_kind", "'user'"),
]

#: (Tabelle, Spalte) — lautet heute auf das Pseudonym, künftig auf die Kennung.
TEXT_SPALTEN: list[tuple[str, str]] = [
    ("instance_members", "user_identifier"),
    ("cached_user_profiles", "user_identifier"),
]

#: Wo eine Kollision überhaupt schaden könnte: Tabellen, in denen die Kennung
#: eine Identität benennt statt sie nur zu erwähnen.
_KOLLISIONSPRUEFUNG = [("guild_members", "user_id"), ("cached_user_profiles", "synthetic_user_id")]


async def umschreiben(
    session: Any, *, alt_uid: int, neu_uid: int, alt_text: str, neu_text: str
) -> int:
    """Hebt alle Zeilen eines Nutzers auf die neue Kennung. Gibt die Zahl der
    geänderten Zeilen zurück. Wirft ``ValueError`` bei einer Kollision.

    Der Aufrufer sorgt für die Transaktion und dafür, dass das nur einmal je
    Nutzer läuft.
    """
    for tabelle, spalte in _KOLLISIONSPRUEFUNG:
        vorhanden = (
            await session.execute(
                text(f"SELECT count(*) FROM {tabelle} WHERE {spalte} = :neu").bindparams(
                    neu=neu_uid
                )
            )
        ).scalar_one()
        if vorhanden:
            raise ValueError(
                f"Kollision: {tabelle}.{spalte} traegt {neu_uid} bereits — nicht umgeschrieben"
            )

    geaendert = 0
    for tabelle, spalte in SPALTEN:
        r = await session.execute(
            text(f"UPDATE {tabelle} SET {spalte} = :neu WHERE {spalte} = :alt").bindparams(
                neu=neu_uid, alt=alt_uid
            )
        )
        geaendert += r.rowcount or 0
    for tabelle, spalte, bed_spalte, bed_wert in BEDINGTE_SPALTEN:
        r = await session.execute(
            text(
                f"UPDATE {tabelle} SET {spalte} = :neu "
                f"WHERE {spalte} = :alt AND {bed_spalte} = {bed_wert}"
            ).bindparams(neu=neu_uid, alt=alt_uid)
        )
        geaendert += r.rowcount or 0
    for tabelle, spalte in TEXT_SPALTEN:
        r = await session.execute(
            text(f"UPDATE {tabelle} SET {spalte} = :neu WHERE {spalte} = :alt").bindparams(
                neu=neu_text, alt=alt_text
            )
        )
        geaendert += r.rowcount or 0
    return geaendert
```

- [ ] **Schritt 5: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_identitaet_umschreiben.py -q`
Erwartet: 3 passed

- [ ] **Schritt 6: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/identitaet_umschreiben.py services/chat-gateway/tests/test_identitaet_umschreiben.py
git commit -m "feat(chat): Bestandszeilen auf die Cloud-Kennung heben"
```

---

### Aufgabe 7: Die Route, die das Ticket einlöst (Self-Host)

**Dateien:**
- Anlegen: `services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py`
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/app.py` (Router einhängen)
- Test: `services/chat-gateway/tests/test_session_ticket_route.py`

**Schnittstellen:**
- Verbraucht: `pruefe_ticket`, `TicketFehler` (Aufgabe 4); `enforce_join_gate`, `enforce_ban_gate` (Aufgabe 5); `umschreiben` (Aufgabe 6); `issue_session_token(..., ttl_seconds=)` (Aufgabe 3); `raise_if_suspended(redis)`.
- Stellt bereit: `POST /session` mit `{"ticket": "<jwt>"}` → `{"session_token": "<jwt>", "expires_in": 3600}`; `SITZUNGSDAUER_S = 3600`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
# services/chat-gateway/tests/test_session_ticket_route.py
import pytest


@pytest.mark.asyncio
async def test_gueltiges_ticket_ergibt_eine_sitzung(client, ticket_bauer):
    r = await client.post("/session", json={"ticket": ticket_bauer(sub="7")})
    assert r.status_code == 200, r.text
    assert r.json()["expires_in"] == 3600
    assert r.json()["session_token"]


@pytest.mark.asyncio
async def test_der_betreiber_wird_als_admin_erkannt(client, ticket_bauer, settings_owner_7):
    """Admin entsteht auf einem Self-Host an genau EINER Stelle - dem Vergleich
    der Kennung aus dem Ausweis mit PULSE_INSTANCE_OWNER_ID. Der Ticket-Weg
    aendert daran nichts, er macht den Vergleich nur geradliniger."""
    from dcc_shared.session_tokens import validate_session_token

    r = await client.post("/session", json={"ticket": ticket_bauer(sub="7")})
    claims = validate_session_token(r.json()["session_token"], key_path=settings_owner_7)
    assert claims.admin is True


@pytest.mark.asyncio
async def test_abgelehntes_ticket_nennt_seinen_grund(client, ticket_bauer):
    """Der Grund reist bis in die Oberflaeche. Genau das fehlte am 2026-08-28
    und kostete zwei Stunden Fehlersuche an einem gesunden Server."""
    r = await client.post("/session", json={"ticket": ticket_bauer(aud="999")})
    assert r.status_code == 403
    assert r.json()["detail"] == "ticket_wrong_audience"


@pytest.mark.asyncio
async def test_gesperrte_instanz_gibt_keine_sitzung(client, ticket_bauer, gesperrt):
    r = await client.post("/session", json={"ticket": ticket_bauer(sub="7")})
    assert r.status_code == 403
    assert r.json()["detail"] in {"instance_suspended", "instance_deleted"}


@pytest.mark.asyncio
async def test_erste_anmeldung_schreibt_die_bestandszeilen_um(client, ticket_bauer, alt_bestand):
    """alt_bestand legt eine Nachricht unter der synthetischen ID an."""
    from sqlalchemy import text

    await client.post("/session", json={"ticket": ticket_bauer(sub="7", legacy_uid=alt_bestand)})
    async with client.app.state.session_factory() as s:
        uebrig = (
            await s.execute(
                text("SELECT count(*) FROM messages WHERE author_id = :v").bindparams(
                    v=alt_bestand
                )
            )
        ).scalar_one()
    assert uebrig == 0
```

Die Fixtures `ticket_bauer`, `settings_owner_7`, `gesperrt` und `alt_bestand` gehören in `services/chat-gateway/tests/conftest.py`. `ticket_bauer` signiert mit einem Testschlüssel, der über denselben `monkeypatch` auf `_get_jwks_keys` bekannt gemacht wird wie in Aufgabe 4.

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_session_ticket_route.py -q`
Erwartet: FAIL — 404, die Route existiert nicht.

- [ ] **Schritt 3: Umsetzen**

```python
# services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py
"""``POST /session`` — ein Cloud-Ticket gegen eine Sitzung dieses Servers tauschen.

Die Reihenfolge der Prüfungen ist nicht beliebig; sie steht so in der Spec:
Sperre der Instanz, Ticket, Bann des Nutzers, Beitritt. Zuerst das, was den
ganzen Server betrifft, dann das Papier, dann die Person.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.identitaet_umschreiben import umschreiben
from dcc_chat_gateway.routes.gates import enforce_ban_gate, enforce_join_gate
from dcc_chat_gateway.suspend_poller import raise_if_suspended
from dcc_chat_gateway.ticket_pruefung import TicketFehler, pruefe_ticket
from dcc_shared.session_tokens import issue_session_token

router = APIRouter(tags=["self-host"])

#: Eine Stunde. Nicht länger, weil das Bann-Gate beim Ausstellen greift und ein
#: gebannter Nutzer sonst so lange weiter durch die REST-Schnittstelle käme; für
#: die lebende Verbindung gibt es den Nachlauf gar nicht, weil ein Bann den
#: Socket sofort schliesst. Nicht kürzer, weil die früheren fünf Minuten den
#: stillen Wiederanmelde-Sturm erzeugten, der diesen Umbau ausgelöst hat.
SITZUNGSDAUER_S = 3600


class SitzungEin(BaseModel):
    ticket: str = Field(..., min_length=1, max_length=8192)


class SitzungAus(BaseModel):
    session_token: str
    expires_in: int


@router.post("/session", response_model=SitzungAus)
async def sitzung_aus_ticket(
    payload: SitzungEin, request: Request, session: SessionDep
) -> SitzungAus:
    settings = get_settings()
    redis = request.app.state.redis

    await raise_if_suspended(redis)

    try:
        daten = await pruefe_ticket(
            payload.ticket,
            instanz_id=settings.pulse_instance_id,
            cloud_issuer=settings.pulse_oidc_issuer,
            redis=redis,
        )
    except TicketFehler as exc:
        # Der Code wandert unveraendert in die Antwort. Er ist der Unterschied
        # zwischen „hier ist der Handgriff" und der Sammelmeldung, die am
        # 2026-08-28 zwei Stunden Fehlersuche an einem gesunden Server kostete.
        raise HTTPException(status_code=403, detail=exc.code) from exc

    kennung = daten.sub
    ist_betreiber = bool(settings.pulse_instance_owner_id) and (
        kennung == str(settings.pulse_instance_owner_id)
    )

    await enforce_ban_gate(session, kennung, ist_betreiber)
    if settings.pulse_instance_mode == "self-host":
        await enforce_join_gate(session, kennung, ist_betreiber)

    if daten.legacy_uid is not None:
        # Einmal je Nutzer. Die Marke haengt am Nutzer, nicht am Ticket: zwei
        # gleichzeitige Anmeldungen desselben Kontos duerfen die Umschreibung
        # nicht zweimal anstossen.
        marke = f"umschreibung:erledigt:{kennung}"
        if await redis.set(marke, "1", nx=True, ex=86400):
            try:
                await umschreiben(
                    session,
                    alt_uid=daten.legacy_uid,
                    neu_uid=int(kennung),
                    alt_text=await _altes_pseudonym(session, daten.legacy_uid),
                    neu_text=kennung,
                )
                await session.commit()
            except ValueError:
                # Kollision: nicht geschrieben, Marke zuruecknehmen, Anmeldung
                # trotzdem zulassen - der Nutzer kann nichts dafuer.
                await session.rollback()
                await redis.delete(marke)

    return SitzungAus(
        session_token=issue_session_token(
            kennung,
            daten.jti,
            key_path=settings.session_signing_key_file,
            admin=ist_betreiber,
            ttl_seconds=SITZUNGSDAUER_S,
        ),
        expires_in=SITZUNGSDAUER_S,
    )


async def _altes_pseudonym(session, legacy_uid: int) -> str:
    """Das Pseudonym, unter dem dieser Nutzer bisher auf diesem Server lief.

    Es steht nicht im Ticket, und das ist Absicht: Der Server kann es selbst
    nachschlagen, weil ``cached_user_profiles`` beide Kennungen nebeneinander
    führt. Was der Empfänger selbst weiss, muss nicht über die Leitung.

    Leerer Rückgabewert heisst: kein Bestand für diesen Nutzer auf diesem Server.
    Die beiden TEXT-Spalten haben dann nichts umzuschreiben — die ``UPDATE``s
    laufen ins Leere, was richtig ist und nicht abgefangen werden muss.
    """
    from sqlalchemy import select

    from dcc_chat_gateway.models import CachedUserProfile

    return (
        await session.execute(
            select(CachedUserProfile.user_identifier).where(
                CachedUserProfile.synthetic_user_id == legacy_uid
            )
        )
    ).scalar_one_or_none() or ""
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/chat-gateway/tests/test_session_ticket_route.py -q`
Erwartet: 5 passed

- [ ] **Schritt 5: Erneuerung am Socket nachweisen**

Die Spec setzt darauf, dass eine Ticket-Sitzung am offenen Socket erneuert wird (`ws_token_renewal.py`, Fähigkeit `token_refresh`) — sonst wäre die Stunde eine harte Wand statt einer Frist. Der Weg existiert, wurde aber nie mit einer Sitzung aus diesem Ausstellungspfad benutzt. Das ist genau die Sorte Annahme, die still bricht:

```python
@pytest.mark.asyncio
async def test_ticket_sitzung_laesst_sich_am_socket_erneuern(client, ws_client, ticket_bauer):
    # Ohne diesen Weg waere die Stunde eine Wand: Der Nutzer floege mitten im
    # Gespraech heraus und muesste sich neu anmelden - und bei einem
    # Cloud-Ausfall ginge selbst das nicht.
    r = await client.post("/session", json={"ticket": ticket_bauer(sub="7")})
    token = r.json()["session_token"]
    async with ws_client(token) as ws:
        await ws.send_json({"op": "token_refresh", "token": token})
        antwort = await ws.receive_json()
    assert antwort["op"] == "token_renewed"
    assert antwort["token"] != token
```

Schlägt das fehl, weil `ws_token_renewal` am `cert_id` hängt: Der Ticket-Weg legt dort die `jti` ab (Schritt 3, `issue_session_token(kennung, daten.jti, ...)`). Dann muss die Erneuerung auf ein Feld umgestellt werden, das **beide** Wege füllen — und nicht der Ticket-Weg auf ein Cert-Feld verbogen werden.

- [ ] **Schritt 6: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py services/chat-gateway/src/dcc_chat_gateway/app.py services/chat-gateway/tests/
git commit -m "feat(chat): POST /session loest ein Cloud-Ticket gegen eine Sitzung ein"
```

---

### Aufgabe 8: Fähigkeit ankündigen

**Dateien:**
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/routes/ws.py:230-238`
- Test: `services/chat-gateway/tests/test_ws_hello.py`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_hello_kuendigt_den_ticket_weg_an(ws_client):
    """Der Klient entscheidet ueber die Faehigkeit, nicht ueber die Version.

    Die Web-App wird von der Cloud ausgeliefert und ist fuer alle sofort neu;
    Self-Hosts aktualisieren sich, wann sie wollen. Eine neue App trifft also
    wochenlang auf alte Server."""
    hello = await ws_client.receive_json()
    assert hello["op"] == "hello"
    assert "server-ticket" in hello["capabilities"]
    assert "token_refresh" in hello["capabilities"]
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Erwartet: FAIL — `'server-ticket' not in ['token_refresh']`

- [ ] **Schritt 3: Umsetzen**

In `routes/ws.py` die Liste erweitern:

```python
        "capabilities": ["token_refresh", "server-ticket"],
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

- [ ] **Schritt 5: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/ws.py services/chat-gateway/tests/test_ws_hello.py
git commit -m "feat(chat): hello kuendigt den Ticket-Weg an"
```

---

### Aufgabe 9: Die Weiche im Frontend

**Dateien:**
- Anlegen: `web/src/lib/servers/anmeldeweg.ts` (**importfrei**)
- Test: `web/test/anmeldeweg.test.ts`

**Schnittstellen:**
- Stellt bereit: `export type Anmeldeweg = 'ticket' | 'zertifikat'`, `export function waehleAnmeldeweg(faehigkeiten: readonly string[] | null): Anmeldeweg`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```typescript
// web/test/anmeldeweg.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waehleAnmeldeweg } from '../src/lib/servers/anmeldeweg.ts';

test('kennt der Server den Ticket-Weg, wird er genommen', () => {
  assert.equal(waehleAnmeldeweg(['token_refresh', 'server-ticket']), 'ticket');
});

test('ein alter Server bekommt weiter den Zertifikats-Weg', () => {
  assert.equal(waehleAnmeldeweg(['token_refresh']), 'zertifikat');
});

test('noch keine Auskunft heisst Zertifikat, nicht Ticket', () => {
  // Vor dem ersten hello wissen wir nichts. Der alte Weg funktioniert ueberall,
  // der neue nur auf neuen Servern - im Zweifel also der, der immer geht.
  assert.equal(waehleAnmeldeweg(null), 'zertifikat');
  assert.equal(waehleAnmeldeweg([]), 'zertifikat');
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd web && pnpm test:unit`
Erwartet: FAIL — Modul nicht gefunden.

- [ ] **Schritt 3: Umsetzen**

```typescript
// web/src/lib/servers/anmeldeweg.ts
/**
 * Welcher Anmeldeweg gilt für einen Server — Ticket oder Zertifikat.
 *
 * **Importfrei mit Absicht.** Die Datei wird von `pnpm test:unit` unter Nodes
 * eigenem Läufer geprüft, und der löst erweiterungslose Importe nicht auf
 * (Muster: `lib/navigation/tabs.ts`). Die Rechnung steht deshalb allein hier.
 *
 * **Fähigkeit statt Version.** Die Web-App kommt von der Cloud und ist für alle
 * sofort neu; ein Self-Host aktualisiert sich, wann er will. Eine neue App
 * trifft wochenlang auf alte Server. Wer hier Versionen vergliche, müsste raten;
 * die Fähigkeitsliste im `hello`-Rahmen sagt es.
 */

export type Anmeldeweg = 'ticket' | 'zertifikat';

/** Die Fähigkeit, an der der Ticket-Weg hängt. Muss mit `routes/ws.py` übereinstimmen. */
export const FAEHIGKEIT_TICKET = 'server-ticket';

export function waehleAnmeldeweg(faehigkeiten: readonly string[] | null): Anmeldeweg {
  if (faehigkeiten?.includes(FAEHIGKEIT_TICKET)) return 'ticket';
  return 'zertifikat';
}
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `cd web && pnpm test:unit`
Erwartet: die drei neuen Tests grün, die 361 bestehenden unverändert.

- [ ] **Schritt 5: Committen**

```bash
git add web/src/lib/servers/anmeldeweg.ts web/test/anmeldeweg.test.ts
git commit -m "feat(web): Anmeldeweg aus den Server-Faehigkeiten waehlen"
```

---

### Aufgabe 10: Ticket holen und einlösen (Frontend)

**Dateien:**
- Anlegen: `web/src/lib/api/server-ticket.ts`
- Ändern: `web/src/lib/api/self-host-reauth.ts` (in `reauth()` die Weiche einbauen)
- Test: `web/test/anmeldefehler.test.ts`

**Schnittstellen:**
- Verbraucht: `waehleAnmeldeweg` (Aufgabe 9); `request` aus `$lib/api/client`; `serversStore`, `sessionTokens`.
- Stellt bereit: `async holeTicket(instanceId: string): Promise<string>`, `async loeseTicketEin(hostname: string, ticket: string): Promise<{session_token: string; expires_in: number}>`, `class TicketFehler extends Error { code: string }`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```typescript
// web/test/anmeldefehler.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABLEHNUNGSCODES, hatTextFuerJedenCode } from '../src/lib/api/anmelde-fehler-codes.ts';

test('jeder Ablehnungscode hat einen eigenen Text', () => {
  // Ein Code ohne Text ist die Sammelmeldung zurueck - genau das, wogegen
  // dieser Umbau gerichtet ist.
  assert.ok(hatTextFuerJedenCode(), 'mindestens ein Code ohne Meldung');
});

test('die Codeliste deckt die Serverantworten ab', () => {
  for (const c of ['ticket_expired', 'ticket_replayed', 'ticket_wrong_audience',
                   'jwks_cold', 'join_not_permitted', 'banned', 'instance_suspended']) {
    assert.ok(ABLEHNUNGSCODES.includes(c), `${c} fehlt in der Liste`);
  }
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd web && pnpm test:unit`
Erwartet: FAIL — Modul nicht gefunden.

- [ ] **Schritt 3: Umsetzen**

Erst das importfreie Codemodul:

```typescript
// web/src/lib/api/anmelde-fehler-codes.ts
/**
 * Die Ablehnungsgründe, die `POST /session` zurückgeben kann — und der Nachweis,
 * dass jeder davon einen eigenen Text hat.
 *
 * **Importfrei** (s. `pnpm test:unit`-Falle). Die Zuordnung auf die
 * Paraglide-Meldungen liegt in `anmelde-fehler.ts`; hier steht nur die Liste und
 * die Prüfung, damit ein fehlender Text ein roter Test ist und nicht eine
 * nichtssagende Meldung im Betrieb.
 */

export const ABLEHNUNGSCODES = [
  'ticket_expired',
  'ticket_replayed',
  'ticket_wrong_audience',
  'ticket_wrong_issuer',
  'ticket_wrong_purpose',
  'ticket_invalid',
  'ticket_malformed',
  'jwks_cold',
  'join_locked',
  'join_not_permitted',
  'banned',
  'instance_suspended',
  'instance_deleted',
] as const;

export type Ablehnungscode = (typeof ABLEHNUNGSCODES)[number];

/** Die Schlüssel, unter denen die Texte im Katalog stehen. */
export const MELDUNGSSCHLUESSEL: Record<Ablehnungscode, string> = {
  ticket_expired: 'anmeldung_ticket_abgelaufen',
  ticket_replayed: 'anmeldung_ticket_verbraucht',
  ticket_wrong_audience: 'anmeldung_ticket_falscher_server',
  ticket_wrong_issuer: 'anmeldung_ticket_falscher_aussteller',
  ticket_wrong_purpose: 'anmeldung_ticket_falscher_zweck',
  ticket_invalid: 'anmeldung_ticket_ungueltig',
  ticket_malformed: 'anmeldung_ticket_ungueltig',
  jwks_cold: 'anmeldung_server_ohne_cloud',
  join_locked: 'anmeldung_server_geschlossen',
  join_not_permitted: 'anmeldung_kein_zugang',
  banned: 'anmeldung_gesperrt',
  instance_suspended: 'anmeldung_instanz_gesperrt',
  instance_deleted: 'anmeldung_instanz_geloescht',
};

export function hatTextFuerJedenCode(): boolean {
  return ABLEHNUNGSCODES.every((c) => !!MELDUNGSSCHLUESSEL[c]);
}
```

Dann der Ticket-Weg selbst:

```typescript
// web/src/lib/api/server-ticket.ts
/**
 * Ticket holen und einlösen — der Anmeldeweg ohne Langzeitgeheimnis im Browser.
 *
 * Das Einlösen läuft NICHT über `request()`: Für den Self-Host gibt es an dieser
 * Stelle noch keinen Bearer, also greift die Bearer-Logik aus `client.ts` nicht.
 * Gleiche Begründung wie beim alten `cert-login.ts`.
 *
 * NIEMALS loggen: ticket, session_token.
 */

import { request } from './client';

export class TicketFehler extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
  ) {
    super(code);
    this.name = 'TicketFehler';
  }
}

type TicketAntwort = { ticket: string; expires_in: number };
export type SitzungAntwort = { session_token: string; expires_in: number };

/** Holt bei der Cloud einen Ausweis für genau diese Instanz. */
export async function holeTicket(instanceId: string): Promise<string> {
  const antwort = await request<TicketAntwort>(
    '/me/server-ticket',
    { method: 'POST', body: { instance_id: instanceId }, endpoint: 'auth' },
  );
  return antwort.ticket;
}

/** Legt das Ticket dem Self-Host vor und bekommt dessen Sitzung. */
export async function loeseTicketEin(
  serverHostname: string,
  ticket: string,
): Promise<SitzungAntwort> {
  let resp: Response;
  try {
    resp = await fetch(`${serverHostname}/api/chat/session`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
  } catch (err) {
    // Netzfehler ist ein eigener Grund, kein „ungültiges Ticket".
    throw new TicketFehler('network', undefined);
  }
  if (!resp.ok) {
    let code = 'unknown';
    try {
      const j = (await resp.json()) as { detail?: unknown };
      if (typeof j.detail === 'string') code = j.detail;
    } catch {
      // Antwort ohne JSON — Code bleibt 'unknown'.
    }
    throw new TicketFehler(code, resp.status);
  }
  return (await resp.json()) as SitzungAntwort;
}
```

Zuletzt in `self-host-reauth.ts::reauth()` die Weiche: Fähigkeiten des Servers aus dem Verbindungszustand lesen, `waehleAnmeldeweg` fragen, bei `'ticket'` den neuen Weg gehen, sonst `certLogin` wie bisher. **Der bestehende Cert-Zweig bleibt unverändert stehen.**

- [ ] **Schritt 4: Tests laufen lassen**

Ausführen: `cd web && pnpm test:unit && pnpm check`
Erwartet: alle grün.

Die dreizehn neuen Meldungen müssen in `web/messages/de.json` und `web/messages/en.json` stehen, jeweils mit einem **Handgriff** im Text — ein Befund ohne Handgriff ist eine Sackgasse (Muster: `dcc_auth/diagnose_texte.py`).

- [ ] **Schritt 5: Committen**

```bash
git add web/src/lib/api/ web/test/anmeldefehler.test.ts web/messages/
git commit -m "feat(web): Ticket-Anmeldung mit Gruenden statt Sammelmeldung"
```

---

### Aufgabe 11: Der Test, der den Vorfall verhindert hätte — VERWORFEN (2026-08-28)

**Ergebnis der Umsetzung: gestrichen, mit Grund.** Der Test wurde geschrieben, lief grün — und blieb grün, als der alte Fehler testweise wieder eingebaut wurde. Die Playwright-Suite fährt gegen eine **Cloud**-Instanz, und dort gibt es keine Zertifikats-Anmeldung; geprüft wurde also „zwei Browser können beide in der Cloud angemeldet sein", was nie kaputt war.

Ein Test, der aus dem falschen Grund grün ist, erzeugt falsche Sicherheit — schlimmer als keiner. Gewacht wird stattdessen von `test_zwei_browser_mit_gleichem_label_bleiben_beide_gueltig` (auth-Backend), das die Gegenprobe besteht. Die Begründung steht in dessen Docstring, damit der nächste, der die Idee hat, sie nicht noch einmal baut.

Wer es doch als E2E will, braucht einen zweiten Backend-Stand im Testaufbau. Das ist ein eigener Task.

<details><summary>Ursprünglicher Aufgabentext</summary>


**Dateien:**
- Anlegen: `web/tests/e2e/zwei-browser-gleichzeitig.spec.ts`

Warum zuletzt: Er prüft die Eigenschaft, um die es beim ganzen Umbau geht — dass zwei Sitzungen desselben Kontos nebeneinander bestehen.

**Redlichkeitsvermerk, der in die Datei gehört:** Playwright hängt in keinem Gate, und auf `main` stehen dort drei rote Dateien. Dieser Test ist so viel wert, wie jemand ihn ausführt.

- [ ] **Schritt 1: Den Test schreiben**

```typescript
// web/tests/e2e/zwei-browser-gleichzeitig.spec.ts
import { test, expect } from '@playwright/test';

/**
 * Zwei Browser-Kontexte, ein Konto, beide bleiben angemeldet.
 *
 * Vor dem 2026-08-28 war das nicht so: Das Geraete-Etikett war
 * `<Browser> · <OS>` ohne Rechnernamen, und eine Neuausstellung zog jeden
 * aktiven Pass mit gleichem Etikett zurueck. Zwei Fenster warfen sich endlos
 * abwechselnd hinaus. Dieser Test haelt fest, dass das nicht wiederkommt.
 */
const KONTO = {
  username: `zwei${Date.now().toString().slice(-8)}`,
  email: `zwei${Date.now().toString().slice(-8)}@dcc-test.example.com`,
  password: 'Testpasswort123!',
};

test('zwei Kontexte desselben Kontos bleiben beide angemeldet', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const seiteA = await a.newPage();
  const seiteB = await b.newPage();

  // Kontext A legt das Konto an und ist damit angemeldet.
  await seiteA.goto('/register');
  await seiteA.getByTestId('reg-username').fill(KONTO.username);
  await seiteA.getByTestId('reg-email').fill(KONTO.email);
  await seiteA.getByTestId('reg-password').fill(KONTO.password);
  await seiteA.getByTestId('reg-submit').click();
  await expect(seiteA).toHaveURL(/\/app/, { timeout: 15000 });

  // Kontext B meldet sich mit DEMSELBEN Konto an. Genau hier warf der zweite
  // Browser den ersten hinaus, solange das Geraete-Etikett als Identitaet galt.
  await seiteB.goto('/login');
  await seiteB.getByTestId('login-identifier').fill(KONTO.username);
  await seiteB.getByTestId('login-password').fill(KONTO.password);
  await seiteB.getByTestId('login-submit').click();
  await expect(seiteB).toHaveURL(/\/app/, { timeout: 15000 });

  // Und jetzt der Punkt: A muss weiterhin angemeldet sein. Ein Neuladen zwingt
  // die App, ihre Anmeldung wirklich zu belegen, statt nur den Zustand im
  // Speicher zu zeigen.
  await seiteA.reload();
  await expect(seiteA).toHaveURL(/\/app/, { timeout: 15000 });
  await expect(seiteA.getByTestId('login-identifier')).toHaveCount(0);

  await a.close();
  await b.close();
});
```

- [ ] **Schritt 2: Lokal ausführen**

Ausführen: `cd web && PULSE_INSTANCE_MODE=cloud pnpm exec playwright test zwei-browser-gleichzeitig`
Erwartet: grün.

- [ ] **Schritt 3: Committen**

```bash
git add web/tests/e2e/zwei-browser-gleichzeitig.spec.ts
git commit -m "test(e2e): zwei Browser desselben Kontos bleiben beide angemeldet"
```

---

</details>

---

### Aufgabe 12: Das neunte Diagnose-Glied

**Dateien:**
- Anlegen: `services/auth/src/dcc_auth/selfhost_probe_anmeldeweg.py`
- Ändern: `services/auth/src/dcc_auth/routes_selfhost_diagnose.py` (Glied einhängen), `services/auth/src/dcc_auth/diagnose_texte.py` (Texte)
- Test: `services/auth/tests/test_selfhost_probe_anmeldeweg.py`

**Warum:** Die Übergangszeit ist sonst unsichtbar. Wer wissen will, ob ein Server schon den neuen Weg kann, müsste sich anmelden — also genau das tun, was womöglich klemmt. Und das Tor zwischen Phase 2 und 3 der Spec braucht eine Zahl, keine Ahnung.

**Wie ohne Anmeldung:** Die Fähigkeit steht im `hello`-Rahmen, den es erst nach einer gültigen Anmeldung gibt. Der Probe nutzt deshalb `POST /session` selbst als Merkmal: Ein **alter** Server kennt die Route nicht und antwortet **404**; ein **neuer** weist ein offensichtlich unbrauchbares Ticket mit **403** und einem `ticket_*`-Code ab. Beides ohne jedes Geheimnis, beides eindeutig.

**Schnittstellen:**
- Verbraucht: `Ziel` aus `dcc_auth.selfhost_probe_dienst`, `Schritt` aus `dcc_auth.selfhost_probe`.
- Stellt bereit: `async pruefe_anmeldeweg(klient, ziel) -> Schritt` mit Befunden `ticket_weg`, `zertifikats_weg`, `keine_auskunft`.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
# services/auth/tests/test_selfhost_probe_anmeldeweg.py
import httpx
import pytest

from dcc_auth.selfhost_probe_anmeldeweg import pruefe_anmeldeweg
from dcc_auth.selfhost_probe_dienst import Ziel


def _klient(status: int, rumpf: dict | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=rumpf if rumpf is not None else {})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_neuer_server_weist_das_unbrauchbare_ticket_ab():
    async with _klient(403, {"detail": "ticket_malformed"}) as k:
        s = await pruefe_anmeldeweg(k, Ziel("x.example.com", "127.0.0.1"))
    assert s.ok is True
    assert s.befund == "ticket_weg"


@pytest.mark.asyncio
async def test_alter_server_kennt_die_route_nicht():
    async with _klient(404) as k:
        s = await pruefe_anmeldeweg(k, Ziel("x.example.com", "127.0.0.1"))
    assert s.ok is True
    assert s.befund == "zertifikats_weg"


@pytest.mark.asyncio
async def test_unerwartete_antwort_ist_kein_fehlalarm():
    # Ein Proxy, der 502 liefert, sagt nichts ueber den Anmeldeweg. Ein
    # Fehlalarm hier waere schlimmer als gar kein Schritt.
    async with _klient(502) as k:
        s = await pruefe_anmeldeweg(k, Ziel("x.example.com", "127.0.0.1"))
    assert s.befund == "keine_auskunft"
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/auth/tests/test_selfhost_probe_anmeldeweg.py -q`
Erwartet: FAIL — Modul nicht gefunden.

- [ ] **Schritt 3: Umsetzen**

```python
# services/auth/src/dcc_auth/selfhost_probe_anmeldeweg.py
"""Neuntes Glied: Spricht dieser Server schon den Ticket-Weg?

Es ist kein Erreichbarkeitsglied — der Server kann tadellos laufen und trotzdem
noch den alten Weg fahren. Es beantwortet die Frage, die während der
Übergangszeit sonst niemand ohne Anmeldung beantworten kann, und liefert die
Zahl, an der das Tor zwischen Phase 2 und Phase 3 hängt.

Warum ``POST /session`` und nicht der ``hello``-Rahmen: Die Fähigkeitsliste steht
im ``hello``, das es erst nach einer gültigen Anmeldung gibt. Diese Prüfung darf
aber gerade keine Anmeldung voraussetzen. Also fragt sie die Route selbst — ein
alter Server kennt sie nicht (404), ein neuer weist ein unbrauchbares Ticket ab
(403 mit ``ticket_*``). Kein Geheimnis reist mit, und geraten wird nichts.
"""

from __future__ import annotations

import asyncio

import httpx

from dcc_auth.selfhost_probe import FRIST_S, Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

PFAD = "/api/chat/session"


async def pruefe_anmeldeweg(klient: httpx.AsyncClient, ziel: Ziel) -> Schritt:
    """Fragt, welchen Anmeldeweg dieser Server kann."""
    try:
        async with asyncio.timeout(FRIST_S):
            antwort = await klient.post(
                ziel.url(PFAD),
                json={"ticket": "keins"},
                headers=ziel.kopf({}),
                extensions=ziel.sni,
            )
    except Exception:  # noqa: BLE001
        return Schritt("anmeldeweg", False, "keine_auskunft")

    if antwort.status_code == 404:
        # Route unbekannt: der Server laeuft noch auf dem Zertifikats-Weg. Das
        # ist waehrend der Uebergangszeit KEIN Fehler, deshalb ok=True.
        return Schritt("anmeldeweg", True, "zertifikats_weg")
    if antwort.status_code == 403:
        try:
            detail = antwort.json().get("detail", "")
        except Exception:  # noqa: BLE001
            detail = ""
        if isinstance(detail, str) and detail.startswith("ticket_"):
            return Schritt("anmeldeweg", True, "ticket_weg")
    return Schritt("anmeldeweg", False, "keine_auskunft")
```

Einhängen in `_fuehre_pruefung` (`routes_selfhost_diagnose.py`), im `if tls.ok:`-Block hinter `pruefe_cors`, und `"anmeldeweg"` in die `SCHRITTE`-Liste aufnehmen, damit „nicht geprüft" richtig gefüllt wird.

- [ ] **Schritt 4: Texte ergänzen**

In `diagnose_texte.py` je Befund `titel`, `was_ist`, `was_tun`, deutsch und englisch. **`was_tun` ist Pflicht** — der wichtigste Leser sitzt im Terminal des Installers, und ein Befund ohne Handgriff ist eine Sackgasse. Für `zertifikats_weg` lautet der Handgriff: nichts tun, das Update kommt von selbst.

- [ ] **Schritt 5: Test laufen lassen, Erfolg bestätigen**

Ausführen: `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest services/auth/tests/test_selfhost_probe_anmeldeweg.py services/auth/tests/ -k "diagnose or anmeldeweg" -q`
Erwartet: alle grün.

- [ ] **Schritt 6: Committen**

```bash
git add services/auth/src/dcc_auth/selfhost_probe_anmeldeweg.py services/auth/src/dcc_auth/routes_selfhost_diagnose.py services/auth/src/dcc_auth/diagnose_texte.py services/auth/tests/test_selfhost_probe_anmeldeweg.py
git commit -m "feat(auth): Diagnose sagt, welchen Anmeldeweg ein Server kann"
```

---

### Aufgabe 13: Gate, Changelog, Landen

- [ ] **Schritt 1: Die Umschreibung an echten Daten proben**

Die Spec macht das zur Auflage, und sie ist der einzige Punkt im ganzen Plan, an dem ein Fehler nicht zurückzunehmen ist. Ein Testaufbau taugt dafür nicht: Er hat weder Verwaisungen noch Altlasten noch die Tabellen, die über die Zeit dazugekommen sind.

1. Auszug einer echten Self-Host-Datenbank ziehen — **mit Einverständnis des Betreibers**, Struktur und Kennungen, ohne Nachrichteninhalte:
   `pg_dump --schema=chat --exclude-table-data='chat.messages' ...`
2. In eine Wegwerf-Datenbank einspielen.
3. Für einen Nutzer die synthetische ID heraussuchen (`SELECT synthetic_user_id, user_identifier FROM chat.cached_user_profiles LIMIT 5`) und `umschreiben()` gegen diese Kopie laufen lassen.
4. Danach prüfen: `SELECT count(*) FROM <tabelle> WHERE <spalte> = <alte_id>` für **jede** Spalte aus `SPALTEN` — überall 0. Und für die bedingten Spalten zusätzlich, dass die Zeilen mit der **anderen** Bedingung unverändert sind.

Erst wenn das an echten Daten sauber durchläuft, darf Aufgabe 6 ausgeliefert werden.

- [ ] **Schritt 2: Vollgate**

Ausführen: `PULSE_GATE_VOLL=1 bash scripts/gate.sh`
Erwartet: grün. Rot heisst: nicht landen.

- [ ] **Schritt 3: Changelog**

Neuer Eintrag oben in `web/static/changelog.json`, `id` = Datum, Stil **vom Nutzer wählen lassen**, keine Emojis, echte Umlaute. Inhalt aus Nutzersicht: Die Anmeldung an einem eigenen Server braucht kein Gerätezertifikat mehr; mehrere Geräte und Browser gleichzeitig sind selbstverständlich; scheitert etwas, steht der Grund da.

- [ ] **Schritt 4: Datenschutzerklärung**

`web/src/lib/legal/` — der Self-Host-Betreiber erfährt künftig die Cloud-Kennung seiner Nutzer. Das ist eine zurückgenommene Zusage und muss dort stehen, **bevor** ausgeliefert wird (Spec, „Folge von Entscheidung 3").

- [ ] **Schritt 5: Landen**

Ausführen: `bash scripts/ship.sh` — **erst nach ausdrücklicher Freigabe**, Merge nach `main` ist der Produktiv-Deploy.
