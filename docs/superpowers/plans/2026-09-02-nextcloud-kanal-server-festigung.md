# Nextcloud-Kanäle: Pulse legt selbst ab — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Nextcloud-Kanal ist ein Ordner `kanaele/<kanalId>/` im Konto-Laufwerk seines Erstellers; der Server legt jeden Nachrichten-Umschlag als Datei ab und reicht sie Mitgliedern durch.

**Architecture:** Server: neue Tabelle `ablage_kanal_ordner` (welche Kanäle so laufen) + `ablage_kanal_nachtrag` (was noch nicht abgelegt ist); Ablage nach dem Postfach-Commit, best-effort, Nachtrag in der Pflege-Schleife; zwei Leserouten. Klient: markiert Nachrichten-Umschläge mit `archiv`, liest den Verlauf über die Leserouten und öffnet jede Datei mit dem vorhandenen `zustellungOeffnen`.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (chat-gateway), httpx (WebDAV), SvelteKit/Svelte 5, Nodes Testläufer für importfreie Module.

**Spec:** `docs/superpowers/specs/2026-09-02-nextcloud-kanal-server-festigung-design.md`

## Global Constraints

- Backend-Tests: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q <datei>`; Web: `cd web && pnpm check`, `node --test test/<datei>`.
- Importfreie Web-Module für alles, was Nodes Läufer prüfen soll (kein `$lib`, keine erweiterungslosen Laufzeit-Imports, kein `$state`).
- Quelldateien ≤ 350 Zeilen, Svelte ≤ 250. Keine neuen Abhängigkeiten.
- Freigabe-Adressen nie loggen, nie in Antworten. Der Server sieht nur Chiffrat.
- Snowflake-IDs über die API immer als String.
- Commit-Messages mit echten Umlauten, Suffix `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Alle Ordner-Dateinamen: `<nutzlastId>.puls`, Ordner `kanaele/<kanalId>/`.

---

### Task 1: Modelle + Migration

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/models/ablage_laufwerk.py` (ans Ende)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/models/__init__.py` (Import + `__all__`, alphabetisch)
- Create: `services/chat-gateway/alembic/versions/20260902_2200_0088_ablage_kanal_ordner.py`

**Produces:** `AblageKanalOrdner(channel_id, ersteller_id, created_at)`, `AblageKanalNachtrag(nutzlast_id, channel_id, created_at)`.

- [ ] **Step 1: Modelle anhängen**

```python
class AblageKanalOrdner(Base):
    """Kanal liegt als Ordner ``kanaele/<channel_id>/`` im Konto-Laufwerk
    seines Erstellers; der Server legt ab (Entwurf 2026-09-02, §2-3).
    Kein ``freigabe_adresse`` hier — die kommt aus ``AblageKontoLaufwerk``
    des Erstellers, es gibt EINEN Link je Konto."""
    __tablename__ = "ablage_kanal_ordner"
    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True
    )
    ersteller_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AblageKanalNachtrag(Base):
    """Eine Nutzlast, die noch nicht im Ordner liegt (Nextcloud war beim
    Einliefern nicht erreichbar). Die Pflege-Schleife holt sie nach; fällt
    die Nutzlast, fällt der Nachtrag mit (CASCADE)."""
    __tablename__ = "ablage_kanal_nachtrag"
    nutzlast_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("dm_nutzlasten.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```
(Tabellenname von `DmNutzlast` in `models/postfach.py` prüfen und übernehmen.)

- [ ] **Step 2: Migration** — `revision = "0088_ablage_kanal_ordner"`, `down_revision = "220119df9614"`, `SCHEMA = "chat"`, beide Tabellen nach dem Muster von `20260901_1300_0084_ablage_guild_laufwerk.py` (FK `f"{SCHEMA}.channels.id"` bzw. `f"{SCHEMA}.dm_nutzlasten.id"`, `ondelete="CASCADE"`, Index auf `channel_id` beim Nachtrag). `downgrade` droppt beide.

- [ ] **Step 3: Prüfen** — `uv run --all-packages pytest -q services/chat-gateway/tests/test_ablage_konto_laufwerk.py` grün (Modelle laden, SQLite legt die Tabellen an). Commit: `feat(ablage): Tabellen ablage_kanal_ordner und ablage_kanal_nachtrag`.

