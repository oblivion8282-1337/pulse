# Etappe C1 — Der Klient bekommt ein Gedächtnis (Schreibseite) — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jede Direktnachricht, die der Klient sieht, landet zusätzlich in
einem lokalen Speicher. **Gelesen wird noch nichts daraus** — das Verhalten der
App ändert sich in dieser Etappe nicht.

**Architecture:** Rein additiv. Der Speicher hängt sich an die Stellen, an
denen Nachrichten heute schon in den flüchtigen `MessageStore` fliessen. Geht
er kaputt, merkt es niemand — was in dieser Etappe Absicht ist und in C2 nicht
mehr gilt.

**Tech Stack:** SvelteKit 5 Runes · IndexedDB · Nodes eingebauter Testläufer

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` (§7 „Der Klient
bekommt ein Gedächtnis")

---

## Warum Etappe C aufgeteilt ist

Das Übergabedokument schätzt für „lokaler Verlauf" drei bis fünf Wochen. Ein
einzelner Plan dafür wäre nicht ausführbar. Der Schnitt:

| | Was | Verhaltensänderung |
|---|---|---|
| **C1** | Lokaler Speicher, **nur Schreiben**. Alles, was ankommt, wird zusätzlich abgelegt. | keine |
| C2 | Verlauf wird **lokal gelesen**, der Server nur noch bei einer Lücke gefragt | spürbar (schneller, offline sichtbar) |
| C3 | Vorschautexte der DM-Liste entstehen lokal (die zwei Server-Aufrufstellen fallen) | spürbar |
| C4 | Sortierung und Ungelesen-Stand aus dem lokalen Bestand | spürbar |

**C1 zuerst und allein, weil es der einzige Schnitt ohne Risiko ist.** Ist der
Speicher gefüllt und stimmt sein Inhalt, sind C2 bis C4 Umschaltungen. Wer
gleich lokal liest, debuggt Speicher und Anzeige gleichzeitig.

## Global Constraints

- **Quelldateien ≤ 350 Zeilen, Svelte-Komponenten ≤ 250.**
- **Node-Unit-Tests:** eine geprüfte Datei darf **keinen erweiterungslosen Laufzeit-Import** haben (`from './nachbar'`). Reine Rechnung gehört in ein **importfreies** Modul (Muster: `lib/remote/zeigerbildPruefung.ts`).
- **Keine neuen Abhängigkeiten.** IndexedDB ist im Browser vorhanden; die App spricht es bereits roh an (`lib/identity/idb-shared.ts`).
- **Kein `git push`.**
- **Changelog:** C1 ist für Nutzer unsichtbar → **kein** Eintrag. C2 bis C4 brauchen einen.
- Deutsche Kommentare, echte Umlaute in Commit-Nachrichten.

## Fundstellen im Bestand

Am 2026-08-28 nachgesehen:

| Was | Wo |
|---|---|
| Flüchtiger Nachrichtenspeicher, `byChannel: Record<string, Message[]>` | `lib/stores/messages.svelte.ts:8`, LRU 15 Kanäle (`:30`), 5000/Kanal (`:28`) |
| Eingang aus dem WS | `lib/ws/handlers/chat.ts` — `message` → `upsert`, `dm_bump` → `upsertFromBump` |
| Verlauf nachladen | `lib/components/MessageList.svelte:125` (`loadOlder`) → `chatApi.listMessages` (`lib/api/chat.ts:354`) |
| Lücken nach Wiederverbindung | `lib/ws/gapFill.ts:34,64` (`mergeGap`/`reconcile`) |
| IndexedDB-Hilfe (vorhanden) | `lib/identity/idb-shared.ts` — DB `pulse-identity`, Version 1, ein Store `identity` |
| DM-Liste | `lib/stores/directMessages.svelte.ts` |

**Zwei Dinge, die man vorher wissen muss:**

1. **Die vorhandene IndexedDB-Hilfe ist nicht wiederverwendbar.** `pulse-identity`
   hat **einen** Store ohne `keyPath`, und ihre Version wurde nie erhöht — es
   gibt kein erprobtes Migrationsverfahren. Nachrichten brauchen einen eigenen
   Index (Kanal + ID) und werden viel grösser. **Eigene Datenbank** anlegen
   statt die Identitäts-DB zu erweitern; ein Fehler beim Erhöhen ihrer Version
   kostete sonst den Geräteschlüssel und damit die Anmeldung.
2. **`upsertFromBump` fasst `last_message_preview` nicht an**
   (`directMessages.svelte.ts:60-89`). Der Vorschautext der DM-Liste ist nach
   einer live eingegangenen Nachricht veraltet, bis neu geladen wird. Das ist
   ein Fehler im Bestand; **C3 behebt ihn nebenbei**, C1 nicht.

## Dateizuschnitt

| Datei | Verantwortung |
|---|---|
| `web/src/lib/verlauf/schema.ts` | **importfrei**: Datenbankname, Version, Store- und Indexnamen, Satzform |
| `web/src/lib/verlauf/satz.ts` | **importfrei**: Nachricht ↔ gespeicherter Satz, Sortierschlüssel |
| `web/src/lib/verlauf/db.ts` | IndexedDB öffnen, schreiben, lesen — die einzige Stelle mit `indexedDB` |
| `web/src/lib/verlauf/index.ts` | `verlaufSpeichern(...)`, kapselt Fehler weg |
| `web/test/verlauf-satz.test.ts` | Tests der importfreien Rechnung |

Die Trennung ist keine Zierde: `db.ts` ist im Node-Testläufer nicht prüfbar
(kein `indexedDB`), `schema.ts` und `satz.ts` sind es. Was rechnet, gehört
deshalb dorthin, und `db.ts` bleibt so dumm wie möglich.

---

### Task 1: Die Satzform, importfrei und geprüft

**Files:**
- Create: `web/src/lib/verlauf/schema.ts`, `web/src/lib/verlauf/satz.ts`
- Test: `web/test/verlauf-satz.test.ts`

**Interfaces:**
- Produces: `DB_NAME`, `DB_VERSION`, `STORE_NACHRICHTEN`, `INDEX_KANAL`
- Produces: `type Satz = { schluessel: string; kanalId: string; nachrichtId: string; autorId: string; inhalt: string; erstelltAm: string; bearbeitetAm: string | null; geloescht: boolean; anhaenge: unknown[] }`
- Produces: `zuSatz(kanalId: string, nachricht: unknown): Satz | null`
- Produces: `sortierSchluessel(kanalId: string, nachrichtId: string): string`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

`web/test/verlauf-satz.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zuSatz, sortierSchluessel } from '../src/lib/verlauf/satz.ts';

