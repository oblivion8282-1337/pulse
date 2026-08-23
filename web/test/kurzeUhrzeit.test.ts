/**
 * Tests fuer die Zeitangabe in der Gespraechs-Liste
 * (`src/lib/utils/kurzeUhrzeit.ts`).
 *
 * Der Fall, der ohne Test still falsch waere, ist die Mitternachtsgrenze: eine
 * Nachricht von gestern 23:50 ist um 00:10 zehn Minuten alt. Wer in Stunden
 * rechnet, schreibt dort eine Uhrzeit hin, als waere sie von heute — und das
 * faellt niemandem auf, ausser nachts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { kurzeUhrzeit } from '../src/lib/utils/kurzeUhrzeit.ts';

const LOC = 'de-DE';

describe('kurzeUhrzeit', () => {
  it('gibt fuer heute eine Uhrzeit', () => {
    const jetzt = new Date('2026-08-22T18:00:00');
    const wert = kurzeUhrzeit('2026-08-22T14:03:00', jetzt, LOC);
    assert.match(wert, /^\d{2}:\d{2}$/);
  });

  it('gibt fuer gestern KEINE Uhrzeit', () => {
    const jetzt = new Date('2026-08-22T18:00:00');
    const wert = kurzeUhrzeit('2026-08-21T14:03:00', jetzt, LOC);
    assert.doesNotMatch(wert, /^\d{2}:\d{2}$/);
  });

  it('behandelt kurz nach Mitternacht als GESTERN, nicht als heute', () => {
    // Zehn Minuten alt, aber ein anderer Kalendertag.
    const jetzt = new Date('2026-08-22T00:10:00');
    const wert = kurzeUhrzeit('2026-08-21T23:50:00', jetzt, LOC);
    assert.doesNotMatch(wert, /^\d{2}:\d{2}$/, 'darf keine Uhrzeit sein');
  });

  it('gibt ab einer Woche ein Datum', () => {
    const jetzt = new Date('2026-08-22T18:00:00');
    const wert = kurzeUhrzeit('2026-08-01T14:03:00', jetzt, LOC);
    assert.match(wert, /\d{2}\.\d{2}/);
  });

  it('ist fuer fehlende oder unbrauchbare Angaben leer', () => {
    assert.equal(kurzeUhrzeit(null), '');
    assert.equal(kurzeUhrzeit(undefined), '');
    assert.equal(kurzeUhrzeit(''), '');
    assert.equal(kurzeUhrzeit('kein Datum'), '');
  });
});
