import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planeFestigung,
  zieleAus,
  zielSchluessel
} from '../src/lib/ablage/festigungsPlan.ts';

test('ohne Verbindungen ist nichts zu tun', () => {
  const plan = planeFestigung([], new Set());
  assert.deepEqual(plan.zuStarten, []);
  assert.deepEqual(plan.zuStoppen, []);
});

test('eine Kanal-Verbindung wird gestartet', () => {
  const plan = planeFestigung([{ fuerKanal: '42' }], new Set());
  assert.deepEqual(plan.zuStarten, [{ art: 'kanal', id: '42' }]);
});

test('Community-Laufwerke zaehlen mit — sie hatten gar keinen App-weiten Start', () => {
  const plan = planeFestigung([{ fuerGuild: '7' }], new Set());
  assert.deepEqual(plan.zuStarten, [{ art: 'guild', id: '7' }]);
});

test('eine Verbindung kann beides tragen und ergibt zwei Ziele', () => {
  const ziele = zieleAus([{ fuerKanal: '42', fuerGuild: '7' }]);
  assert.equal(ziele.length, 2);
});

test('dieselbe Id in beiden Arten ist NICHT dasselbe Ziel', () => {
  // Kanal- und Community-Ids sind beide Snowflakes. Ohne die Art im
  // Schluessel hielte der Laeufer eine laufende Kanal-Schleife faelschlich
  // fuer die Community-Schleife und startete letztere nie.
  assert.notEqual(zielSchluessel({ art: 'kanal', id: '5' }), zielSchluessel({ art: 'guild', id: '5' }));
  const plan = planeFestigung([{ fuerKanal: '5', fuerGuild: '5' }], new Set(['kanal:5']));
  assert.deepEqual(plan.zuStarten, [{ art: 'guild', id: '5' }]);
});

test('ein bereits laufendes Ziel wird NICHT neu gestartet', () => {
  // Der eigentliche Zweck des Mengenvergleichs: ein Neustart bei jedem
  // Rundgang braeche eine gerade laufende Festigung ab.
  const plan = planeFestigung([{ fuerKanal: '42' }], new Set(['kanal:42']));
  assert.deepEqual(plan.zuStarten, []);
  assert.deepEqual(plan.zuStoppen, []);
});

test('ein entferntes Laufwerk wird gestoppt', () => {
  const plan = planeFestigung([], new Set(['kanal:42']));
  assert.deepEqual(plan.zuStoppen, [{ art: 'kanal', id: '42' }]);
});

test('zwei Verbindungen auf denselben Kanal ergeben EINE Schleife', () => {
  const plan = planeFestigung([{ fuerKanal: '42' }, { fuerKanal: '42' }], new Set());
  assert.deepEqual(plan.zuStarten, [{ art: 'kanal', id: '42' }]);
});

test('leere und fehlende Werte zaehlen nicht als Ziel', () => {
  const plan = planeFestigung([{ fuerKanal: '', fuerGuild: null }, {}], new Set());
  assert.deepEqual(plan.zuStarten, []);
});

test('ein fremder Schluessel in der laufenden Menge wird uebergangen', () => {
  // Geraten wird nicht: ein falsch zerlegter Schluessel stoppte sonst die
  // falsche Schleife.
  const plan = planeFestigung([], new Set(['unsinn:1', 'kanal:9']));
  assert.deepEqual(plan.zuStoppen, [{ art: 'kanal', id: '9' }]);
});