test('Sortierschluessel ordnet nach Nachrichten-ID, nicht als Zahl', () => {
  // Snowflakes sind Zeichenketten, weil sie als Zahl nicht exakt sind. Ein
  // Schluessel, der sie ungepolstert aneinanderhaengt, sortiert "9" hinter
  // "10" — und der Verlauf stuende in falscher Reihenfolge da.
  const a = sortierSchluessel('k1', '9');
  const b = sortierSchluessel('k1', '10');
  assert.ok(a < b, `${a} muesste vor ${b} stehen`);
});

test('Sortierschluessel trennt Kanaele', () => {
  assert.notEqual(sortierSchluessel('k1', '5'), sortierSchluessel('k2', '5'));
});

test('zuSatz weist Fremdmaterial ab statt es abzulegen', () => {
  // fail-closed: was nicht wie eine Nachricht aussieht, wird nicht
  // gespeichert. Sonst faellt der Fehler erst beim Lesen auf, Wochen spaeter.
  assert.equal(zuSatz('k1', null), null);
  assert.equal(zuSatz('k1', {}), null);
  assert.equal(zuSatz('k1', { id: 5, content: 'x' }), null); // id muss Zeichenkette sein
});

test('zuSatz uebernimmt genau die gebrauchten Felder', () => {
  const satz = zuSatz('k1', {
    id: '42', author_id: '7', content: 'hallo',
    created_at: '2026-08-28T00:00:00Z', edited_at: null,
    attachments: [], unerwartet: 'wird nicht uebernommen',
  });
  assert.ok(satz);
  assert.equal(satz.nachrichtId, '42');
  assert.equal(satz.inhalt, 'hallo');
  assert.equal(satz.geloescht, false);
  assert.ok(!('unerwartet' in satz));
});

