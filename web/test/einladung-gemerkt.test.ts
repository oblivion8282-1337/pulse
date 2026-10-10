import test from 'node:test';
import assert from 'node:assert/strict';
import {
  einladungMerken,
  gemerkteEinladung,
  gemerkteEinladungVerwerfen,
  SPEICHER_SCHLUESSEL,
  HALTBARKEIT_MS,
  type Speicher
} from '../src/lib/einladung/gemerkt.ts';

function speicher(): Speicher & { daten: Map<string, string> } {
  const daten = new Map<string, string>();
  return {
    daten,
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k)
  };
}

const T0 = 1_760_000_000_000;

test('merken und wieder lesen', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: 'pulse.example.de' }, T0);
  assert.deepEqual(gemerkteEinladung(s, T0 + 1000), { code: 'abc12345', host: 'pulse.example.de' });
});

test('verfällt nach 24 Stunden und wird dabei gelöscht', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: null }, T0);
  assert.equal(gemerkteEinladung(s, T0 + HALTBARKEIT_MS), null);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('Zeitstempel in der Zukunft gilt nicht (Uhr verstellt)', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: null }, T0 + 60_000);
  assert.equal(gemerkteEinladung(s, T0), null);
});

test('kaputte oder manipulierte Einträge werden verworfen', () => {
  for (const roh of [
    'kein json',
    'null',
    '"text"',
    JSON.stringify({ code: 'x', host: null, gemerktAm: T0 }),
    JSON.stringify({ code: 'abc12345', host: 'evil.example\\@victim.example', gemerktAm: T0 }),
    JSON.stringify({ code: 'abc12345', host: 7, gemerktAm: T0 }),
    JSON.stringify({ code: 'abc12345', host: null, gemerktAm: 'gestern' })
  ]) {
    const s = speicher();
    s.daten.set(SPEICHER_SCHLUESSEL, roh);
    assert.equal(gemerkteEinladung(s, T0), null, roh);
    assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false, roh);
  }
});

test('ein Speicher, der wirft, bricht nichts', () => {
  const wirft: Speicher = {
    getItem: () => {
      throw new Error('gesperrt');
    },
    setItem: () => {
      throw new Error('voll');
    },
    removeItem: () => {
      throw new Error('gesperrt');
    }
  };
  einladungMerken(wirft, { code: 'abc12345', host: null }, T0);
  assert.equal(gemerkteEinladung(wirft, T0), null);
  gemerkteEinladungVerwerfen(wirft);
  assert.equal(gemerkteEinladung(null, T0), null);
});

test('verwerfen löscht', () => {
  const s = speicher();
  einladungMerken(s, { code: 'abc12345', host: null }, T0);
  gemerkteEinladungVerwerfen(s);
  assert.equal(gemerkteEinladung(s, T0), null);
});
