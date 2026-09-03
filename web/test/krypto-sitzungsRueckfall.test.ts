import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oeffneMitRueckfall } from '../src/lib/krypto/sitzungsRueckfall.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

test('bestehende Sitzung oeffnet — kein Aufbau noetig', () => {
  let aufgebaut = 0;
  const r = oeffneMitRueckfall(
    'alt',
    () => bytes('hallo'),
    () => {
      aufgebaut++;
      return { sitzung: 'neu', klartext: bytes('x') };
    }
  );
  assert.equal(r?.sitzung, 'alt');
  assert.equal(r?.neu, false);
  assert.equal(aufgebaut, 0);
});

test('alte Sitzung passt nicht, Umschlag ist Sitzungsaufbau — neue Sitzung', () => {
  const r = oeffneMitRueckfall(
    'alt',
    () => {
      throw new Error('OLM.BAD_MESSAGE_MAC');
    },
    () => ({ sitzung: 'neu', klartext: bytes('hallo') })
  );
  assert.equal(r?.sitzung, 'neu');
  assert.equal(r?.neu, true);
  assert.equal(new TextDecoder().decode(r!.klartext), 'hallo');
});

test('alte Sitzung passt nicht, Umschlag ist KEIN Aufbau — Fehler geht durch', () => {
  assert.throws(
    () =>
      oeffneMitRueckfall(
        'alt',
        () => {
          throw new Error('OLM.BAD_MESSAGE_MAC');
        },
        null
      ),
    /BAD_MESSAGE_MAC/
  );
});

test('keine Sitzung, kein Aufbau — liegen lassen', () => {
  assert.equal(oeffneMitRueckfall(null, () => bytes(''), null), null);
});

test('keine Sitzung, Aufbau vorhanden — neue Sitzung', () => {
  const r = oeffneMitRueckfall(null, () => bytes(''), () => ({ sitzung: 'neu', klartext: bytes('a') }));
  assert.equal(r?.neu, true);
});

test('Aufbau schlaegt fehl — Fehler wird nicht geschluckt', () => {
  assert.throws(
    () =>
      oeffneMitRueckfall(null, () => bytes(''), () => {
        throw new Error('Einmalschluessel unbekannt');
      }),
    /Einmalschluessel/
  );
});
