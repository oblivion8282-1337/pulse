/**
 * Bughunt-Runde 3, FIX 3: scheitert NACH einer erfolgreichen Ablage NUR die
 * Quittung (`POST /postfach/quittung`), bleibt die Zustellung auf dem Server
 * liegen und kommt beim naechsten Zyklus unveraendert zurueck — aber die
 * Olm-Sitzung ist laengst ueber sie hinaus geratscht: ein zweiter
 * Entschluesselungsversuch scheitert dann GRUNDSAETZLICH. Ohne Gegenmassnahme
 * bleibt die Zustellung bis zur 30-Tage-Frist unquittiert liegen (einer von
 * 500 offenen Zustellungs-Plaetzen des Geraets, dauerhaft belegt).
 *
 * Geprueft wird hier NICHT das Laufzeitverhalten von `zustellungOeffnen.ts`
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
// `zustellungOeffnen` sass bis Etappe G2 in `empfangen.ts` und ist von dort
// herausgeloest, als die Datei mit den Gruppen-Abzweigungen ueber die
// Groessen-Policy gewachsen war (reiner Umzug). Der Pruefstein wandert mit —
// er beschreibt die Reihenfolge INNERHALB dieser Funktion, nicht die Datei.
const oeffnenQuelle = readFileSync(
  join(HIER, '../src/lib/krypto/zustellungOeffnen.ts'),
  'utf8'
);
const verlaufIndexQuelle = readFileSync(join(HIER, '../src/lib/verlauf/index.ts'), 'utf8');
const verlaufDbQuelle = readFileSync(join(HIER, '../src/lib/verlauf/db.ts'), 'utf8');

describe('zustellungOeffnen quittiert bereits abgelegte Zustellungen ohne erneutes Entschluesseln', () => {
  it('importiert verlaufSchonAbgelegt aus dem Verlauf-Modul', () => {
    assert.match(oeffnenQuelle, /verlaufSchonAbgelegt/);
  });

  it('prueft verlaufSchonAbgelegt VOR der Sitzungssperre (mitSitzungssperre)', () => {
    const funktionsStart = oeffnenQuelle.indexOf('async function zustellungOeffnen');
    const pruefStelle = oeffnenQuelle.indexOf('verlaufSchonAbgelegt(', funktionsStart);
    const sperrStelle = oeffnenQuelle.indexOf('mitSitzungssperre(', funktionsStart);
    assert.ok(funktionsStart >= 0, 'zustellungOeffnen muss existieren');
    assert.ok(pruefStelle >= 0 && sperrStelle >= 0, 'beide Stellen muessen vorkommen');
    assert.ok(
      pruefStelle < sperrStelle,
      'die Existenzpruefung muss vor der Sitzungssperre laufen'
    );
  });

  it('das Verlauf-Modul stellt verlaufSchonAbgelegt bereit, Kanal-gegated', () => {
    assert.match(verlaufIndexQuelle, /export function verlaufSchonAbgelegt/);
    // Muss denselben Kanal-Filter respektieren wie die uebrigen
    // Lesefunktionen dort (Community-Kanaele werden nicht lokal abgelegt).
    // Der Filter hiess bis Etappe G2 `istDmKanal` und heisst seither
    // `istLokalerKanal` — er deckt jetzt auch private Gruppen.
    const start = verlaufIndexQuelle.indexOf('export function verlaufSchonAbgelegt');
    const body = verlaufIndexQuelle.slice(start, start + 400);
    assert.match(body, /istLokalerKanal/);
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
