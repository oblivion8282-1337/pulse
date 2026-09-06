import { test } from 'node:test';
import assert from 'node:assert/strict';

import { griffNutzbar } from '../src/lib/ablage/ordnerGriffEntscheidung.ts';

/**
 * `ordnerGriff.ts` selbst importiert `$lib/identity/idb-shared` — ein
 * aliasierter, erweiterungsloser Import, den Nodes eingebauter Testläufer
 * nicht auflösen kann (CLAUDE.md „Die Falle", dasselbe Muster wie bei
 * `verbindungen.svelte.ts` — s. `ablage-verbindungen.test.ts`). Geprüft wird
 * deshalb die reine Entscheidung aus `ordnerGriffEntscheidung.ts`, die
 * `ordnerGriff.ts::ladeNutzbarenGriff` benutzt, um zwischen einem nutzbaren
 * Zugriff und `LaufwerkWegFehler` zu unterscheiden.
 *
 * Die Szenarien aus dem Plan, auf die Entscheidung heruntergebrochen:
 *
 * - „Verbindung anlegen, Zugriff ablegen, Verbindung wiederherstellen" —
 *   das Handle liegt (IndexedDB überlebt den Neustart) UND die Berechtigung
 *   ist weiterhin erteilt: nutzbar.
 * - „neue Sitzung vortäuschen" — das Handle liegt weiterhin, aber der
 *   Browser hat die Berechtigung wie üblich auf `prompt` zurückgesetzt:
 *   NICHT ohne weiteres nutzbar (erst nach `griffBerechtigungAnfordern`,
 *   das `ladeNutzbarenGriff` selbst versucht).
 * - Gegenfall „Berechtigung verweigert" — weder `denied` noch ein ganz
 *   fehlendes Handle (`kein-griff`, z. B. nach `vergissGriff`) dürfen
 *   abstürzen, beide gelten als nicht nutzbar → `laufwerk-weg`.
 */

test('gewaehrte Berechtigung eines wiedergefundenen Griffs gilt als nutzbar', () => {
  assert.equal(griffNutzbar('granted'), true);
});

test('nach einem Neustart zurueckgesetzte Berechtigung (prompt) gilt NICHT als nutzbar', () => {
  // Das Handle selbst ist noch da (IndexedDB) — nur die Erlaubnis ist weg.
  // Genau der Fall, den `ladeNutzbarenGriff` mit `griffBerechtigungAnfordern`
  // aufzufangen versucht, bevor er `LaufwerkWegFehler` wirft.
  assert.equal(griffNutzbar('prompt'), false);
});

test('eine verweigerte Berechtigung gilt als nicht nutzbar', () => {
  assert.equal(griffNutzbar('denied'), false);
});

test('ein ganz fehlendes Handle (getrennt oder nie verbunden) gilt als nicht nutzbar', () => {
  assert.equal(griffNutzbar('kein-griff'), false);
});
