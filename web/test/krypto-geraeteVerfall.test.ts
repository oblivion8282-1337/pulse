import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istVerfallsSignal, verfallAbarbeiten } from '../src/lib/krypto/geraeteVerfall.ts';

/** Zaehlt mit, ob geloescht wurde — der Verlauf ist die einzige Kopie, jeder
 *  dieser Tests fragt am Ende dasselbe: wurde er zu Recht angefasst? */
function aufbau(holen: () => Promise<{ stand?: unknown }>) {
  let geloescht = 0;
  let gemeldet = 0;
  return {
    lauf: () =>
      verfallAbarbeiten(
        holen,
        async () => {
          geloescht += 1;
        },
        () => {
          gemeldet += 1;
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
  assert.equal(await t.lauf(), false);
  assert.equal(t.zahl(), 0);
  assert.equal(t.meldungen(), 0);
});

test('der eindeutige Verfalls-Fall loescht ihn', async () => {
  const t = aufbau(async () => ({ stand: 'verfallen' }));
  assert.equal(await t.lauf(), true);
  assert.equal(t.zahl(), 1);
  assert.equal(t.meldungen(), 1);
});

test('ein gueltiges Geraet loescht nichts', async () => {
  const t = aufbau(async () => ({ stand: 'gueltig' }));
  assert.equal(await t.lauf(), false);
  assert.equal(t.zahl(), 0);
});

test('„unbekannt" ist KEIN Verfall', async () => {
  // Der frische Browser (nichts zu loeschen) und die durch die
  // Geraete-Obergrenze verdraengte Zeile sehen beide so aus. Beides darf
  // nichts ausloesen.
  const t = aufbau(async () => ({ stand: 'unbekannt' }));
  assert.equal(await t.lauf(), false);
  assert.equal(t.zahl(), 0);
});

test('eine kaputte oder fremde Antwort loescht nichts', async () => {
  for (const antwort of [{}, { stand: null }, { stand: 42 }, { stand: 'VERFALLEN' }]) {
    const t = aufbau(async () => antwort as { stand?: unknown });
    assert.equal(await t.lauf(), false, JSON.stringify(antwort));
    assert.equal(t.zahl(), 0);
  }
});

test('istVerfallsSignal nimmt nur genau dieses eine Wort', () => {
  assert.equal(istVerfallsSignal({ stand: 'verfallen' }), true);
  assert.equal(istVerfallsSignal({ stand: 'gueltig' }), false);
  assert.equal(istVerfallsSignal(null), false);
  assert.equal(istVerfallsSignal(undefined), false);
});
