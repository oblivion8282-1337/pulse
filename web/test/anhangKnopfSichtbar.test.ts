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
 *
 * **Seit Design §11.2 kommt eine zweite Auskunft dazu**: ein verschluesselter
 * Anhang landet im Cloud-Ordner jedes Beteiligten, und wer keinen hat, kann
 * ihn nicht empfangen. Sie gilt NUR fuer den verschluesselten Weg — der
 * Klartext-Weg legt bei Pulse ab, dort kann kein fremdes Laufwerk fehlen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  anhangGroesseOk,
  anhangKnopfGrund,
  anhangKnopfSichtbar
} from '../src/lib/attachments/anhangKnopfSichtbar.ts';

describe('anhangKnopfSichtbar — Kanal unveraendert', () => {
  test('ein normaler Kanal zeigt den Knopf immer', () => {
    assert.equal(anhangKnopfSichtbar('channel', false, undefined, undefined), true);
    assert.equal(anhangKnopfSichtbar('channel', false, false, false), true);
  });
});

describe('anhangKnopfSichtbar — Gruppe (kein Klartext-Weg)', () => {
  test('verschluesselt UND alle Laufwerke da → Knopf', () => {
    assert.equal(anhangKnopfSichtbar('gruppe', true, true, true), true);
  });

  test('ein Mitglied ohne Laufwerk blockiert die ganze Gruppe (§11.2)', () => {
    assert.equal(anhangKnopfSichtbar('gruppe', true, true, false), false);
  });

  test('Laufwerks-Auskunft noch unterwegs → kein Knopf', () => {
    assert.equal(anhangKnopfSichtbar('gruppe', true, true, undefined), false);
  });

  test('unverschluesselt bleibt ohne Knopf, egal was sonst gilt', () => {
    assert.equal(anhangKnopfSichtbar('gruppe', false, true, true), false);
    assert.equal(anhangKnopfSichtbar('gruppe', false, undefined, true), false);
  });
});

describe('anhangKnopfSichtbar — DM, die eigentliche Regel', () => {
  test('Server-Auskunft noch unterwegs (undefined) → kein Knopf', () => {
    assert.equal(anhangKnopfSichtbar('dm', false, undefined, true), false);
  });

  test('Server verbietet Klartext-Anhaenge ausdruecklich → kein Knopf', () => {
    assert.equal(anhangKnopfSichtbar('dm', false, false, true), false);
  });

  test('Server erlaubt Klartext-Anhaenge → Knopf, OHNE Laufwerk', () => {
    // Der Klartext-Weg legt bei Pulse ab. Ein fehlendes Laufwerk darf ihn
    // deshalb nicht sperren — sonst nimmt §11.2 einem Weg den Knopf, den es
    // gar nicht betrifft.
    assert.equal(anhangKnopfSichtbar('dm', false, true, false), true);
    assert.equal(anhangKnopfSichtbar('dm', false, true, undefined), true);
  });

  test('verschluesselt: der Server-Schalter zaehlt nicht mehr, das Laufwerk schon', () => {
    assert.equal(anhangKnopfSichtbar('dm', true, false, true), true);
    assert.equal(anhangKnopfSichtbar('dm', true, undefined, true), true);
    assert.equal(anhangKnopfSichtbar('dm', true, true, false), false);
    assert.equal(anhangKnopfSichtbar('dm', true, true, undefined), false);
  });
});

describe('anhangKnopfGrund — der Fall muss BENANNT werden (§11.2)', () => {
  test('nur ein ausdrueckliches Nein auf dem verschluesselten Weg', () => {
    assert.equal(anhangKnopfGrund('dm', true, false), 'kein-laufwerk');
    assert.equal(anhangKnopfGrund('gruppe', true, false), 'kein-laufwerk');
  });

  test('kein Hinweis, solange die Auskunft unterwegs ist', () => {
    // Ein kurz aufblitzender „dir fehlt ein Laufwerk"-Kasten bei jemandem,
    // der laengst eines hat, waere schlimmer als ein spaeter erscheinender.
    assert.equal(anhangKnopfGrund('dm', true, undefined), null);
  });

  test('kein Hinweis, wo Laufwerke keine Rolle spielen', () => {
    assert.equal(anhangKnopfGrund('channel', true, false), null);
    assert.equal(anhangKnopfGrund('dm', false, false), null);
  });
});

describe('anhangGroesseOk — die Grenze VOR dem Verschluesseln (§11.3)', () => {
  test('genau auf der Grenze passt noch', () => {
    assert.equal(anhangGroesseOk(25, 25), true);
    assert.equal(anhangGroesseOk(26, 25), false);
  });

  test('unbekannte Grenze laesst durch — der Server weist notfalls ab', () => {
    assert.equal(anhangGroesseOk(999_999_999, undefined), true);
  });
});
