/**
 * Bughunt-Runde 3, FIX 3: scheitert NACH einer erfolgreichen Ablage NUR die
 * Quittung (`POST /postfach/quittung`), bleibt die Zustellung auf dem Server
 * liegen und kommt beim naechsten Zyklus unveraendert zurueck — aber die
 * Olm-Sitzung ist laengst ueber sie hinaus geratscht: ein zweiter
 * Entschluesselungsversuch scheitert dann GRUNDSAETZLICH. Ohne Gegenmassnahme
 * bleibt die Zustellung bis zur 30-Tage-Frist unquittiert liegen (einer von
 * 500 offenen Zustellungs-Plaetzen des Geraets, dauerhaft belegt).
 *
 * Geprueft wird hier NICHT das Laufzeitverhalten von `empfangen.ts` selbst
 * (WASM-/IndexedDB-Importkegel, fuer Nodes Testlaeufer unerreichbar, s.
 * CLAUDE.md „Die Falle") — sondern der Quelltext: `zustellungOeffnen` muss
 * `verlaufSchonAbgelegt` GANZ ZU BEGINN pruefen (vor der Sitzungssperre, vor
 * `absenderErmitteln`, vor jedem Entschluesseln), damit eine schon lokal
 * abgelegte Zustellung ohne erneuten Entschluesselungsversuch quittiert
 * werden kann. Diese GEGENPROBE schlaegt auf dem Stand VOR FIX 3 fehl: dort
 * gab es `verlaufSchonAbgelegt` gar nicht, und ein zweiter Versuch schlug
 * ausnahmslos fehl, egal ob der Klartext schon abgelegt war oder nicht.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const empfangenQuelle = readFileSync(join(HIER, '../src/lib/krypto/empfangen.ts'), 'utf8');
const verlaufIndexQuelle = readFileSync(join(HIER, '../src/lib/verlauf/index.ts'), 'utf8');
const verlaufDbQuelle = readFileSync(join(HIER, '../src/lib/verlauf/db.ts'), 'utf8');

describe('empfangen.ts quittiert bereits abgelegte Zustellungen ohne erneutes Entschluesseln', () => {
  it('importiert verlaufSchonAbgelegt aus dem Verlauf-Modul', () => {
    assert.match(empfangenQuelle, /verlaufSchonAbgelegt/);
  });

  it('prueft verlaufSchonAbgelegt VOR der Sitzungssperre (mitSitzungssperre)', () => {
    const funktionsStart = empfangenQuelle.indexOf('async function zustellungOeffnen');
    const pruefStelle = empfangenQuelle.indexOf('verlaufSchonAbgelegt(', funktionsStart);
    const sperrStelle = empfangenQuelle.indexOf('mitSitzungssperre(', funktionsStart);
    assert.ok(funktionsStart >= 0, 'zustellungOeffnen muss existieren');
    assert.ok(pruefStelle >= 0 && sperrStelle >= 0, 'beide Stellen muessen vorkommen');
    assert.ok(
      pruefStelle < sperrStelle,
      'die Existenzpruefung muss vor der Sitzungssperre laufen'
    );
  });

  it('das Verlauf-Modul stellt verlaufSchonAbgelegt bereit, DM-Kanal-gegated', () => {
    assert.match(verlaufIndexQuelle, /export function verlaufSchonAbgelegt/);
    // Muss denselben DM-Kanal-Filter respektieren wie die uebrigen Lesefunktionen
    // hier (Community-Kanaele werden nicht lokal abgelegt).
    const start = verlaufIndexQuelle.indexOf('export function verlaufSchonAbgelegt');
    const body = verlaufIndexQuelle.slice(start, start + 400);
    assert.match(body, /istDmKanal/);
  });

  it('die Existenzpruefung fragt die vorhandene Verlaufs-DB ab, nicht einen neuen Cache', () => {
    assert.match(verlaufDbQuelle, /export function verlaufSatzVorhanden/);
    const start = verlaufDbQuelle.indexOf('export function verlaufSatzVorhanden');
    const body = verlaufDbQuelle.slice(start, start + 600);
    // Muss ueber den Primaerschluessel des BESTEHENDEN Nachrichten-Stores lesen
    // (sortierSchluessel + store.get) — kein eigenes, neues Objekt-Store.
    assert.match(body, /sortierSchluessel/);
    assert.match(body, /\.get\(/);
  });
});
