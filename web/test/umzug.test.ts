import { test } from 'node:test';
import assert from 'node:assert/strict';
import { umziehenNoetig, serverBereitsUmgezogen } from '../src/lib/remote/umzugRegel.ts';

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


test('serverBereitsUmgezogen: kein Merker -> kein Server erledigt', () => {
  assert.equal(serverBereitsUmgezogen(undefined, 'server-a'), false);
});

test('serverBereitsUmgezogen: legacy true -> jeder Server gilt als erledigt', () => {
  assert.equal(serverBereitsUmgezogen(true, 'server-a'), true);
  assert.equal(serverBereitsUmgezogen(true, 'server-b'), true);
});

test('serverBereitsUmgezogen: Liste trifft nur die eingetragenen Server', () => {
  assert.equal(serverBereitsUmgezogen(['server-a'], 'server-a'), true);
  assert.equal(serverBereitsUmgezogen(['server-a'], 'server-b'), false);
});

test('Mehrfach-Server: Server A erledigt, Server B zieht trotzdem noch um', () => {
  const merkerNachServerA = ['server-a'];

  // Server A: schon erledigt -> kein weiterer Umzug.
  assert.equal(
    umziehenNoetig({
      lokalVorhanden: true,
      serverListeLeer: true,
      bereitsUmgezogen: serverBereitsUmgezogen(merkerNachServerA, 'server-a'),
    }),
    false,
  );

  // Server B: eigener Merker-Eintrag fehlt -> zieht trotzdem um, obwohl
  // Server A schon erledigt ist. Der Umzug ist NICHT global.
  assert.equal(
    umziehenNoetig({
      lokalVorhanden: true,
      serverListeLeer: true,
      bereitsUmgezogen: serverBereitsUmgezogen(merkerNachServerA, 'server-b'),
    }),
    true,
  );
});
