import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verwaisteDurchCommunity,
  verwaisteDurchServer,
} from '../src/lib/devices/eintragungAbgleich.ts';

const eintragungen = [
  { serverId: 'cloud', guildId: 'g1', deviceId: 'd1' },
  { serverId: 'cloud', guildId: 'g2', deviceId: 'd2' },
  { serverId: 'selfhost', guildId: 'g1', deviceId: 'd3' },
];

test('Community fehlt in der Liste des Servers: die Eintragung ist tot', () => {
  assert.deepEqual(verwaisteDurchCommunity(eintragungen, 'cloud', ['g1']), ['d2']);
});

test('fremde Server bleiben unangetastet', () => {
  // `g1` steht in der Liste, `g2` nicht — aber die Eintragung des Self-Hosts
  // haengt an einer ganz anderen Communityliste und darf hier nie mitgeraeumt
  // werden.
  const raus = verwaisteDurchCommunity(eintragungen, 'cloud', ['g1']);
  assert.equal(raus.includes('d3'), false);
});

test('leere Communityliste raeumt NICHTS', () => {
  // Die wichtigste Zusage der Datei: „ich kenne keine Community" ist von „die
  // Liste ist mir gar nicht zugegangen" nicht zu unterscheiden. Eine lebende
  // Eintragung zu raeumen nimmt einem unbeaufsichtigten Rechner die Anmeldung,
  // und niemand sitzt davor, um sie neu zu setzen.
  assert.deepEqual(verwaisteDurchCommunity(eintragungen, 'cloud', []), []);
});

test('alles bekannt: nichts zu tun', () => {
  assert.deepEqual(verwaisteDurchCommunity(eintragungen, 'cloud', ['g1', 'g2']), []);
});

test('Server nicht mehr in der Serverliste: die Eintragung ist tot', () => {
  assert.deepEqual(verwaisteDurchServer(eintragungen, ['cloud']), ['d3']);
});

test('leere Serverliste raeumt NICHTS', () => {
  assert.deepEqual(verwaisteDurchServer(eintragungen, []), []);
});

test('mehrere tote Server auf einmal', () => {
  assert.deepEqual(verwaisteDurchServer(eintragungen, ['anderer']), ['d1', 'd2', 'd3']);
});
