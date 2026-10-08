import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ablehnungMerken,
  SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE,
  vorerklaerungNoetig,
  type Lage
} from '../src/lib/platform/berechtigungRegel.ts';

const lage = (teil: Partial<Lage> = {}): Lage => ({
  art: 'mikrofon',
  stand: 'offen',
  inHuelle: true,
  schonAbgelehnt: false,
  sendungen: 0,
  ...teil
});

test('im Browser nie — dort ist die Erlaubnis jederzeit umkehrbar', () => {
  assert.equal(vorerklaerungNoetig(lage({ inHuelle: false })), false);
});

test('erteilt oder verweigert: der Knopf oeffnet keinen Dialog mehr', () => {
  assert.equal(vorerklaerungNoetig(lage({ stand: 'erteilt' })), false);
  assert.equal(vorerklaerungNoetig(lage({ stand: 'verweigert' })), false);
});

test('wer "spaeter" gewaehlt hat, wird nicht erneut gefragt', () => {
  assert.equal(vorerklaerungNoetig(lage({ schonAbgelehnt: true })), false);
});

test('Mikrofon und Kamera: die Handlung erklaert sich selbst, sofort fragen', () => {
  assert.equal(vorerklaerungNoetig(lage({ art: 'mikrofon', sendungen: 0 })), true);
  assert.equal(vorerklaerungNoetig(lage({ art: 'kamera', sendungen: 0 })), true);
});

test('Mitteilungen brauchen einen Anlass — nicht die erste Begegnung', () => {
  assert.equal(vorerklaerungNoetig(lage({ art: 'mitteilungen', sendungen: 0 })), false);
  assert.equal(
    vorerklaerungNoetig(
      lage({ art: 'mitteilungen', sendungen: SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE - 1 })
    ),
    false
  );
  assert.equal(
    vorerklaerungNoetig(
      lage({ art: 'mitteilungen', sendungen: SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE })
    ),
    true
  );
});

test('die Schwelle sperrt nicht nachtraeglich — mehr Sendungen bleiben wahr', () => {
  assert.equal(vorerklaerungNoetig(lage({ art: 'mitteilungen', sendungen: 500 })), true);
});

test('nur ein anlassloses "spaeter" wird dauerhaft gemerkt', () => {
  // Mitteilungen haben keine ausloesende Handlung: "spaeter" heisst "frag mich
  // nicht wieder".
  assert.equal(ablehnungMerken('mitteilungen'), true);
  // Kamera und Mikrofon werden von einer Handlung ausgeloest: "spaeter" bricht
  // die Handlung ab und sagt nichts ueber die naechste. Wuerde man es merken,
  // kaeme beim naechsten Oeffnen der System-Dialog OHNE Erklaerung — genau
  // das, was dieser Punkt verhindern soll.
  assert.equal(ablehnungMerken('kamera'), false);
  assert.equal(ablehnungMerken('mikrofon'), false);
});