---

### Task 2: WebDAV-Ordner anlegen und Unterordner listen

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/ablage_schreiben.py`
- Test: `services/chat-gateway/tests/test_ablage_schreiben_ordner.py`

**Produces:** `async def ordner_anlegen(*, basis, pfad, timeout_s=30.0, resolver=None, http=None) -> None` (MKCOL je Segment, 201 und 405 = vorhanden, sonst `AblageAbrufFehler("upstream_fehler")`); `liste(...)` bekommt `ordner: str | None = None` (Unterordner, durch `normalisiere_pfad` + `baue_ziel_url`).

- [ ] **Step 1: Failing Tests** (Muster: `test_ablage_archiv_loeschen.py` — `httpx.MockTransport`, `resolver=_oeffentlich`):
  - `ordner_anlegen(basis, "kanaele/42")` schickt zwei `MKCOL` (`…/kanaele`, `…/kanaele/42`); 405 auf das erste bricht nicht ab.
  - 403 auf MKCOL wirft `AblageAbrufFehler`.
  - `liste(basis, ordner="kanaele/42")` fragt `PROPFIND` auf `…/kanaele/42/` und gibt nur Dateinamen zurück.
- [ ] **Step 2:** Laufen lassen, FAIL.
- [ ] **Step 3: Umsetzen** — `ordner_anlegen`: Segmente aus `normalisiere_pfad`, Schleife über Präfixe, je `client.request("MKCOL", verankert, headers={"Host": host}, extensions={"sni_hostname": host})` mit `pruefe_ziel_oeffentlich`/`_url_auf_adresse_verankern` wie in `loesche`. `liste`: `url = baue_ziel_url(basis, normalisiere_pfad(ordner)) + "/"` wenn `ordner`, sonst wie bisher.
- [ ] **Step 4:** Tests grün, dazu die bestehenden `-k "ablage"`. Commit: `feat(ablage): MKCOL-Ordner und Unterordner-Liste am Schreib-Weiterreicher`.

---

### Task 3: Der Ableger

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/ablage_kanal_ordner.py`
- Test: `services/chat-gateway/tests/test_ablage_kanal_ordner.py`

**Consumes:** Task 1 Modelle, Task 2 `ordner_anlegen`, `schreibe` aus `ablage_schreiben`.
**Produces:**
```python
def ordner_pfad(channel_id: int) -> str            # "kanaele/<id>"
def datei_name(nutzlast_id: int) -> str            # "<id>.puls"
def datei_inhalt(n: DmNutzlast) -> bytes           # JSON wie PostfachZustellungOut, IDs als Strings
async def ablegen(session, nutzlast: DmNutzlast) -> bool   # True = liegt im Ordner; False = kein Ordner-Kanal
async def nachtrag_sweep(session) -> int           # holt Nachträge nach, gibt Anzahl der erledigten zurück
```
`ablegen`: `AblageKanalOrdner` für `nutzlast.channel_id` suchen; keiner → `False`. `AblageKontoLaufwerk` des `ersteller_id` suchen; keiner → `AblageAbrufFehler("kein_laufwerk")`. Dann `ordner_anlegen` + `schreibe(basis, f"{ordner_pfad}/{datei_name}", datei_inhalt)`. Wirft `AblageAbrufFehler` bei Nextcloud-Ausfall — der Aufrufer entscheidet über Nachtrag. Modulweite Namen `schreibe_aufs_laufwerk`/`ordner_anlegen_am_laufwerk` als Import-Aliase, damit Tests sie per `monkeypatch.setattr` ersetzen (Muster `test_postfach_anhaenge_laufwerk.py::_LaufwerkMock`).

- [ ] **Step 1: Failing Tests** — `datei_inhalt` liefert JSON mit `id`/`channel_id`/`absender_user_id` als Strings und `daten` unverändert; `ablegen` ohne Ordner-Zeile → `False`, kein Schreibaufruf; mit Zeile + Laufwerk → genau ein `ordner_anlegen("kanaele/<id>")` und ein `schreibe(pfad="kanaele/<id>/<nid>.puls")`; ohne Laufwerk → `AblageAbrufFehler`; `nachtrag_sweep` schreibt jede Nachtrag-Zeile und löscht sie, lässt bei Fehler die Zeile stehen.
- [ ] **Step 2:** FAIL. **Step 3:** Umsetzen. **Step 4:** grün. Commit: `feat(ablage): Ableger — Postfach-Umschlag als Datei im Kanal-Ordner`.

