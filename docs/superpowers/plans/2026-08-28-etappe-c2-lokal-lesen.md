# Etappe C2 — Der Klient liest aus seinem eigenen Speicher — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beim Öffnen einer Direktnachricht kommt der Verlauf aus dem lokalen
Speicher. Der Server wird nur noch gefragt, wenn etwas fehlt.

**Architecture:** Der lokale Speicher wird zur **ersten** Quelle, der Server zur
**Ergänzung**. Umgekehrt als heute. Die Anzeige selbst ändert sich nicht — sie
bekommt weiterhin ihre Liste aus dem `MessageStore`, nur wird der jetzt aus
zwei Richtungen gefüllt.

**Tech Stack:** SvelteKit 5 Runes · IndexedDB · Node-Testläufer · Playwright

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §7

**Vorbedingung:** C1 ist umgesetzt **und nachgewiesen** — es muss belegt sein,
dass der Speicher tatsächlich gefüllt wird, nicht nur, dass der Code dafür da
ist. Der Nachweis ist `web/tests/e2e/verlauf-lokal.spec.ts`. **Ohne einen
grünen Lauf davon nicht mit C2 anfangen:** C2 baut die Anzeige auf einen
Bestand, dessen Vollständigkeit dann Annahme statt Messung wäre.

## Der Unterschied zu C1, in einem Satz

In C1 war ein Fehler im Speicher folgenlos — niemand las daraus. **Ab hier ist
ein verschluckter Fehler ein leerer Verlauf ohne Erklärung.** `verlauf/index.ts`
trägt dazu bereits eine Warnung; sie einzulösen ist Task 1.

## Global Constraints

- **Quelldateien ≤ 350 Zeilen, Svelte-Komponenten ≤ 250.**
- **Node-Unit-Tests:** geprüfte Dateien **importfrei** halten (kein erweiterungsloser Laufzeit-Import). Die Rechnung gehört nach `lib/verlauf/`, nicht in eine Komponente.
- **Keine neuen Abhängigkeiten. Kein `git push`.**
- **Changelog: JA.** C2 ist die erste Etappe, die ein Nutzer merkt (der Verlauf steht sofort da, auch ohne Netz). Eintrag in `web/static/changelog.json`, Stil vom Eigentümer wählen lassen, **keine Emojis**, echte Umlaute.
- Deutsche Kommentare und Commit-Nachrichten.

---

### Task 1: Fehler dürfen nicht mehr stumm sein

**Files:**
- Modify: `web/src/lib/verlauf/index.ts`
- Create: `web/src/lib/verlauf/zustand.svelte.ts`
- Test: `web/test/verlauf-zustand.test.ts`

**Interfaces:**
- Produces: `verlaufZustand` — `{ verfuegbar: boolean; grund: string | null }`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

Die reine Rechnung — „welcher Fehler bedeutet was für den Nutzer" — gehört in
ein importfreies Modul und wird dort geprüft:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deuteSpeicherfehler } from '../src/lib/verlauf/zustand.svelte.ts';

test('ein privates Fenster ist kein Fehler, sondern eine Lage', () => {
  // Firefox und Safari verweigern IndexedDB im privaten Modus mit
  // SecurityError bzw. InvalidStateError. Das ist kein Defekt der App, und
  // die Meldung darf nicht so klingen.
  const gedeutet = deuteSpeicherfehler(
    Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' })
  );
  assert.equal(gedeutet.art, 'nicht_verfuegbar');
});

test('ein voller Speicher wird als solcher benannt', () => {
  const gedeutet = deuteSpeicherfehler(
    Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
  );
  assert.equal(gedeutet.art, 'voll');
});

