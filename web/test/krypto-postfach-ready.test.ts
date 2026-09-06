/**
 * Bughunt-Runde 3, FIX 1: `postfachAbholenUndEntschluesseln` (`krypto/
 * empfangen.ts`) hatte bis hierhin GENAU EINEN Aufrufer im gesamten Baum —
 * den `postfach_neu`-WS-Handler (`ws/handlers/chat.ts`). Schloss der Nutzer
 * seinen Tab, riss die Verbindung ab, oder ging der (bewusst best-effort
 * versendete) Redis-Weckruf verloren, holte NIEMAND die waehrend der
 * Abwesenheit zugestellte Nachricht je ab — sie lag bis zur 30-Tage-Frist
 * ungelesen im Postfach. Der Plan verlangte ausdruecklich „Auf `postfach_neu`
 * (WS) und beim Start abholen" (`docs/superpowers/plans/2026-08-28-etappe-
 * d2-klient-verschluesselt.md`); nur die erste Haelfte war gebaut.
 *
 * `ws/handlers/ready.ts` (jeder Connect/Reconnect) ist die fehlende Haelfte
 * — geprueft wird hier NICHT das Laufzeitverhalten (beide Module ziehen den
 * vollen Svelte-Runes-/WASM-/IndexedDB-Importkegel und sind fuer Nodes
 * Testlaeufer deshalb unerreichbar, s. CLAUDE.md „Die Falle"), sondern der
 * Quelltext selbst: `ready.ts` muss die geteilte Abhol-Funktion aus
 * `chat.ts` importieren und im Cloud-Zweig des `ready`-Rahmens auch wirklich
 * aufrufen (DMs sind cloud-only, s. `krypto/empfangen.ts`-Modulkopf). Diese
 * GEGENPROBE schlaegt auf dem Stand VOR FIX 1 fehl: dort importierte/rief
 * `ready.ts` nichts dergleichen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const readyQuelle = readFileSync(
  join(HIER, '../src/lib/ws/handlers/ready.ts'),
  'utf8'
);
const chatQuelle = readFileSync(join(HIER, '../src/lib/ws/handlers/chat.ts'), 'utf8');

describe('ready.ts holt verpasste Postfach-Zustellungen nach', () => {
  it('importiert die geteilte Abhol-Anzeige-Funktion aus chat.ts', () => {
    assert.match(readyQuelle, /import\s*\{\s*postfachAbholenUndAnzeigen\s*\}\s*from\s*'\.\/chat'/);
  });

  it('ruft sie im ready-Handler tatsaechlich auf, nicht nur importiert', () => {
    assert.match(readyQuelle, /postfachAbholenUndAnzeigen\(/);
  });

  it('ruft sie NACH dem Cloud-Block-Beginn auf (DMs sind cloud-only)', () => {
    const cloudBlockStart = readyQuelle.indexOf('if (isCloud)');
    const aufrufStelle = readyQuelle.indexOf('postfachAbholenUndAnzeigen(', cloudBlockStart);
    assert.ok(cloudBlockStart >= 0, 'der Cloud-Zweig muss existieren');
    assert.ok(
      aufrufStelle > cloudBlockStart,
      'der Aufruf muss innerhalb des Cloud-Zweigs stehen, nicht davor'
    );
  });

  it('chat.ts exportiert die Funktion, die ready.ts importiert', () => {
    assert.match(chatQuelle, /export function postfachAbholenUndAnzeigen\(/);
  });

  it('der postfach_neu-Weckruf ruft weiterhin dieselbe Funktion auf (kein zweiter Weg)', () => {
    assert.match(chatQuelle, /registerWsHandler\('postfach_neu',[\s\S]{0,200}postfachAbholenUndAnzeigen\(/);
  });
});
