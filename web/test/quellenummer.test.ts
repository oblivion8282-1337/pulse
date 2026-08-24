import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monitorNummer } from '../src/lib/stream/settingsCatalog.ts';

test('eine Monitor-Quelle liefert ihre Nummer', () => {
  assert.equal(monitorNummer('Monitor: 3'), 3);
  assert.equal(monitorNummer('Monitor: 1'), 1);
});

test('Rand und Grossschreibung stoeren nicht, ein fehlender Vorsatz schon', () => {
  assert.equal(monitorNummer('  Monitor: 2  '), 2);
  assert.equal(monitorNummer('monitor: 2'), undefined, 'Vorsatz ist gross geschrieben');
});

test('was kein Monitor ist, hat keine Nummer', () => {
  assert.equal(monitorNummer('window:12345'), undefined);
  assert.equal(monitorNummer('portal'), undefined);
  assert.equal(monitorNummer(''), undefined);
  assert.equal(monitorNummer(undefined), undefined);
  assert.equal(monitorNummer(null), undefined);
});

test('Unfug ergibt keine Nummer statt NaN', () => {
  assert.equal(monitorNummer('Monitor: abc'), undefined);
  assert.equal(monitorNummer('Monitor: '), undefined);
  assert.equal(monitorNummer('Monitor: 1.5'), undefined, 'nur ganze Zahlen');
  assert.equal(monitorNummer('Monitor: -1'), undefined, 'keine negativen');
});
