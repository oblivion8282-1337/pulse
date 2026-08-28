# Etappe B2 — Der Klient veröffentlicht seine Schlüssel — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jedes Gerät legt beim Anmelden einen vodozemac-Account an, veröffentlicht
seinen Verschlüsselungsschlüssel und einen Vorrat an Einmalschlüsseln, und füllt
nach, wenn der Vorrat zur Neige geht.

**Architecture:** Der Krypto-Kern (Etappe A) liefert die Schlüssel, die
Server-Routen (Etappe B) nehmen sie entgegen. Diese Etappe ist das Bindeglied —
und die Stelle, an der der **Sitzungszustand dauerhaft** wird.

**Tech Stack:** SvelteKit 5 Runes · WASM (`krypto/pulse-krypto`) · IndexedDB · WebCrypto

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §2

**Vorbedingungen:** Etappe A ist fertig (WASM-Paket baut, 11 Cargo- + 3
Grenz-Tests grün). Etappe B ist fertig (`PUT /keys/bundle`,
`POST /keys/onetime`, `GET /keys/onetime/count`, `POST /keys/claim`).

## Der offene Punkt, der zuerst entschieden werden muss

`web/vite.config.ts` kennt **keine WASM-Behandlung** (nachgesehen 2026-08-28:
nur SvelteKit, Tailwind, Paraglide). Die Ausgabe von `wasm-pack --target web`
lädt ihr `.wasm` selbst über `import.meta.url`; ob Vite das im Bau richtig als
Asset mitnimmt, ist **ungeprüft**.

**Task 0 klärt das, bevor irgendetwas anderes gebaut wird.** Braucht es ein
zusätzliches Vite-Plugin, ist das eine **neue Abhängigkeit und damit eine
Rückfrage beim Eigentümer** — kein Nebenbei. Wer diesen Plan ausführt und
dort landet, hält an und fragt.

## Global Constraints

- **Quelldateien ≤ 350 Zeilen, Svelte-Komponenten ≤ 250.**
- **Node-Unit-Tests:** geprüfte Dateien **importfrei**.
- **Keine neuen Abhängigkeiten ohne Rückfrage** — siehe Task 0.
- **Niemals Schlüsselmaterial loggen**, auch keine Einmalschlüssel, auch nicht gekürzt.
- **Changelog: nein** — für den Nutzer passiert sichtbar nichts.
- Deutsche Kommentare und Commit-Nachrichten, echte Umlaute.

---

### Task 0: Trägt Vite das WASM-Paket?

- [ ] **Schritt 1:** `bash krypto/pulse-krypto/bauen-wasm.sh`, dann in einer
      Wegwerf-Route (`web/src/routes/app/dev/`) das Paket importieren,
      `pnpm build` fahren und die gebaute App **wirklich laden**.
- [ ] **Schritt 2:** Ergebnis festhalten. Läuft es: weiter mit Task 1, und die
      Antwort als Kommentar in `vite.config.ts`. Läuft es nicht: **anhalten
      und fragen**, mit dem konkreten Fehler und dem Namen des Plugins, das
      ihn beheben würde.

Dieser Task hat bewusst keinen Test — er beantwortet eine Frage, er baut nichts.

---

### Task 1: Der Sitzungsschlüssel, ohne den nichts dauerhaft wird

**Files:**
- Create: `web/src/lib/krypto/pickelschluessel.ts`
- Test: `web/test/krypto-pickelschluessel.test.ts`

**Interfaces:**
- Produces: `pickelschluesselAbleiten(signatur: ArrayBuffer) -> Promise<Uint8Array>` (32 Byte) — **importfrei**

Der vodozemac-Account muss eingefroren gespeichert werden, und `pickle()`
verlangt einen 32-Byte-Schlüssel. Woher kommt der?

**Nicht** aus einer Konstante im Quelltext (dann schützt er nichts) und **nicht**
aus einem Zufallswert daneben (dann liegt der Schlüssel neben dem Schloss).

**Er wird aus dem vorhandenen Geräteschlüssel abgeleitet.** Das Ed25519-Paar
des Geräts ist `extractable: false` — es kann das Gerät nicht verlassen, auch
nicht per XSS. Ed25519 signiert **deterministisch** (RFC 8032): dieselbe
Nachricht ergibt immer dieselbe Signatur. Also:

