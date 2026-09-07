import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lokaleIdsFuerLoeschung } from '../src/lib/krypto/loeschZiel.ts';

const ICH = 'konto-ich';
const PARTNER = 'konto-partner';

// Der Fall vom 2026-09-02: die Gegenseite hält die Nachricht unter der
// Zustellungs-ID und kennt die Absender-ID nur als krypto_id.
test('empfangene Nachricht wird ueber krypto_id gefunden, nicht ueber die Frame-ID', () => {
  const lokal = [
    { id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER },
    { id: 'zustellung-78', krypto_id: 'absender-2', author_id: PARTNER }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), ['zustellung-77']);
});

test('eigener Satz des Absenders traegt die Frame-ID direkt', () => {
  const lokal = [
    { id: 'absender-1', author_id: PARTNER },
    { id: 'absender-2', author_id: PARTNER }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), ['absender-1']);
});

test('beide Formen zugleich liefern jede lokale ID genau einmal', () => {
  const lokal = [
    { id: 'absender-1', author_id: PARTNER },
    { id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER },
    { id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), [
    'absender-1',
    'zustellung-77'
  ]);
});

test('ohne Treffer bleibt die Liste leer — der Aufrufer entscheidet dann', () => {
  assert.deepEqual(
    lokaleIdsFuerLoeschung('absender-9', [{ id: 'x', krypto_id: 'y', author_id: PARTNER }], PARTNER),
    []
  );
});

// Der eigentliche Riegel: ein Lösch-Frame trägt eine ID und sonst nichts.
// Der Gesprächspartner kennt die ID jeder Nachricht, die ich ihm geschickt
// habe — bei mir ist sie die lokale `id`. Ohne Autorvergleich löschte sein
// angepasster Klient meine eigenen Nachrichten auf meinem Gerät.
test('der Partner kann meine eigene Nachricht nicht loeschen', () => {
  const meineNachricht = [{ id: 'meine-1', author_id: ICH }];
  assert.deepEqual(lokaleIdsFuerLoeschung('meine-1', meineNachricht, PARTNER), []);
});

test('ich selbst loesche meine eigene Nachricht weiterhin', () => {
  const meineNachricht = [{ id: 'meine-1', author_id: ICH }];
  assert.deepEqual(lokaleIdsFuerLoeschung('meine-1', meineNachricht, ICH), ['meine-1']);
});

test('ein Satz ohne bekannten Autor wird nicht geloescht', () => {
  const ohneAutor = [{ id: 'zustellung-77', krypto_id: 'absender-1' }];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', ohneAutor, PARTNER), []);
});
