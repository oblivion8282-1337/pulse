import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OEFFENTLICHER_COMPUTER_DATENBANKEN } from '../src/lib/components/settings/oeffentlicherComputerDatenbanken.ts';

// Bughunt 2026-08-29, Befund 2: der "oeffentlicher Computer"-Knopf loeschte
// nur `pulse-identity` + `pulse-stream` — die Liste wurde nie nachgezogen,
// als der lokale Verlauf (`pulse-verlauf`, die EINZIGE Kopie verschluesselter
// Nachrichten samt entschluesselter Anhang-Bytes) dazukam.

test('die Loeschliste enthaelt den lokalen Verlauf', () => {
  assert.ok(
    OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse-verlauf'),
    'pulse-verlauf fehlt — die einzige Kopie verschluesselter Nachrichten bliebe auf einem geteilten Geraet stehen'
  );
});

test('die Loeschliste enthaelt weiterhin die bisherigen Datenbanken', () => {
  assert.ok(OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse-identity'));
  assert.ok(OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse-stream'));
});

test('die Loeschliste enthaelt die Presence-Datenbank', () => {
  // `StatusPicker.svelte`/`service-worker.ts` — traegt keinen Nachrichten-
  // inhalt, gehoert aber ebenso zum vorigen Nutzer.
  assert.ok(OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse_presence'));
});
