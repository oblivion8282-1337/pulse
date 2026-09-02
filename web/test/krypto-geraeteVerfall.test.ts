import { test } from 'node:test';
import assert from 'node:assert/strict';

import { geraetestandAbarbeiten, loeschGrund } from '../src/lib/krypto/geraeteVerfall.ts';

/** Zaehlt mit, ob geloescht wurde — der Verlauf ist die einzige Kopie, jeder
 *  dieser Tests fragt am Ende dasselbe: wurde er zu Recht angefasst? */
function aufbau(holen: () => Promise<{ stand?: unknown }>) {
  let geloescht = 0;
  const gemeldet: string[] = [];
  return {
    lauf: () =>
      geraetestandAbarbeiten(
        holen,
        async () => {
          geloescht += 1;
        },
        (grund) => {
          gemeldet.push(grund);
        }
      ),
    zahl: () => geloescht,
    meldungen: () => gemeldet
  };
}

test('ein Netzwerkfehler loescht KEINEN Verlauf', async () => {
  // Die wichtigste Zeile dieser Datei. Ein Fehlschlag heisst „ich weiss es
  // nicht", nie „verfallen" — sonst raeumt ein Serverausfall die Verlaeufe
  // aller Browser ab, und zwar unumkehrbar.
  const t = aufbau(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(await t.lauf(), null);
  assert.equal(t.zahl(), 0);
  assert.deepEqual(t.meldungen(), []);
});

test('der eindeutige Verfalls-Fall loescht ihn', async () => {
  const t = aufbau(async () => ({ stand: 'verfallen' }));
  assert.equal(await t.lauf(), 'verfallen');
  assert.equal(t.zahl(), 1);
  assert.deepEqual(t.meldungen(), ['verfallen']);
});

test('ein entferntes Geraet loescht ihn ebenfalls — mit eigenem Grund', async () => {
  // Dieselbe Abfrage traegt beide Faelle (Spec §3b Punkt 4). Geloescht wird
  // gleich, gemeldet verschieden: „abgelaufen" waere an einem gerade
  // entfernten Geraet schlicht falsch.
  const t = aufbau(async () => ({ stand: 'entfernt' }));
  assert.equal(await t.lauf(), 'entfernt');
  assert.equal(t.zahl(), 1);
  assert.deepEqual(t.meldungen(), ['entfernt']);
});

test('ein gueltiges Geraet loescht nichts', async () => {
  const t = aufbau(async () => ({ stand: 'gueltig' }));
  assert.equal(await t.lauf(), null);
  assert.equal(t.zahl(), 0);
});

test('„unbekannt" ist KEIN Verfall', async () => {
  // Der frische Browser (nichts zu loeschen) und die durch die
  // Geraete-Obergrenze verdraengte Zeile sehen beide so aus. Beides darf
  // nichts ausloesen.
  const t = aufbau(async () => ({ stand: 'unbekannt' }));
  assert.equal(await t.lauf(), null);
  assert.equal(t.zahl(), 0);
});

test('eine kaputte oder fremde Antwort loescht nichts', async () => {
  for (const antwort of [
    {},
    { stand: null },
    { stand: 42 },
    { stand: 'VERFALLEN' },
    { stand: 'ENTFERNT' },
    { stand: 'geloescht' }
  ]) {
    const t = aufbau(async () => antwort as { stand?: unknown });
    assert.equal(await t.lauf(), null, JSON.stringify(antwort));
    assert.equal(t.zahl(), 0);
  }
});

test('loeschGrund nimmt genau die beiden Woerter', () => {
  assert.equal(loeschGrund({ stand: 'verfallen' }), 'verfallen');
  assert.equal(loeschGrund({ stand: 'entfernt' }), 'entfernt');
  assert.equal(loeschGrund({ stand: 'gueltig' }), null);
  assert.equal(loeschGrund(null), null);
  assert.equal(loeschGrund(undefined), null);
});
