import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nachzugAktion } from '../src/lib/devices/nachzugAktion.ts';

test('fremdes Geraet (keine eigene Eintragung mit dieser Kennung) → nichts tun', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: false, entfernt: false, unveraendert: false }),
    'nichts',
  );
});

test('fremdes Geraet, obendrein entfernt → bleibt trotzdem nichts tun', () => {
  // Der Frühausstieg ist UNBEDINGT — auch ein removed:true über ein fremdes
  // Gerät darf diesen Rechner nicht anfassen.
  assert.equal(
    nachzugAktion({ hatEintragung: false, entfernt: true, unveraendert: false }),
    'nichts',
  );
});

test('eigenes Geraet, removed → vergessen', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: true, unveraendert: false }),
    'vergessen',
  );
});

test('eigenes Geraet, andere Community als lokal gemerkt → nachziehen', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: false, unveraendert: false }),
    'nachziehen',
  );
});

test('eigenes Geraet, unveraendert → nichts zu tun', () => {
  assert.equal(
    nachzugAktion({ hatEintragung: true, entfernt: false, unveraendert: true }),
    'nichts',
  );
});