```
pickelschluessel = SHA-256( sign(geraeteschluessel, "pulse-krypto-pickle-v1") )
```

Damit ist der eingefrorene Zustand an einen Schlüssel gebunden, der das Gerät
nicht verlassen kann — ohne dass irgendwo ein Geheimnis im Klartext liegt.

**Die Folge, die man kennen muss und die in den Code gehört:** wird der
Geräteschlüssel gelöscht (Abmelden ruft `keypairStore.wipe()`), ist der
eingefrorene Krypto-Zustand **unlesbar**. Das ist richtig so — eine neue
Geräteidentität soll keine alten Sitzungen erben —, aber es heisst auch: nach
dem Abmelden ist der lokale Verlauf ohne den Server nicht mehr zu öffnen. Wer
das ändern will, ändert eine Sicherheitsaussage, keine Bequemlichkeit.

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickelschluesselAbleiten } from '../src/lib/krypto/pickelschluessel.ts';

test('derselbe Eingang ergibt denselben Schluessel', async () => {
  // Der ganze Ansatz haengt daran. Waere die Ableitung nicht stabil, liesse
  // sich der eingefrorene Zustand nach einem Neustart nicht mehr oeffnen —
  // und zwar still, weil ein falscher Schluessel wie ein beschaedigter
  // Zustand aussieht.
  const eingang = new Uint8Array(64).fill(3).buffer;
  const a = await pickelschluesselAbleiten(eingang);
  const b = await pickelschluesselAbleiten(eingang);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
});

