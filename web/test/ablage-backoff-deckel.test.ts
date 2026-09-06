import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffDeckel } from '../src/lib/ablage/backoffDeckel.ts';

const schlafe = (ms: number) => new Promise((f) => setTimeout(f, ms));

test('ein unbekannter Schlüssel ist sofort fällig', () => {
  const d = backoffDeckel();
  assert.equal(d.istFaellig('kanal-1'), true);
});

test('nach einem Fehlschlag ist er gesperrt', () => {
  const d = backoffDeckel();
  d.vermerkeFehlschlag('kanal-1');
  assert.equal(d.istFaellig('kanal-1'), false);
});

test('ein Erfolg hebt die Sperre sofort auf', () => {
  // Wichtig, weil sonst ein Laufwerk, das sich erholt hat, noch minutenlang
  // ausgesperrt bliebe — der Deckel wächst schnell.
  const d = backoffDeckel();
  d.vermerkeFehlschlag('kanal-1');
  d.vermerkeFehlschlag('kanal-1');
  d.vermerkeErfolg('kanal-1');
  assert.equal(d.istFaellig('kanal-1'), true);
});

test('die Schlüssel stören einander nicht', () => {
  const d = backoffDeckel();
  d.vermerkeFehlschlag('kanal-1');
  assert.equal(d.istFaellig('kanal-1'), false);
  assert.equal(d.istFaellig('kanal-2'), true);
});

test('der Deckel greift wirklich — sonst wächst die Sperre ins Unerreichbare', async () => {
  // Das ist der einzige Fall, den man ohne den Deckel nicht mehr abwarten
  // könnte: bei zwanzig Fehlversuchen läge die ungedeckelte Verdopplung
  // (1 s mal 2^20) bei über zwölf Tagen. Mit einem Deckel von 5 ms ist die
  // Sperre nach wenigen Millisekunden vorbei — und genau das prüft dieser
  // Test, statt die Formel abzuschreiben.
  const d = backoffDeckel(5);
  for (let i = 0; i < 20; i++) d.vermerkeFehlschlag('kanal-1');
  assert.equal(d.istFaellig('kanal-1'), false);
  await schlafe(20);
  assert.equal(d.istFaellig('kanal-1'), true);
});

test('die Sperre läuft von selbst ab, ohne Erfolgsmeldung', async () => {
  // Der Regelfall: niemand meldet Erfolg, der nächste Durchlauf soll es
  // trotzdem irgendwann wieder versuchen.
  const d = backoffDeckel(5);
  d.vermerkeFehlschlag('kanal-1');
  await schlafe(20);
  assert.equal(d.istFaellig('kanal-1'), true);
});