---

### Task 4: Einliefern legt ab, Pflege holt nach

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/schemas.py:1353-1376` (`PostfachNutzlastIn.archiv: bool = False`)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/postfach.py:291-326` (Nutzlast-Objekte merken) und nach Zeile 326
- Modify: `services/chat-gateway/src/dcc_chat_gateway/cleanup.py:76-84` (Sweep anhängen)
- Test: `services/chat-gateway/tests/test_postfach_ablage_ordner.py`

- [ ] **Step 1: Failing Tests** (Aufbau wie `test_postfach_anhaenge_laufwerk.py::_aufbau`, Ableger per `monkeypatch.setattr(postfach_mod, "ablegen_im_ordner", mock)`): Einliefern mit `archiv: true` in einem Kanal mit Ordner-Zeile → Mock einmal gerufen mit der Nutzlast; ohne `archiv` → nicht gerufen; Mock wirft `AblageAbrufFehler` → Antwort bleibt 200 und eine `AblageKanalNachtrag`-Zeile existiert; `_run_once`-Sweep (direkt `nachtrag_sweep`) räumt sie.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Umsetzen** — in der Schleife `angelegte.append((nutzlast_obj, eintrag.archiv))`; nach `await session.commit()`:
```python
for nutzlast, archiv in angelegte:
    if not archiv:
        continue
    try:
        await ablegen_im_ordner(session, nutzlast)
    except AblageAbrufFehler:
        session.add(AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=nutzlast.channel_id))
if angelegte:
    await session.commit()
```
Kein Log mit Adresse. `cleanup._run_once`: eigener `async with session_factory() as session: n = await nachtrag_sweep(session)` + `log.info("ablage_kanal_nachtrag_done anzahl=%d", n)`.
- [ ] **Step 4:** grün + `-k "postfach"`. Commit: `feat(postfach): archiv-Umschläge landen im Kanal-Ordner, Nachtrag in der Pflege`.

---

