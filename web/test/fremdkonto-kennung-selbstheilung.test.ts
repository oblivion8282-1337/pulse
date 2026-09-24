/**
 * Selbstheilung bei Fremdkonto-Gerätekennung (2026-09-24, Nachroll zum
 * Sicherheits-Zweig PR #479).
 *
 * Vorfall: Nach einem Account-Wechsel ohne greifenden Owner-Wächter (fehler
 * —\npder Merker `pulse.identity_owner`, z. B. nach teilweisem Speicher-
 * Abräumen) lehnte der Server die lokale Gerätekennung mit 403 „Geraet
 * gehoert nicht zum angemeldeten Konto" ab. Die App versuchte daraufhin
 * endlos WEITER mit derselben Kennung: Anmeldung, Postfach-Abholung und
 * Einmalschlüssel-Nachschub scheiterten in Schleife (Michaels Browser-Log).
 *
 * Regel jetzt: `veroeffentlicheSchluessel` erkennt exakt diese Ablehnung,
 * verwirft Keypair + abgelegte Kennung, erzeugt ein frisches Gerät und
 * veröffentlicht GENAU EINMAL erneut. Keine andere 403 darf eine Identität
 * vernichten — nur dieser Fehlertext löst die Heilung aus.
 *
 * Quelltext-Prüfung nach Haus-Stil (WASM/IDB-Importkegel, s. CLAUDE.md).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const quelle = readFileSync(join(HIER, '../src/lib/krypto/veroeffentlichen.ts'), 'utf8');

describe('Fremdkonto-Gerätekennung heilt sich selbst', () => {
  it('erkennt NUR die Eigentümer-Ablehnung (403 + exakter Fehlertext)', () => {
    assert.match(quelle, /function istFremdkontoAblehnung/);
    assert.match(quelle, /err\.status === 403/);
    assert.match(
      quelle,
      /'Geraet gehoert nicht zum angemeldeten Konto'/
    );
  });

  it('verwirft Keypair + Kennung und baut ein frisches Gerät', () => {
    assert.match(quelle, /wipeKeypair\(\), geraeteKennungWischen\(\)/);
    assert.match(quelle, /generateKeypair\(\)/);
    assert.match(quelle, /await saveKeypair\(frisch\);/);
  });

  it(' GENAU EIN Retry — der zweite Fehlschlag geht ungefangen raus', () => {
    const versuche = quelle.match(/await veroeffentlichenLauf\(\);/g) ?? [];
    assert.equal(versuche.length, 2, 'erster Versuch + genau ein Retry');
  });

  it('der Retry läuft NACH dem Neuaufbau (Wisch-Reihenfolge)', () => {
    const wisch = quelle.indexOf('wipeKeypair()');
    const retry = quelle.lastIndexOf('await veroeffentlichenLauf();');
    assert.ok(wisch > 0 && retry > wisch, 'Wisch vor dem zweiten Lauf');
  });
});
