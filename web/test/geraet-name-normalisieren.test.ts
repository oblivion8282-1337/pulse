import assert from 'node:assert/strict';
import { test } from 'node:test';

import { geraetNameNormalisieren } from '../src/lib/devices/geraetName.ts';

test('Gross wird klein', () => {
  assert.equal(geraetNameNormalisieren('Werkstatt-PC'), 'werkstatt-pc');
});

test('Leerzeichen werden Bindestriche, Folgen kollabieren', () => {
  assert.equal(geraetNameNormalisieren('werkstatt pc'), 'werkstatt-pc');
  assert.equal(geraetNameNormalisieren('mein  neuer   rechner'), 'mein-neuer-rechner');
});

test('Rand-Leerraum verschwindet, statt fuhrende Nachlauf-Bindestriche zu erzeugen', () => {
  assert.equal(geraetNameNormalisieren('  pc 1 '), 'pc-1');
});

test('Ungültige Zeichen fallen weg, Gültige bleiben', () => {
  assert.equal(geraetNameNormalisieren('rechner (admin)'), 'rechner-admin');
  assert.equal(geraetNameNormalisieren('werkstatt.pc_1'), 'werkstatt.pc_1');
  assert.equal(geraetNameNormalisieren('straße'), 'strae');
});
