import { test } from 'node:test';
import assert from 'node:assert/strict';
import { umziehenNoetig } from '../src/lib/remote/umzugRegel.ts';

test('nichts lokal vorhanden -> kein Umzug', () => {
  assert.equal(
    umziehenNoetig({ lokalVorhanden: false, serverListeLeer: true, bereitsUmgezogen: false }),
    false,
  );
});

test('lokal vorhanden, Server leer -> Umzug', () => {
  assert.equal(
    umziehenNoetig({ lokalVorhanden: true, serverListeLeer: true, bereitsUmgezogen: false }),
    true,
  );
});

test('lokal vorhanden, Server nicht leer -> kein Umzug (Merker setzen)', () => {
  assert.equal(
    umziehenNoetig({ lokalVorhanden: true, serverListeLeer: false, bereitsUmgezogen: false }),
    false,
  );
});

test('bereits umgezogen -> kein Umzug', () => {
  assert.equal(
    umziehenNoetig({ lokalVorhanden: true, serverListeLeer: true, bereitsUmgezogen: true }),
    false,
  );
});
