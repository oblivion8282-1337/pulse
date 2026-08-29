/**
 * `berechneSynthChannel` entscheidet, welche Huelle `ChatView` bekommt — DM,
 * private Gruppe, oder gar keine. Bisher lag die Rechnung ungeprueft als
 * `$derived.by` in der Seite selbst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthKanal, berechneSynthChannel } from '../src/lib/components/chat/dmSynthChannel.ts';

test('synthKanal setzt eine leere guild_id und Typ 0', () => {
  assert.deepEqual(synthKanal('42', 'Alice', '2026-08-01T00:00:00Z'), {
    id: '42',
    guild_id: '',
    name: 'Alice',
    type: 0,
    position: 0,
    topic: null,
    created_at: '2026-08-01T00:00:00Z'
  });
});

test('eine aktive DM gewinnt und traegt den aufgeloesten Anzeigenamen', () => {
  const dm = { id: '1', other_user_id: 'u1', created_at: '2026-08-01T00:00:00Z' } as never;
  const result = berechneSynthChannel(dm, undefined, (id) => `Name-${id}`);
  assert.deepEqual(result, {
    id: '1',
    guild_id: '',
    name: 'Name-u1',
    type: 0,
    position: 0,
    topic: null,
    created_at: '2026-08-01T00:00:00Z'
  });
});

test('ohne aktive DM greift die private Gruppe mit ihrem eigenen Namen', () => {
  const gruppe = { id: '2', name: 'Team', created_at: '2026-08-02T00:00:00Z' };
  const result = berechneSynthChannel(undefined, gruppe, () => 'sollte-nicht-aufgerufen-werden');
  assert.deepEqual(result, {
    id: '2',
    guild_id: '',
    name: 'Team',
    type: 0,
    position: 0,
    topic: null,
    created_at: '2026-08-02T00:00:00Z'
  });
});

test('ohne DM und ohne Gruppe gibt es keine Huelle', () => {
  assert.equal(berechneSynthChannel(undefined, undefined, () => 'x'), null);
});

test('eine aktive DM hat Vorrang vor einer gleichzeitig gesetzten Gruppe', () => {
  const dm = { id: '1', other_user_id: 'u1', created_at: '2026-08-01T00:00:00Z' } as never;
  const gruppe = { id: '2', name: 'Team', created_at: '2026-08-02T00:00:00Z' };
  const result = berechneSynthChannel(dm, gruppe, (id) => `Name-${id}`);
  assert.equal(result?.id, '1');
});
