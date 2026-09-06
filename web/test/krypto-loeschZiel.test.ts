import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lokaleIdsFuerLoeschung } from '../src/lib/krypto/loeschZiel.ts';

// Der Fall vom 2026-09-02: die Gegenseite hält die Nachricht unter der
// Zustellungs-ID und kennt die Absender-ID nur als krypto_id.
test('empfangene Nachricht wird ueber krypto_id gefunden, nicht ueber die Frame-ID', () => {
  const lokal = [
    { id: 'zustellung-77', krypto_id: 'absender-1' },
    { id: 'zustellung-78', krypto_id: 'absender-2' }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal), ['zustellung-77']);
});

test('eigener Satz des Absenders traegt die Frame-ID direkt', () => {
  const lokal = [{ id: 'absender-1' }, { id: 'absender-2' }];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal), ['absender-1']);
});

test('beide Formen zugleich liefern jede lokale ID genau einmal', () => {
  const lokal = [
    { id: 'absender-1' },
    { id: 'zustellung-77', krypto_id: 'absender-1' },
    { id: 'zustellung-77', krypto_id: 'absender-1' }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal), ['absender-1', 'zustellung-77']);
});

test('ohne Treffer bleibt die Liste leer — der Aufrufer entscheidet dann', () => {
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-9', [{ id: 'x', krypto_id: 'y' }]), []);
});
