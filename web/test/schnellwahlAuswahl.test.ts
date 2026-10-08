import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_EINTRAEGE,
  schnellwahlEintraege,
  type Gespraech
} from '../src/lib/platform/schnellwahlAuswahl.ts';

const g = (id: string, other: string, msg: string | null = '1'): Gespraech => ({
  id,
  other_user_id: other,
  last_message_id: msg
});

test('nimmt die Reihenfolge der Eingabe und baut den Chat-Pfad', () => {
  const e = schnellwahlEintraege([g('10', 'a'), g('20', 'b')], { a: 'Anna', b: 'Bert' });
  assert.deepEqual(e, [
    { titel: 'Anna', pfad: '/app/@me/10' },
    { titel: 'Bert', pfad: '/app/@me/20' }
  ]);
});

test('hoechstens drei — die Schnellwahl ist ein Sprung, keine zweite Liste', () => {
  const viele = ['1', '2', '3', '4', '5'].map((i) => g(i, i));
  const namen = Object.fromEntries(viele.map((x) => [x.other_user_id, 'N' + x.id]));
  assert.equal(schnellwahlEintraege(viele, namen).length, MAX_EINTRAEGE);
});

test('ohne Namen faellt das Gespraech heraus, nicht der Name', () => {
  // Der Nutzer-Cache ist beim Start kurz leer. Ein Platz mit einer Zahl
  // darauf bliebe ueber den Neustart stehen.
  const e = schnellwahlEintraege([g('10', 'a'), g('20', 'b')], { b: 'Bert' });
  assert.deepEqual(e, [{ titel: 'Bert', pfad: '/app/@me/20' }]);
});

test('ein leerer Name zaehlt wie keiner', () => {
  assert.deepEqual(schnellwahlEintraege([g('10', 'a')], { a: '   ' }), []);
});

test('leere Gespraeche sind keine letzten Gespraeche', () => {
  const e = schnellwahlEintraege([g('10', 'a', null), g('20', 'b')], { a: 'Anna', b: 'Bert' });
  assert.deepEqual(e, [{ titel: 'Bert', pfad: '/app/@me/20' }]);
});

test('nichts passendes ergibt eine leere Liste — die raeumt die Schnellwahl ab', () => {
  assert.deepEqual(schnellwahlEintraege([], {}), []);
});

test('die Drei-Grenze zaehlt NACH dem Filtern, nicht davor', () => {
  // Sonst verliert man Plaetze an Gespraeche, die ohnehin herausfallen.
  const liste = [g('1', 'x', null), g('2', 'y', null), g('3', 'a'), g('4', 'b'), g('5', 'c')];
  const e = schnellwahlEintraege(liste, { a: 'A', b: 'B', c: 'C' });
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((x) => x.titel), ['A', 'B', 'C']);
});
