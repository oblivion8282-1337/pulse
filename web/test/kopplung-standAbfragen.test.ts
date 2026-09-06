/**
 * Sichere Standabfrage der Einloesen-Seite (Bughunt 2026-08-29, Befund 2):
 * `standPruefen` hatte als einzige der drei Funktionen dort kein try/catch —
 * ein Wurf (Kopplung weg, Netz weg) liess den Knopf wirkungslos aussehen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { standSicherAbfragen } from '../src/lib/kopplung/standAbfragen.ts';

test('ein erfolgreicher Abruf ohne Gesamtzahl ist noch nicht bereit', async () => {
  const ergebnis = await standSicherAbfragen(async () => ({ gesamt: null }));
  assert.deepEqual(ergebnis, { ok: true, bereit: false, gesamt: 0 });
});

test('ein erfolgreicher Abruf mit Gesamtzahl ist bereit', async () => {
  const ergebnis = await standSicherAbfragen(async () => ({ gesamt: 5 }));
  assert.deepEqual(ergebnis, { ok: true, bereit: true, gesamt: 5 });
});

test('ein Wurf mit bekanntem Server-Grund wird nicht durchgereicht, sondern zugeordnet', async () => {
  const fehler = { body: { detail: 'kopplung_unbekannt' } };
  const ergebnis = await standSicherAbfragen(async () => {
    throw fehler;
  });
  assert.deepEqual(ergebnis, { ok: false, fehler: 'kopplung_unbekannt' });
});

test('ein Wurf ohne erkennbaren Grund wird zu "unbekannt", nicht weitergeworfen', async () => {
  const ergebnis = await standSicherAbfragen(async () => {
    throw new Error('Netzwerkfehler');
  });
  assert.deepEqual(ergebnis, { ok: false, fehler: 'unbekannt' });
});
