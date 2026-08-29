/**
 * Gegenprobe zu `$lib/attachments/anhangKnopfSichtbar.ts`.
 *
 * Anlass: die alte Formel in `ChatView.svelte` nahm bei noch fehlender
 * Server-Auskunft `?? true` als Vorgabe — permissiv gedacht, aber fuer
 * DM-Anhaenge falsch herum: in der Cloud steht `cloud_dm_attachments_enabled`
 * auf `false`, die Antwort lautet also fast immer „nein", und die
 * Buero-Klammer erschien regelmaessig kurz, um gleich wieder zu verschwinden.
 * Seither gilt: unbekannt UND ausdruecklich verboten fuehren beide zu keinem
 * Knopf, nur ein bekanntes `true` (verschluesselt oder Server-Freigabe)
 * schaltet ihn frei.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { anhangKnopfSichtbar } from '../src/lib/attachments/anhangKnopfSichtbar.ts';

describe('anhangKnopfSichtbar — Kanal/Gruppe unveraendert', () => {
  test('ein normaler Kanal zeigt den Knopf immer', () => {
    assert.equal(anhangKnopfSichtbar('channel', false, undefined), true);
    assert.equal(anhangKnopfSichtbar('channel', false, false), true);
  });

  test('eine Gruppe folgt allein `verschluesselt` (kein Klartext-Weg)', () => {
    assert.equal(anhangKnopfSichtbar('gruppe', true, true), true);
    assert.equal(anhangKnopfSichtbar('gruppe', false, true), false);
    assert.equal(anhangKnopfSichtbar('gruppe', false, undefined), false);
  });
});

describe('anhangKnopfSichtbar — DM, die eigentliche Regel', () => {
  test('Server-Auskunft noch unterwegs (undefined) → kein Knopf', () => {
    assert.equal(anhangKnopfSichtbar('dm', false, undefined), false);
  });

  test('Server verbietet Klartext-Anhaenge ausdruecklich → kein Knopf', () => {
    assert.equal(anhangKnopfSichtbar('dm', false, false), false);
  });

  test('Server erlaubt Klartext-Anhaenge ausdruecklich → Knopf', () => {
    assert.equal(anhangKnopfSichtbar('dm', false, true), true);
  });

  test('Gespraech bekannt verschluesselt → Knopf, unabhaengig vom Server', () => {
    assert.equal(anhangKnopfSichtbar('dm', true, undefined), true);
    assert.equal(anhangKnopfSichtbar('dm', true, false), true);
  });
});