test('eine geloeschte Nachricht bleibt als Grabstein', () => {
  // Sonst taucht sie beim naechsten Abgleich wieder auf.
  const satz = zuSatz('k1', {
    id: '43', author_id: '7', content: '',
    created_at: '2026-08-28T00:00:00Z', deleted_at: '2026-08-28T01:00:00Z',
    attachments: [],
  });
  assert.ok(satz);
  assert.equal(satz.geloescht, true);
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd web && pnpm test:unit
```
Erwartet: der neue Block schlägt fehl (Modul fehlt). Basiswert vorher: **364 grün**.

- [ ] **Schritt 3: `schema.ts` schreiben**

```ts
/**
 * Form des lokalen Verlaufs — importfrei, damit Nodes Testlaeufer sie sieht.
 *
 * EIGENE Datenbank, nicht die der Identitaet (`pulse-identity`): deren
 * Version wurde nie erhoeht, es gibt also kein erprobtes Migrationsverfahren,
 * und ein Fehlgriff dort kostet den Geraeteschluessel und damit die Anmeldung.
 */
export const DB_NAME = 'pulse-verlauf';
export const DB_VERSION = 1;
export const STORE_NACHRICHTEN = 'nachrichten';
/** Nach Kanal, damit ein Kanal am Stueck gelesen werden kann. */
export const INDEX_KANAL = 'nach_kanal';
```

- [ ] **Schritt 4: `satz.ts` schreiben**

Der Sortierschlüssel muss **numerisch korrekt als Zeichenkette** ordnen —
Snowflakes sind Zeichenketten, weil sie als `Number` nicht exakt sind. Also
die ID auf feste Breite mit Nullen auffüllen (Snowflakes sind ≤ 20 Stellen),
und Kanal und ID mit einem Trennzeichen verbinden, das in keinem von beiden
vorkommt.

`zuSatz` prüft **fail-closed**: fehlt ein Pflichtfeld oder hat es den falschen
Typ, gibt es `null` zurück, und der Aufrufer legt nichts ab.

- [ ] **Schritt 5: Tests laufen lassen** — erwartet 364 + 5 = **369 grün**, die
      fünf neuen namentlich in der Ausgabe. Fehlen sie, greift das Glob
      `web/test/*.test.ts` nicht.

- [ ] **Schritt 6: Committen**

```bash
git add web/src/lib/verlauf/ web/test/verlauf-satz.test.ts
git commit -m "feat(verlauf): Satzform des lokalen Nachrichtenspeichers"
```

---

### Task 2: Die Datenbank

**Files:**
- Create: `web/src/lib/verlauf/db.ts`, `web/src/lib/verlauf/index.ts`

**Interfaces:**
- Consumes: `schema.ts`, `satz.ts` aus Task 1
- Produces: `verlaufSpeichern(kanalId: string, nachrichten: unknown[]): Promise<number>` — gibt zurück, wie viele abgelegt wurden; **wirft nie**

- [ ] **Schritt 1: `db.ts` schreiben**

Am Muster von `lib/identity/idb-shared.ts` (geteilte, zwischengespeicherte
Verbindung; auflösen auf `tx.oncomplete`, **nicht** auf `req.onsuccess` — sonst
gilt ein Schreibvorgang als fertig, bevor er festgeschrieben ist).

Der Store bekommt `keyPath: 'schluessel'` und einen Index auf `kanalId`.

- [ ] **Schritt 2: `index.ts` schreiben — Fehler enden hier**

```ts
/**
 * Speichern darf die App NIE stoerten.
 *
 * In dieser Etappe liest niemand aus dem Verlauf; ein Fehlschlag ist deshalb
 * folgenlos. IndexedDB faellt in der Praxis aus: privates Fenster, voller
 * Speicher, ein Browser mit abgeschalteten Seitendaten. Wer das nach oben
 * durchreicht, laesst die Nachrichtenliste an etwas scheitern, das sie gar
 * nicht braucht.
 *
 * ACHTUNG fuer C2: sobald LOKAL GELESEN wird, ist ein verschluckter Fehler
 * kein Schulterzucken mehr, sondern ein leerer Verlauf ohne Erklaerung. Diese
 * Stelle muss dann laut werden.
 */
```

- [ ] **Schritt 3: Anschluss an die Eingänge**

Vollständig ausgezählt am 2026-08-28
(`rg -n "\b(messages|messageStore)\.(upsert|setInitial|prepend|mergeGap|reconcile|update|remove|addOptimistic)\(" web/src`):

| Stelle | Was |
|---|---|
| `routes/app/@me/[[dmChannelId]]/+page.svelte:89,144` | `setInitial` — Verlauf beim Öffnen einer DM |
| `routes/app/@me/[[dmChannelId]]/+page.svelte:186,203` | `addOptimistic` beim Absenden, `upsert` mit der echten Nachricht |
| `lib/components/MessageList.svelte:138` | `prepend` — Nachladen beim Hochscrollen |
| `lib/ws/handlers/chat.ts:49,65,69` | `upsert` / `update` / `remove` aus dem WS |
| `lib/ws/gapFill.ts:47,55,65` | `setInitial` / `mergeGap` / `reconcile` nach Wiederverbindung |

**Nur DM-Kanäle ablegen** — Community-Kanäle bleiben serverseitig (Spec §9).
Die Kanalseite (`routes/app/guilds/…/+page.svelte:213,300,438,455`) ruft
dieselben Methoden und wird deshalb **nicht** angeschlossen; wer nach Kanal-ID
unterscheidet statt nach Aufrufstelle, trifft das automatisch richtig.

**Zwei Fallen in dieser Liste:**
- `addOptimistic` legt eine Nachricht mit einer **vorläufigen `tmp-`-ID** an,
  die kurz darauf durch die echte ersetzt wird. Wer sie ablegt, hat einen Satz
  im Speicher, den es nie gab. Abgelegt wird erst beim `upsert` mit der echten
  Nachricht.
- `remove` ist ein **weiches** Löschen (`deleted_at`), kein Verschwinden. Der
  lokale Satz bekommt seinen Grabstein (`geloescht: true`), er wird nicht
  entfernt — sonst taucht die Nachricht beim nächsten Abgleich wieder auf.

Aufruf ohne `await` an einen Fehlerpfad hängen (`void verlaufSpeichern(...)`),
damit die Anzeige nicht auf die Platte wartet.

- [ ] **Schritt 4: `pnpm check` und `pnpm build`**

**Nicht neben einem laufenden Dev-Server**: `pnpm check` ruft
`paraglide:compile` mit und tauscht die Übersetzungs-Module unter Vite aus;
der Klient wirft danach `does not provide an export named 'm'`. Läuft ein
Stack, stattdessen `pnpm exec svelte-check --tsconfig ./tsconfig.json`.

- [ ] **Schritt 5: Von Hand nachsehen**

Nicht automatisierbar und trotzdem Pflicht: App starten, eine DM öffnen, eine
Nachricht schreiben, in den Entwicklerwerkzeugen unter Application →
IndexedDB → `pulse-verlauf` nachsehen, dass der Satz dort steht. **Ohne diesen
Blick ist nicht belegt, dass irgendetwas ankommt** — die Unit-Tests prüfen die
Satzform, nicht den Anschluss.

- [ ] **Schritt 6: Committen**

```bash
git commit -m "feat(verlauf): eingehende Direktnachrichten lokal ablegen"
```

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §7 verlangt, dass Nachrichtenliste, Vorschautexte und
Nachladen lokal werden. C1 deckt davon **nur das Ablegen**; C2 bis C4 sind
oben benannt und noch nicht geplant. Das ist Absicht und der Grund für den
Schnitt.

**Nicht in C1:** Lesen, Löschen alter Sätze, Speicherobergrenze,
Verschlüsselung des lokalen Bestands. Letzteres ist eine bewusste Auslassung —
der lokale Verlauf liegt zunächst im Klartext auf dem Gerät, so wie ihn heute
auch jede andere App hält. Ob er zusätzlich verschlüsselt werden soll, ist
eine eigene Entscheidung; das Schutzziel der Spec („nicht gegen ein Pulse, das
seine eigenen Nutzer angreift") verlangt es nicht.

**Diese Stelle lag beim ersten Schreiben bereits falsch**, und der Fall ist
lehrreich genug, um ihn stehen zu lassen: der Entwurf sprach von „drei
Eingängen" (`chat.ts`, `MessageList.svelte`, `gapFill.ts`) — abgeschrieben aus
einem Leselauf. Ausgezählt sind es **fünf Dateien**, und die wichtigste fehlte:
die DM-Seite selbst lädt den Verlauf und sendet. Derselbe Leselauf behauptete
ausserdem, `addOptimistic` habe keine Aufrufer; es hat zwei.

Die Lehre für den Umsetzer: die Tabelle in Schritt 3 ist ausgezählt, nicht
erinnert — aber sie ist vom 2026-08-28. Wer später hier arbeitet, zählt neu.
Ein Eingang, der nicht angeschlossen ist, fällt in keinem Test auf; er macht
den lokalen Verlauf nur still unvollständig, und das merkt man erst in C2.