test('alles Unbekannte gilt als echter Fehler', () => {
  // fail-loud: was wir nicht einordnen koennen, wird nicht beschoenigt.
  assert.equal(deuteSpeicherfehler(new Error('irgendwas')).art, 'fehler');
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen** (`cd web && pnpm test:unit`).

- [ ] **Schritt 3: Umsetzen**

`deuteSpeicherfehler` unterscheidet drei Lagen, und die Oberfläche behandelt sie
verschieden:

| Lage | Was der Nutzer sieht | Was der Klient tut |
|---|---|---|
| nicht verfügbar (privates Fenster) | ein ruhiger Hinweis, einmal | fällt auf den Server zurück |
| voll | Hinweis mit Handgriff (ältere Verläufe freigeben) | fällt auf den Server zurück |
| Fehler | sichtbare Meldung | fällt auf den Server zurück |

**In allen drei Fällen bleibt die App benutzbar** — der Rückfall auf den Server
ist der Punkt. Was sich ändert, ist, dass der Nutzer erfährt, warum sein
Verlauf nicht lokal liegt, statt es zu erraten.

- [ ] **Schritt 4: Tests laufen lassen, Committen**

---

### Task 2: Lesen mit dem Server als Ergänzung

**Files:**
- Modify: `web/src/lib/verlauf/db.ts` (Lesefunktionen), `web/src/lib/verlauf/index.ts`
- Modify: `web/src/routes/app/@me/[[dmChannelId]]/+page.svelte`, `web/src/lib/components/MessageList.svelte`
- Test: `web/test/verlauf-zusammenfuegen.test.ts`, `web/tests/e2e/verlauf-lokal.spec.ts` (erweitern)

**Interfaces:**
- Produces: `verlaufLesen(kanalId, { vor?, anzahl }) -> Satz[]`
- Produces: `zusammenfuegen(lokal: Satz[], vomServer: Satz[]) -> Satz[]` — **importfrei**

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

Das Zusammenfügen ist die einzige echte Rechnung und deshalb der einzige Teil,
der sich ohne Browser prüfen lässt:

```ts
test('doppelte Nachrichten erscheinen genau einmal', () => { /* … */ });

test('der Server gewinnt bei bearbeiteten Nachrichten', () => {
  // Ein Text kann nach dem lokalen Ablegen bearbeitet worden sein. Waere der
  // lokale Stand staerker, zeigte der Klient dauerhaft die alte Fassung —
  // und zwar NUR bei dem, der sie damals empfangen hat.
});

test('ein lokaler Grabstein ueberlebt eine Server-Antwort ohne ihn', () => {
  // Sonst kaeme eine geloeschte Nachricht beim naechsten Nachladen zurueck.
});

test('die Reihenfolge bleibt die der Nachrichten-IDs', () => { /* … */ });
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen.**

- [ ] **Schritt 3: Umsetzen**

Beim Öffnen einer DM:

1. Lokal lesen und **sofort** anzeigen (das ist der spürbare Gewinn).
2. Parallel beim Server die neuesten Nachrichten holen.
3. Zusammenfügen, Ergebnis in den `MessageStore`.

Beim Hochscrollen (`loadOlder`): erst lokal, und nur wenn dort nichts mehr
liegt, den Server fragen.

**Der Fehler, den man hier leicht macht:** anzunehmen, dass lokal
vorhanden = vollständig. Der Speicher wurde in C1 nur gefüllt, während der
Klient lief — alles, was auf einem anderen Gerät oder vor der Einführung
geschrieben wurde, fehlt. **Lokal ist ein Vorrat, keine Wahrheit.** Der
Server-Abgleich läuft deshalb immer mit, auch wenn lokal etwas da war.

- [ ] **Schritt 4: Den E2E-Nachweis erweitern**

`verlauf-lokal.spec.ts` bekommt einen Fall: Verlauf ist da → Seite neu laden →
die Nachrichten stehen sofort, **bevor** eine Antwort des Servers eintrifft.
Das ist die Aussage von C2, und sie ist nur im echten Browser prüfbar.

- [ ] **Schritt 5: `pnpm exec svelte-check`, `pnpm build`, Playwright, Committen**

---

### Task 3: Der Speicher braucht eine Obergrenze

**Files:**
- Modify: `web/src/lib/verlauf/db.ts`, `web/src/lib/verlauf/schema.ts`
- Test: `web/test/verlauf-obergrenze.test.ts`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```ts
test('die aeltesten Saetze fallen zuerst', () => { /* … */ });

test('ein Kanal mit wenigen Nachrichten wird nie beschnitten', () => {
  // Die Gegenprobe. Ohne sie beschneidet eine falsche Grenze alles.
});
```

- [ ] **Schritt 2 bis 4: Umsetzen, prüfen, committen**

**Warum das erst hier kommt und nicht in C1:** solange niemand liest, schadet
ein wachsender Speicher nur dem Platz. Ab C2 entscheidet er, was der Nutzer
sieht — und ein Speicher, der beim Überlaufen unkontrolliert Fehler wirft,
nimmt ihm den Verlauf an einer beliebigen Stelle.

**Was hier NICHT hingehört:** eine Grenze, die alte Nachrichten endgültig
verwirft. Solange der Server den Klartext-Bestand noch hat (bis Etappe I), ist
Beschneiden folgenlos — danach wäre es Datenverlust. **Wer Etappe I umsetzt,
kommt hierher zurück**; ab dann darf nur beschnitten werden, was auf einem
anderen Gerät des Kontos noch liegt.

**Und die Grenze ist nicht allein zu entscheiden.** Pulse hat heute eine
serverseitige DM-Suche (`GET /dm-channels-search`, am Telefon in
`MobileChatsSuche.svelte`), die E2E nicht überlebt und lokal nachgebaut werden
muss (C5). Eine lokale Suche ist nur so vollständig wie der lokale Verlauf —
und eine Suche ohne Treffer sagt nicht, ob es keinen gibt oder ob sie nur nicht
weit genug zurückreicht. **Wer hier eine Zahl festlegt, legt damit fest, wie
weit zurück ein Nutzer seine Gespräche wiederfindet.** Diese Aufgabe deshalb
nicht ohne einen Blick auf C5 abschliessen.

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §7 „das Nachladen beim Hochscrollen, heute über
Server-Cursor" → Task 2. „die Nachrichtenliste selbst" → Task 2. Die
Vorschautexte der DM-Liste sind **C3**, nicht hier — sie hängen an einer
anderen Datenquelle (`directMessages`), und beides zusammen wäre nicht mehr
einzeln rot zu sehen.

**Die riskanteste Stelle** ist Task 2 Schritt 3: „lokal ist ein Vorrat, keine
Wahrheit". Wer den Server-Abgleich weglässt, sobald lokal etwas da ist, baut
einen Klienten, der auf einem zweiten Gerät dauerhaft weniger zeigt — und das
sieht wie ein Server-Fehler aus.

**Bewusst offen:** ob der lokale Verlauf seinerseits verschlüsselt werden
sollte. Das Schutzziel der Spec verlangt es nicht (geschützt wird gegen den
Server, nicht gegen den Geräteinhaber), und jede Antwort darauf braucht einen
Ort für den Schlüssel — auf einem Gerät, das ihn beim Start selbst öffnen
können muss. Eigene Entscheidung, eigener Plan.
