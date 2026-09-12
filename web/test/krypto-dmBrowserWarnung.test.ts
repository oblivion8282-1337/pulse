/**
 * Gegenprobe zu `$lib/krypto/dmBrowserWarnung.ts` — die Sichtbarkeitsregel
 * des Browser-Warnhinweises, der seit der Aufhebung der Koexistenz-Regel
 * (2026-09-12) anstelle der Wand den Datentransport-Schutz traegt.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { browserWarnungNoetig } from '../src/lib/krypto/dmBrowserWarnung.ts';

describe('browserWarnungNoetig', () => {
  test('reiner Browser ohne haltbares Geraet und ohne Sicherung → zeigen', () => {
    assert.equal(browserWarnungNoetig(false, false, false), true);
  });

  test('App-Kontext → nie zeigen (Speicherprofil ist dauerhaft)', () => {
    assert.equal(browserWarnungNoetig(true, false, false), false);
  });

  test('Konto mit haltbarem Geraet (App/gekoppelter Browser) → nicht zeigen', () => {
    assert.equal(browserWarnungNoetig(false, true, false), false);
  });

  test('verbundene Sicherung (Google Drive/Nextcloud) → nicht zeigen', () => {
    assert.equal(browserWarnungNoetig(false, false, true), false);
  });

  test('Auskunft noch unterwegs → nicht zeigen (kein Aufblitzen)', () => {
    assert.equal(browserWarnungNoetig(false, undefined, false), false);
    assert.equal(browserWarnungNoetig(false, false, undefined), false);
    assert.equal(browserWarnungNoetig(false, undefined, undefined), false);
  });
});
