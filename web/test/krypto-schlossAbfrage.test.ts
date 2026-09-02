import { test } from 'node:test';
import assert from 'node:assert/strict';

import { schlossAbfrageErzeugen } from '../src/lib/krypto/schlossAbfrage.ts';

// Der Speicher hinter dem Schloss-Kennzeichen haengt an einem `$effect`, und
// ein Effekt laeuft erneut, sobald irgendeine gelesene Abhaengigkeit sich
// ruehrt. Ohne Sperre stuende hinter jedem Wiederdurchlauf ein weiterer
// Serveraufruf — bei einem Konto, das man oft oeffnet, beliebig viele.

test('je Gespraech wird hoechstens einmal gefragt', async () => {
  const gefragt: string[] = [];
  const gemeldet: Array<[string, boolean]> = [];
  const sicherstellen = schlossAbfrageErzeugen(
    async (userId) => {
      gefragt.push(userId);
      return true;
    },
    (userId, wert) => gemeldet.push([userId, wert])
  );

  await sicherstellen('7');
  await sicherstellen('7');
  await sicherstellen('7');

  assert.deepEqual(gefragt, ['7']);
  assert.deepEqual(gemeldet, [['7', true]]);
});

test('verschiedene Gespraeche werden getrennt gefragt', async () => {
  const gefragt: string[] = [];
  const sicherstellen = schlossAbfrageErzeugen(
    async (userId) => {
      gefragt.push(userId);
      return userId === '7';
    },
    () => {}
  );

  await sicherstellen('7');
  await sicherstellen('8');
  await sicherstellen('7');

  assert.deepEqual(gefragt, ['7', '8']);
});

// Ein Netzwackler darf das Schloss nicht fuer die ganze Sitzung ausknipsen:
// der fehlgeschlagene Abruf gibt das Konto wieder frei.
test('ein Fehlschlag wird beim naechsten Betreten neu versucht', async () => {
  let rufe = 0;
  const sicherstellen = schlossAbfrageErzeugen(
    async () => {
      rufe += 1;
      if (rufe === 1) throw new Error('Netz weg');
      return true;
    },
    () => {}
  );

  await sicherstellen('7');
  await sicherstellen('7');

  assert.equal(rufe, 2);
});

// B11 (2026-09-02): die Stelle, die WEISS, dass sich der Stand geaendert hat
// (das eigene Geraet hat nachveroeffentlicht), darf die einmal-je-Konto-
// Sperre fuer genau diesen Abruf umgehen.
test('erneut: true fragt auch ein schon gefragtes Konto neu ab', async () => {
  const gefragt: string[] = [];
  const gemeldet: Array<[string, boolean]> = [];
  const sicherstellen = schlossAbfrageErzeugen(
    async (userId) => {
      gefragt.push(userId);
      return gefragt.length > 1;
    },
    (userId, wert) => gemeldet.push([userId, wert])
  );

  await sicherstellen('7');
  await sicherstellen('7'); // gesperrt — kein zweiter Aufruf
  await sicherstellen('7', { erneut: true }); // bewusst frisch

  assert.deepEqual(gefragt, ['7', '7']);
  assert.deepEqual(gemeldet, [['7', false], ['7', true]]);
});

test('ein fehlgeschlagener erneuter Abruf gibt das Konto wieder frei', async () => {
  let scheitern = true;
  let rufe = 0;
  const sicherstellen = schlossAbfrageErzeugen(
    async () => {
      rufe += 1;
      if (scheitern) throw new Error('Netz weg');
      return true;
    },
    () => {}
  );

  await sicherstellen('7', { erneut: true });
  scheitern = false;
  await sicherstellen('7');

  assert.equal(rufe, 2);
});
