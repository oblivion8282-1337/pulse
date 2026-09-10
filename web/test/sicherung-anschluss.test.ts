/**
 * 2026-09-10, „Laufwerk verbunden, aber nichts kommt an": drei Gegenproben
 * gegen die Wiederkehr der Lücken, die das Wiederverbinden des Archiv-
 * Laufwerks und das Öffnen eines DM-Kanals betreffen. Die Laufzeit ist im
 * Node-Läufer nicht erreichbar (Svelte-Runes-/IndexedDB-Importkegel,
 * s. CLAUDE.md „Die Falle"), deshalb Quelltext-Gegenproben wie in
 * `krypto-postfach-ready.test.ts` — jede schlägt auf dem Stand VOR dem
 * Fix fehl.
 *
 *   Lücke 1: `nextcloudVerbunden` schrieb das Ziel und zeigte das Passwort-
 *     Formular — lief der DEK bereits im Zwischenlager (Passwort auf DIESEM
 *     Gerät schon einmal eingegeben, Laufwerk nur neu verbunden), geschah
 *     GAR nichts: kein Archiv-Lauf, keine sichtbaren Nachrichten.
 *   Lücke 2: der Archiv-Nachzug beim Öffnen eines DM-Kanals lief nur bei
 *     < 50 sichtbaren lokalen Sätzen — ein voller lokaler Bestand stellte
 *     die Klappe zu, und Nachrichten, die ein anderes Gerät des Kontos ins
 *     Archiv gesichert hatte, wurden nie abgeholt.
 *   Lücke 3: der Archiv-Lauf meldete sich nicht, wenn er etwas brachte —
 *     `laden()` warf die Zahl weg (`const anzahl = 0;`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const lese = (rel: string) =>
  readFileSync(join(HIER, '..', rel), 'utf8');
const sektionQuelle = lese('src/lib/components/settings/SicherungSektion.svelte');
const wechselQuelle = lese('src/lib/components/chat/dmKanalWechsel.svelte.ts');

describe('Sicherung: Wiederverbinden des Laufwerks holt das Archiv nach', () => {
  it('nextcloudVerbunden lädt das Archiv, wenn der DEK bereits im Zwischenlager liegt', () => {
    // Der Zweig muss VOR dem Passwort-Fallback stehen und laden() aufrufen.
    const dekZweig = sektionQuelle.indexOf('dekAusZwischenlager()) !== null');
    const ladeStelle = sektionQuelle.indexOf('void laden()', dekZweig);
    const passwortStelle = sektionQuelle.indexOf("zustand = 'passwort'", dekZweig);
    assert.ok(dekZweig >= 0, 'es gibt einen DEK-vorhanden-Zweig in nextcloudVerbunden');
    assert.ok(
      ladeStelle >= 0 && passwortStelle >= 0 && ladeStelle < passwortStelle,
      'bei vorhandenem DEK wird geladen, nicht nach dem Passwort gefragt'
    );
  });

  it('der Archiv-Lauf meldet die Zahl wiederhergestellter Nachrichten als Toast', () => {
    assert.match(sektionQuelle, /const anzahl = await sicherungArchivLaden\(\)/);
    assert.match(sektionQuelle, /anzahl > 0[\s\S]{0,80}toast\.success\(m\.sicherung_archiv_geladen/);
    assert.doesNotMatch(sektionQuelle, /const anzahl = 0/);
  });

  it('der DM-Kanalwechsel fragt das Archiv bei JEDEM Frischladen, nicht nur bei dünnem Bestand', () => {
    assert.doesNotMatch(
      wechselQuelle,
      /length < 50[\s\S]{0,300}sicherungKanalSeiteLaden/,
      'die 50er-Klappe darf den Archiv-Nachzug nicht mehr torpedieren'
    );
    assert.match(
      wechselQuelle,
      /if \(!alreadyLoaded\) \{\s*void import\('\$lib\/sicherung\/andock'\)/,
      'der Nachzug läuft bei jedem Frischladen des Kanals'
    );
  });
});
