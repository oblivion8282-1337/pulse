/**
 * Intra-Refresh ist ABGEWAEHLT, und zwar ohne Ausnahme.
 *
 * **Warum es diesen Test gibt.** Die Vorgabe ist am 2026-08-18 auf „aus"
 * gesetzt worden — begruendet mit einer Messreihe (bei 60 s Vollbild-Abstand
 * +1,87 VMAF bei 16 % weniger Daten ohne Intra-Refresh) und damit, dass ein
 * Intra-Refresh-Strom sich nach Paketverlust nicht selbst heilt. Sie war am
 * selben Tag trotzdem NICHT wirksam: die Uebersteuerungen starten zwar leer,
 * aber `loadCatalogs()` hob ein `undefined` beim Oeffnen des HQ-Panels wieder
 * auf `true`. Die Pruefung, die das haette finden muessen, hat auf die
 * Vorgabewerte und die Profile geschaut — nicht auf die eine Zeile, die den
 * Wert nachtraeglich setzt. Und die einmalige Bereinigung fuer Bestandsnutzer
 * lief dagegen ins Leere: sie loescht den Wert, der naechste Panel-Aufruf
 * setzte ihn erneut.
 *
 * Der Test liest deshalb **Text, keine Module** — dieselbe Bauart wie
 * `desktop/test/storeAllowlist.test.ts` und aus demselben Grund: die
 * betroffenen Dateien sind Svelte-TypeScript mit Runes und erweiterungslosen
 * Nachbar-Importen, Nodes Laeufer kann sie nicht laden (siehe Kopf von
 * `diagnose-bericht.test.ts`). Ein grobes Muster, das genau die Sorte Zeile
 * findet, ist hier mehr wert als gar keine Absicherung.
 *
 * Wer die Vorgabe bewusst wieder umdreht, aendert diesen Test mit — dann ist
 * es eine Entscheidung und kein Versehen. Genau das war der Unterschied, der
 * am 2026-08-18 gefehlt hat.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const QUELLEN = join(import.meta.dirname, '..', 'src', 'lib');

function dateien(verzeichnis: string): string[] {
  const gefunden: string[] = [];
  for (const eintrag of readdirSync(verzeichnis, { withFileTypes: true })) {
    const pfad = join(verzeichnis, eintrag.name);
    if (eintrag.isDirectory()) gefunden.push(...dateien(pfad));
    else if (eintrag.name.endsWith('.ts') || eintrag.name.endsWith('.svelte')) gefunden.push(pfad);
  }
  return gefunden;
}

describe('Intra-Refresh-Vorgabe', () => {
  it('keine Stelle setzt ihn auf `true`', () => {
    // Nur das Literal. `intra_refresh: o.intra_refresh === true` (eine
    // Uebernahme aus gespeicherten Daten) und `intra_refresh: an` (der Haken
    // in der Oberflaeche) sind ausdruecklich in Ordnung — verboten ist die
    // stille Vorgabe, nicht der Wert an sich.
    const treffer: string[] = [];
    for (const datei of dateien(QUELLEN)) {
      readFileSync(datei, 'utf8')
        .split('\n')
        .forEach((zeile, i) => {
          if (/intra_refresh:\s*true\b/.test(zeile)) {
            treffer.push(`${datei.slice(QUELLEN.length + 1)}:${i + 1}`);
          }
        });
    }
    assert.deepEqual(
      treffer,
      [],
      `Intra-Refresh wird hier fest auf true gesetzt: ${treffer.join(', ')}`,
    );
  });

  it('das Standplatz-Profil startet ohne ihn', () => {
    // Der zweite Ort mit einer eigenen Vorgabe (`devices/profil.svelte.ts`) —
    // er haengt nicht an den Uebersteuerungen des HQ-Panels und muesste sonst
    // getrennt vergessen werden koennen.
    const quelle = readFileSync(join(QUELLEN, 'devices', 'profil.svelte.ts'), 'utf8');
    assert.match(
      quelle,
      /intra_refresh:\s*false/,
      'devices/profil.svelte.ts hat keine Vorgabe `intra_refresh: false` mehr',
    );
  });
});
