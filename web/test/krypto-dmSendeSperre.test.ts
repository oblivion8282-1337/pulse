/**
 * Gegenprobe zu `$lib/krypto/dmSendeSperre.ts`.
 *
 * Seit der Aufhebung der Koexistenz-Regel (2026-09-12) gibt es nur noch den
 * Sperrgrund 'kontakt' (keine Freundschaft oder blockiert) — die Geraete-
 * Sperre 'ohne_app' (Spec §3a) ist gefallen: auch reine Browser-Konten
 * senden und empfangen. Diese Datei haelt fest, dass von der alten Regel
 * nichts uebrig bleibt.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dmSendeSperre } from '../src/lib/krypto/dmSendeSperre.ts';

describe('dmSendeSperre — nur noch Kontakt', () => {
  test('darf senden → nicht gesperrt', () => {
    assert.equal(dmSendeSperre(true), null);
  });

  test('Freundschaft weg/blockiert → gesperrt', () => {
    assert.equal(dmSendeSperre(false), 'kontakt');
  });
});
