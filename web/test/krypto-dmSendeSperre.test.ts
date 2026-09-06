/**
 * Gegenprobe zu `$lib/krypto/dmSendeSperre.ts`.
 *
 * Anlass: Spec §3a („ohne App-Geraet gibt es keine Direktnachrichten"). Der
 * Klartext-Sendeweg fuer DMs faellt weg — kann die Gegenseite nicht
 * teilnehmen, muss das Eingabefeld GESPERRT sein statt still etwas anderes
 * zu tun. Vor dieser Aenderung sperrte die Ansicht ausschliesslich bei
 * „Freundschaft weg oder blockiert" (`can_send === false`) und fiel im
 * Schloss-Fall `false` stumm auf Klartext zurueck.
 *
 * Die drei Faelle, die hier festgehalten werden, sind genau die, die ohne die
 * Aenderung rot sind:
 *  1. Gegenseite kann nicht teilnehmen -> gesperrt.
 *  2. Stand noch unbekannt -> NICHT gesperrt (kurz gesperrt und dann frei
 *     waere schlimmer als umgekehrt).
 *  3. Schalter aus -> verhaelt sich wie heute, also nie wegen des Schlosses
 *     gesperrt.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dmSendeSperre } from '../src/lib/krypto/dmSendeSperre.ts';

describe('dmSendeSperre — Schalter AN (die neue Regel)', () => {
  test('Gegenseite ohne App-Geraet → gesperrt, mit eigenem Grund', () => {
    assert.equal(dmSendeSperre(true, true, false), 'ohne_app');
  });

  test('Stand noch unbekannt → NICHT gesperrt', () => {
    assert.equal(dmSendeSperre(true, true, undefined), null);
  });

  test('Gegenseite kann teilnehmen → nicht gesperrt', () => {
    assert.equal(dmSendeSperre(true, true, true), null);
  });

  test('Freundschaft weg/blockiert schlaegt den Schloss-Grund', () => {
    // Beide Gruende treffen zu; gemeldet wird der bestehende, weil er die
    // Ursache benennt, die der Nutzer selbst aufloesen kann.
    assert.equal(dmSendeSperre(true, false, false), 'kontakt');
    assert.equal(dmSendeSperre(true, false, undefined), 'kontakt');
  });
});

describe('dmSendeSperre — Schalter AUS (alles wie heute)', () => {
  test('kein Schloss-Grund, egal welcher Stand', () => {
    assert.equal(dmSendeSperre(false, true, false), null);
    assert.equal(dmSendeSperre(false, true, undefined), null);
    assert.equal(dmSendeSperre(false, true, true), null);
  });

  test('die bestehende Sperre bleibt unveraendert wirksam', () => {
    assert.equal(dmSendeSperre(false, false, true), 'kontakt');
  });
});