test('verschiedene Eingaenge ergeben verschiedene Schluessel', async () => {
  const a = await pickelschluesselAbleiten(new Uint8Array(64).fill(3).buffer);
  const b = await pickelschluesselAbleiten(new Uint8Array(64).fill(4).buffer);
  assert.notDeepEqual(a, b);
});
```

- [ ] **Schritt 2 bis 4:** Fehlschlag bestätigen, umsetzen (`crypto.subtle.digest('SHA-256', …)`), Tests, committen.

**Warum die Funktion die Signatur entgegennimmt statt sie selbst zu erzeugen:**
so bleibt sie importfrei und im Node-Läufer prüfbar. Das Signieren selbst
braucht den Geräteschlüssel und gehört nach Task 2.

---

### Task 2: Account anlegen, einfrieren, wieder auftauen

**Files:**
- Create: `web/src/lib/krypto/account.svelte.ts`
- Modify: `web/src/lib/identity/idb-shared.ts` (ein weiterer Schlüssel im bestehenden Store)

**Interfaces:**
- Produces: `kryptoAccountLaden() -> Promise<Identitaet>` — legt an oder taut auf
- Produces: `kryptoAccountSichern(ident: Identitaet) -> Promise<void>`

- [ ] **Schritt 1: Umsetzen**

Der eingefrorene Account liegt in der **bestehenden** Identitäts-Datenbank
(`pulse-identity`, Store `identity`) unter einem neuen Schlüssel
`pulse.krypto-account` — dort liegt schon das Geräteschlüsselpaar, und beides
gehört zusammen: fällt das eine weg, ist das andere wertlos. **Nicht** in
`pulse-verlauf`: der Verlauf ist Nutzinhalt und darf getrennt gelöscht werden
können.

**Kein `DB_VERSION`-Sprung nötig** — der Store `identity` hat keinen `keyPath`
und nimmt beliebige Schlüssel. Das ist wichtig: die Version dieser Datenbank
wurde nie erhöht, es gibt kein erprobtes Migrationsverfahren, und ein
Fehlgriff kostet den Geräteschlüssel und damit die Anmeldung.

- [ ] **Schritt 2: Sichern nach JEDER zustandsändernden Handlung**

`generate_one_time_keys`, `mark_keys_as_published` und jeder Sitzungsaufbau
ändern den Account. Wird danach nicht gesichert, sind veröffentlichte
Einmalschlüssel nach einem Neustart wieder „offen" — und ein Absender bekäme
einen Schlüssel, den das Gerät nicht mehr kennt. Die Nachricht wäre
unlesbar, ohne dass irgendwo ein Fehler erschiene.

- [ ] **Schritt 3: Von Hand prüfen** — App laden, neu laden, und sehen, dass
      `curve25519()` **derselbe** Wert bleibt. Ändert er sich, wird nicht
      aufgetaut, sondern jedes Mal neu angelegt.

---

### Task 3: Veröffentlichen und nachfüllen

**Files:**
- Create: `web/src/lib/krypto/veroeffentlichen.ts`, `web/src/lib/api/keys.ts`
- Modify: `web/src/lib/stores/auth.svelte.ts` (Anstoss beim Anmelden), `web/src/lib/identity/cert-rotation.svelte.ts`

- [ ] **Schritt 1: Die unterschriebene Nutzlast nachbauen**

Der Server prüft eine Ed25519-Unterschrift über eine **zeichengenau**
festgelegte Nutzlast. Die Bauvorschrift steht in
`services/chat-gateway/src/dcc_chat_gateway/schluessel_nachweis.py::baue_nutzlast`
— **dort nachlesen, nicht hier abschreiben**, und im Klienten mit einem Test
gegen ein aus dem Backend kopiertes Beispiel absichern. Eine Abweichung um ein
einziges Byte ergibt 403, und die Fehlermeldung sagt (bewusst) nicht, woran es lag.

- [ ] **Schritt 2: Beim Anmelden veröffentlichen**

`runIssueFlow` läuft bereits bei jedem Login und jeder Registrierung
(`routes/login/+page.svelte`, `routes/register/+page.svelte`). Dort anhängen.

- [ ] **Schritt 3: Nachfüllen**

`GET /keys/onetime/count` abfragen; unter einer Schwelle nachlegen. Der Vorrat
ist erschöpfbar — jede an dieses Gerät gerichtete Nachricht verbraucht einen.

- [ ] **Schritt 4: Bei der Zertifikatserneuerung MITveröffentlichen**

**Das ist die Aufgabe, die eine Sicherheitslücke schliesst, und sie ist eine
Zeile.** Das gespeicherte Bündel trägt die `cert_id` des Zertifikats, mit dem
zuletzt veröffentlicht wurde. `cert-rotation.svelte.ts` stellt alle 30 Tage
ein neues Zertifikat für denselben Pubkey aus, ohne das Bündel anzufassen —
danach zeigt die gespeicherte `cert_id` auf ein überholtes Zertifikat, und der
Sperrlisten-Filter beim Abholen greift nicht mehr. Ein gesperrtes Gerät bekäme
weiter Schlüssel.

Warum es nicht am Server zu beheben ist: der Grabstein in
`auth.revoked_credentials` trägt ausdrücklich **nur** die `cert_id`, kein
`device_pubkey` und kein `user_id` (hartes Löschversprechen,
`models_credentials.py:87-97`). Ein Self-Host kann einen Widerruf deshalb
prinzipiell nicht auf ein Gerät zurückrechnen. Die Analyse steht in
`docs/superpowers/plans/2026-08-28-etappe-b-schluesselverzeichnis.md`.

- [ ] **Schritt 5:** Playwright-Nachweis: anmelden, und der Server hat danach
      ein Bündel und Einmalschlüssel für dieses Gerät.

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §2 „Beim ersten Start legt ein Gerät zusätzlich einen
vodozemac-Account an … und veröffentlicht sie" → Task 2 und 3. „Der Vorrat
ist erschöpfbar" → Task 3 Schritt 3. Die Widerruf-Lücke aus Etappe B → Task 3
Schritt 4.

**Der Punkt mit dem grössten Risiko** ist Task 0, und er steht deshalb vorn:
scheitert die WASM-Einbindung in Vite, ist der ganze Rest blockiert, und die
Lösung ist eine neue Abhängigkeit — also nichts, was ein Ausführender allein
entscheidet.

**Der Punkt, an dem still etwas kaputtgeht,** ist Task 2 Schritt 2: wer nach
einer Zustandsänderung nicht sichert, erzeugt Nachrichten, die niemand mehr
öffnen kann — ohne Fehlermeldung, und erst nach einem Neustart. Deshalb der
Handgriff in Schritt 3.
