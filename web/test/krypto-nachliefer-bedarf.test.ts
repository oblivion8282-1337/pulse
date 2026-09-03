import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nachlieferBedarf } from '../src/lib/krypto/gruppe/nachlieferBedarf.ts';
import type { Gruppenstand } from '../src/lib/krypto/gruppe/sitzungswahl.ts';

/** Ein Stand mit Platzhalter-Sitzung — die Rechnung fasst sie nie an. */
function stand(felder: Partial<Gruppenstand<string>> = {}): Gruppenstand<string> {
  return {
    sitzungId: 's1',
    sitzung: 'sitzung',
    mitglieder: ['anna', 'bert'],
    beliefert: [],
    nachrichten: 0,
    angelegtAm: 1000,
    ...felder
  };
}

const liste = {
  anna: ['anna-hier', 'anna-handy'],
  bert: ['bert-1']
};

test('ohne Sitzung muss fuer jedes Konto mit Geraet geclaimt werden', () => {
  const bedarf = nachlieferBedarf(null, ['anna', 'bert'], liste, 'anna', 'anna-hier', 2000);
  assert.deepEqual(bedarf.konten, ['anna', 'bert']);
  assert.equal(bedarf.grund, 'keine');
});

test('voll belieferte Sitzung braucht KEINEN claim', () => {
  // Der Punkt der ganzen Rechnung: das eigene aktuelle Geraet zaehlt nicht
  // mit, alle uebrigen sind beliefert — es gibt nichts zu holen.
  const bedarf = nachlieferBedarf(
    stand({ beliefert: ['anna-handy', 'bert-1'] }),
    ['anna', 'bert'],
    liste,
    'anna',
    'anna-hier',
    2000
  );
  assert.deepEqual(bedarf.konten, []);
  assert.equal(bedarf.grund, null);
});

test('ein neues Geraet eines Mitglieds zieht NUR dessen Konto herein', () => {
  const bedarf = nachlieferBedarf(
    stand({ beliefert: ['anna-handy'] }),
    ['anna', 'bert'],
    liste,
    'anna',
    'anna-hier',
    2000
  );
  assert.deepEqual(bedarf.konten, ['bert']);
  assert.equal(bedarf.grund, null);
});

test('das eigene aktuelle Geraet loest nie einen claim aus', () => {
  // `anna-hier` steht in der Serverliste, ist aber dieses Geraet selbst —
  // es hat den Klartext ohnehin, und eine Olm-Sitzung mit sich selbst gibt
  // es nicht. Waere es mitgezaehlt, entstuende bei JEDEM Kanal-Oeffnen ein
  // claim, obwohl nichts offen ist.
  const bedarf = nachlieferBedarf(
    stand({ beliefert: ['anna-handy', 'bert-1'] }),
    ['anna', 'bert'],
    liste,
    'anna',
    'anna-hier',
    2000
  );
  assert.deepEqual(bedarf.konten, []);
});

test('ein Mitgliederwechsel zieht alle Konten mit Geraet herein', () => {
  const bedarf = nachlieferBedarf(
    stand({ mitglieder: ['anna'], beliefert: ['anna-handy'] }),
    ['anna', 'bert'],
    liste,
    'anna',
    'anna-hier',
    2000
  );
  assert.deepEqual(bedarf.konten, ['anna', 'bert']);
  assert.equal(bedarf.grund, 'mitgliederwechsel');
});

test('eine ueberalterte Sitzung zieht ebenfalls alle herein', () => {
  const bedarf = nachlieferBedarf(
    stand({ beliefert: ['anna-handy', 'bert-1'], angelegtAm: 0 }),
    ['anna', 'bert'],
    liste,
    'anna',
    'anna-hier',
    8 * 24 * 60 * 60 * 1000
  );
  assert.deepEqual(bedarf.konten, ['anna', 'bert']);
  assert.equal(bedarf.grund, 'alter');
});

test('ein Mitglied ohne veroeffentlichtes Geraet kostet keinen claim', () => {
  const bedarf = nachlieferBedarf(
    stand({ mitglieder: ['anna', 'bert', 'cara'], beliefert: ['anna-handy', 'bert-1'] }),
    ['anna', 'bert', 'cara'],
    liste,
    'anna',
    'anna-hier',
    2000
  );
  assert.deepEqual(bedarf.konten, []);
});

test('nur das eigene Konto, nur das eigene aktuelle Geraet: nichts zu tun', () => {
  const bedarf = nachlieferBedarf(
    stand({ mitglieder: ['anna'], beliefert: [] }),
    ['anna'],
    { anna: ['anna-hier'] },
    'anna',
    'anna-hier',
    2000
  );
  assert.deepEqual(bedarf.konten, []);
});
