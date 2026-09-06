import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quittierbareIds, type KanalGruppe } from '../src/lib/krypto/quittierbareIds.ts';

// FIX 1 (Bughunt 2026-08-28): eine Zustellung, die zwar entschluesselt aber
// lokal NICHT abgelegt werden konnte, darf NICHT quittiert werden — die
// Quittung loescht die einzige Kopie auf dem Server.

test('nur Kanaele mit erfolgreicher Ablage landen in der Quittungsliste', async () => {
  const nachKanal = new Map<string, KanalGruppe>([
    ['kanal-ok', { nachrichten: ['a'], ids: ['id-1', 'id-2'] }],
    ['kanal-kaputt', { nachrichten: ['b'], ids: ['id-3'] }]
  ]);

  const gemeldet: unknown[] = [];
  const ergebnis = await quittierbareIds(
    nachKanal,
    async (kanalId) => {
      if (kanalId === 'kanal-kaputt') throw new Error('IndexedDB voll');
    },
    (err) => gemeldet.push(err)
  );

  assert.deepEqual(ergebnis, ['id-1', 'id-2']);
  assert.equal(gemeldet.length, 1);
});

test('ein Fehlschlag in einer Gruppe unterbricht die anderen Gruppen nicht', async () => {
  const nachKanal = new Map<string, KanalGruppe>([
    ['zuerst-kaputt', { nachrichten: [], ids: ['id-1'] }],
    ['danach-ok', { nachrichten: [], ids: ['id-2'] }]
  ]);

  const versucht: string[] = [];
  const ergebnis = await quittierbareIds(
    nachKanal,
    async (kanalId) => {
      versucht.push(kanalId);
      if (kanalId === 'zuerst-kaputt') throw new Error('kaputt');
    },
    () => {}
  );

  assert.deepEqual(versucht, ['zuerst-kaputt', 'danach-ok']);
  assert.deepEqual(ergebnis, ['id-2']);
});

test('schlagen alle Gruppen fehl, ist die Quittungsliste leer', async () => {
  const nachKanal = new Map<string, KanalGruppe>([
    ['a', { nachrichten: [], ids: ['id-1'] }],
    ['b', { nachrichten: [], ids: ['id-2'] }]
  ]);

  const ergebnis = await quittierbareIds(
    nachKanal,
    async () => {
      throw new Error('kaputt');
    },
    () => {}
  );

  assert.deepEqual(ergebnis, []);
});