### Task 5: Leserouten + Anlegen

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/routes/ablage_kanal_ordner.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/__init__.py:91` (Router aufnehmen)
- Test: `services/chat-gateway/tests/test_ablage_kanal_ordner_routen.py`

**Produces:**
- `PUT /channels/{id}/ablage/ordner` → 204; legt `AblageKanalOrdner(ersteller=current)` an. 404 kein Ablage-Kanal, 403 kein Mitglied, 409 wenn Zeile eines ANDEREN Erstellers existiert, 412 wenn der Aufrufer kein Konto-Laufwerk hat (`detail="no account drive"`).
- `GET /channels/{id}/ablage/ordner?nach=<id>&limit=200` → `list[str]` Dateinamen, nur `^\d+\.puls$`, numerisch aufsteigend, strikt hinter `nach`. 404 wenn kein Ordner-Kanal (Klient fällt dann auf den alten Weg zurück).
- `GET /channels/{id}/ablage/ordner/{name}` → Datei roh (`ablage_abruf_antwort(basis, f"kanaele/{id}/{name}")`), `name` gegen `^\d+\.puls$` (422 sonst).
Alle mit `_kanal_fuer_mitglied` aus `ablage_kanal.py` (importieren, nicht kopieren) und Ratenbegrenzer-Eimer `ablage_abruf`.

- [ ] **Step 1: Failing Tests** — Rechte-Reihenfolge (404 → 403), 412 ohne Laufwerk, 409 fremder Ersteller, Liste sortiert/filtert/schneidet (Mock `liste_vom_laufwerk` liefert `["3.puls","10.puls","x.txt","2.puls"]`, `nach=2` → `["3.puls","10.puls"]`), Datei-Route lehnt `../key.puls` mit 422 ab.
- [ ] **Step 2:** FAIL. **Step 3:** Umsetzen. **Step 4:** grün. Commit: `feat(ablage): Ordner-Kanal anlegen und lesen — drei Routen`.

---

### Task 6: Klient markiert Nachrichten-Umschläge

**Files:**
- Modify: `web/src/lib/api/postfach.ts` (`PostfachNutzlast.archiv?: boolean`)
- Modify: `web/src/lib/krypto/gruppe/kanalSenden.ts:203-205`

- [ ] **Step 1:** In `kanalSenden.ts` das Objektliteral der Nachrichten-Umschläge um `archiv: true` ergänzen — NUR dort, nicht in `verteilUmschlaege` (Schlüssel-Umschläge). Kommentar: „Der Server legt ab, wenn der Kanal ein Ordner-Kanal ist; sonst ignoriert er das Feld."
- [ ] **Step 2:** `pnpm check` grün. Commit: `feat(krypto): Nachrichten-Umschläge eines Kanals tragen archiv`.

---

### Task 7: Klient-API + Dateinamen-Rechnung

**Files:**
- Create: `web/src/lib/api/ablageKanalOrdner.ts`
- Create: `web/src/lib/ablage/ordnerDateien.ts` (importfrei)
- Test: `web/test/ablage-ordnerDateien.test.ts`

**Produces:**
```ts
// api/ablageKanalOrdner.ts
export function ordnerAnlegen(kanalId: string, route?: RequestRoute): Promise<void>          // PUT
export function ordnerListe(kanalId: string, nach: string | null, limit: number, route?): Promise<string[]>
export function ordnerDatei(kanalId: string, name: string, route?): Promise<PostfachZustellung | null> // 404 → null
// ablage/ordnerDateien.ts
export function nutzlastIdAusName(name: string): string | null   // "17.puls" → "17", sonst null
export function sortiereNamen(namen: readonly string[]): string[] // numerisch aufsteigend, Fremdes weg
```
`ordnerDatei` parst JSON und prüft die Felder von `PostfachZustellung` (Strings/Zahlen), sonst `null`.

- [ ] **Step 1:** Test für `ordnerDateien.ts` (BigInt-Vergleich, Fremdnamen fallen weg). **Step 2:** FAIL → Umsetzen → grün. **Step 3:** API-Datei nach Muster `api/ablageArchiv.ts` (`request`/`fetchAuthenticated`). `pnpm check`. Commit: `feat(ablage): Klient-API für den Kanal-Ordner`.

---

### Task 8: Verlauf aus dem Ordner lesen

**Files:**
- Create: `web/src/lib/ablage/kanalOrdnerLeseweg.ts`
- Modify: `web/src/lib/components/chat/ablageKanalVerlauf.ts:58-65`

**Consumes:** Task 7 API, `zustellungOeffnen(ident, z)` aus `krypto/zustellungOeffnen.ts`, `kryptoAccountLaden` (`krypto/account.svelte.ts`), `verlaufNachrichtGeloescht`/`verlaufSpeichernPflicht` (`$lib/verlauf`), `lokaleIdsFuerLoeschung` (`krypto/loeschZiel.ts`).
**Produces:** `kanalOrdnerVerlaufLesen(kanalId): Promise<Message[] | null>` — `null` wenn die Liste 404 liefert (kein Ordner-Kanal).

- [ ] **Step 1: Umsetzen** — alle Namen seitenweise holen (`limit` 200, `nach` = letzter Name), Dateien in Blöcken zu 8 parallel laden, je Datei `zustellungOeffnen`: `neu` → sammeln und `verlaufSpeichernPflicht(kanalId, [nachricht])`; `loeschung` → wie in `empfangen.ts` (Ziele über `lokaleIdsFuerLoeschung`, dann `verlaufNachrichtGeloescht` + `messages.remove`); `schonAbgelegt` → überspringen (liegt lokal); unlesbar (Sitzung fehlt) → überspringen, zählen. Nichts quittieren — es gibt keine Zustellung.
- [ ] **Step 2:** In `ladeAblageKanalVerlauf`: erst `kanalOrdnerVerlaufLesen`; ist das Ergebnis `null`, wie bisher `kanalVerlaufLesen`. Danach unverändert `verlaufMergen` + `messages.setInitial`.
- [ ] **Step 3:** `pnpm check`. Commit: `feat(ablage): Verlauf eines Ordner-Kanals aus den Dateien lesen`.

---

### Task 9: Ordner-Kanal anlegen

**Files:**
- Modify: `web/src/lib/components/ablage/KanalDateiablageVerbinden.svelte:55-76`

- [ ] **Step 1:** In `nachVerbindung(v)`: ist `v.anbieter === 'nextcloud'` und `v.istArchiv === true` (das Konto-Laufwerk), dann `await ordnerAnlegen(kanalId)` statt `ablageKanalLaufwerkSetzen`; 412 → Meldung „Verbinde zuerst deine Nextcloud im Speicher-Bereich als Archiv."; kein `kanalLaufwerkSchluesselSichern`, keine Festigungsschleife. Sonst der bisherige Weg (Google/Dropbox/anderer Nextcloud-Link).
- [ ] **Step 2:** `pnpm check`; Komponente ≤ 250 Zeilen. Commit: `feat(ablage): Nextcloud-Kanal im Konto-Laufwerk anlegen`.

---

### Task 10: Schlüssel-Übergabe beim Öffnen

**Files:**
- Modify: `web/src/lib/krypto/gruppe/kanalSenden.ts` (Funktion `verteileSchluesselAnNeue(kanalId)` herauslösen, ≤ 350 Zeilen beachten — sonst neue Datei `krypto/gruppe/kanalSchluesselNachliefern.ts`)
- Modify: `web/src/lib/components/chat/ablageKanalVerlauf.ts` (nach dem Laden einmal rufen)

Hintergrund: heute reisen Gruppensitzung + Zugabe erst mit dem NÄCHSTEN Senden an neue Geräte (`kanalSenden.ts:168-182`). Der Entwurf (§5) will die Übergabe, sobald ein Mitglied online ist.

- [ ] **Step 1:** Den Block Zeilen 160-182 (Zielgeräte, `nachzuliefern`, `verteilUmschlaege`, Einliefern der Schlüssel-Umschläge) in eine Funktion ziehen, die `sendeInKanal` weiter benutzt, und die auch ohne Nachricht laufen kann (nur Schlüssel-Umschläge, `archiv` NICHT gesetzt).
- [ ] **Step 2:** `ladeAblageKanalVerlauf` ruft sie nach dem Laden `void`-artig (Fehler schlucken, Sicherung darf den Verlaufsweg nie stören).
- [ ] **Step 3:** `pnpm check`, `pnpm test:unit`. Commit: `feat(krypto): Kanalschlüssel gehen beim Öffnen an neue Geräte, nicht erst beim Senden`.

---

### Task 11: Hinweis beim Trennen + Gate

**Files:**
- Modify: `web/src/lib/components/settings/SpeicherSektion.svelte` (Trennen-Bestätigung)
- Modify: `web/messages/de.json`, `web/messages/en.json` (ein Schlüssel `speicher_archiv_trennen_kanaele`, ans Ende anhängen)

- [ ] **Step 1:** Im `trennen`-Weg bei `warArchiv` einen Satz zeigen: „Nextcloud-Kanäle, die in diesem Laufwerk liegen, werden für alle unlesbar." (de/en).
- [ ] **Step 2:** `bash scripts/gate.sh` grün. Commit: `feat(speicher): Hinweis auf Kanäle beim Trennen des Archivs`.

---

### Task 12: Nachweis (manuell, nicht im Gate)

Gegen den lokalen Dev-Stack mit der echten Nextcloud des Eigentümers, zwei Browser + App:
1. Ersteller (Nextcloud als Archiv verbunden) legt einen Ablage-Kanal an, wählt das Konto-Laufwerk → in Nextcloud entsteht `kanaele/<id>/`.
2. Ersteller schreibt zwei Nachrichten → zwei Dateien. Ersteller schließt die App.
3. Mitglied schreibt → dritte Datei erscheint, ohne dass der Ersteller online ist.
4. Drittes Konto wird eingeladen, öffnet den Kanal, nachdem ein Mitglied ihn einmal geöffnet hat → sieht alle drei Nachrichten.
5. Mitglied löscht seine Nachricht → vierte Datei (Lösch-Frame); bei allen verschwindet die Nachricht nach Neuladen.
Ergebnis in `docs/ablage-uebergabe-2026-09-01.md` §1 nachtragen (Datum, Zahlen).
