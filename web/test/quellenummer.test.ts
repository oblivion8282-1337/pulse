import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monitorNummer, stromPasstZuMonitor } from '../src/lib/stream/settingsCatalog.ts';

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

test('die Nummer gewinnt gegen den Namen', () => {
  const mon = { index: 2, name: 'Dell U2723', primary: false };
  assert.equal(stromPasstZuMonitor({ monitor_index: 2, label: 'ganz anders' }, mon), true);
  assert.equal(
    stromPasstZuMonitor({ monitor_index: 3, label: 'Dell U2723' }, mon),
    false,
    'traegt der Strom eine Nummer, entscheidet NUR sie',
  );
});

test('ohne Nummer bleibt der Namensvergleich — fuer aeltere Klienten', () => {
  const mon = { index: 2, name: 'Dell U2723', primary: false };
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, mon), true);
  assert.equal(stromPasstZuMonitor({ label: '  dell u2723 ' }, mon), true, 'nachsichtig');
  assert.equal(stromPasstZuMonitor({ label: 'Monitor 2' }, mon), true);
  assert.equal(stromPasstZuMonitor({ label: 'BenQ 24' }, mon), false);
  assert.equal(stromPasstZuMonitor({}, mon), false, 'ohne alles passt nichts');
});

test('zwei baugleiche Monitore: mit Nummer eindeutig, ohne Nummer nicht', () => {
  const a = { index: 1, name: 'Dell U2723', primary: true };
  const b = { index: 2, name: 'Dell U2723', primary: false };
  // Mit Nummer trifft jeder Strom genau einen Schirm.
  assert.equal(stromPasstZuMonitor({ monitor_index: 1 }, a), true);
  assert.equal(stromPasstZuMonitor({ monitor_index: 1 }, b), false);
  // Ohne Nummer passt derselbe Strom auf BEIDE — genau die Mehrdeutigkeit,
  // wegen der die Nummer eingefuehrt wurde.
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, a), true);
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, b), true);
});
