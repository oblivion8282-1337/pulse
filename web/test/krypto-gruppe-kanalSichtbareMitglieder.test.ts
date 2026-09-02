import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sichtbareMitglieder } from '../src/lib/krypto/gruppe/kanalSichtbareMitglieder.ts';
import { Perm } from '../src/lib/permissions/bitfield.ts';

const EVERYONE = { id: 'r-everyone', position: 0, permissions: Perm.VIEW_CHANNEL, is_everyone: true };
const MOD = { id: 'r-mod', position: 1, permissions: 0n, is_everyone: false };

test('everyone sieht den Kanal ohne Overwrites', () => {
  const raus = sichtbareMitglieder({
    mitglieder: [{ userId: 'anna', rollenIds: [] }, { userId: 'bert', rollenIds: [] }],
    rollen: [EVERYONE],
    overwrites: [],
    besitzerId: null
  });
  assert.deepEqual(new Set(raus), new Set(['anna', 'bert']));
});

test('ein VIEW_CHANNEL-deny auf @everyone sperrt aus, ausser mit User-Overwrite', () => {
  const raus = sichtbareMitglieder({
    mitglieder: [{ userId: 'anna', rollenIds: [] }, { userId: 'bert', rollenIds: [] }],
    rollen: [EVERYONE],
    overwrites: [
      { target_type: 0, target_id: 'r-everyone', allow: 0n, deny: Perm.VIEW_CHANNEL },
      { target_type: 1, target_id: 'anna', allow: Perm.VIEW_CHANNEL, deny: 0n }
    ],
    besitzerId: null
  });
  assert.deepEqual(raus, ['anna']);
});

test('eine Rolle mit VIEW_CHANNEL-Overwrite gibt der Trägerin Sicht', () => {
  const raus = sichtbareMitglieder({
    mitglieder: [
      { userId: 'anna', rollenIds: ['r-mod'] },
      { userId: 'bert', rollenIds: [] }
    ],
    rollen: [{ ...EVERYONE, permissions: 0n }, MOD],
    overwrites: [{ target_type: 0, target_id: 'r-mod', allow: Perm.VIEW_CHANNEL, deny: 0n }],
    besitzerId: null
  });
  assert.deepEqual(raus, ['anna']);
});

test('der Besitzer sieht immer, unabhaengig von Rollen/Overwrites', () => {
  const raus = sichtbareMitglieder({
    mitglieder: [{ userId: 'chef', rollenIds: [] }],
    rollen: [{ ...EVERYONE, permissions: 0n }],
    overwrites: [{ target_type: 1, target_id: 'chef', allow: 0n, deny: Perm.VIEW_CHANNEL }],
    besitzerId: 'chef'
  });
  assert.deepEqual(raus, ['chef']);
});

test('ein User-Overwrite gewinnt ueber ein Rollen-Overwrite', () => {
  const raus = sichtbareMitglieder({
    mitglieder: [{ userId: 'anna', rollenIds: ['r-mod'] }],
    rollen: [{ ...EVERYONE, permissions: 0n }, MOD],
    overwrites: [
      { target_type: 0, target_id: 'r-mod', allow: Perm.VIEW_CHANNEL, deny: 0n },
      { target_type: 1, target_id: 'anna', allow: 0n, deny: Perm.VIEW_CHANNEL }
    ],
    besitzerId: null
  });
  assert.deepEqual(raus, []);
});
