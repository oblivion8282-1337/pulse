import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vergleichRollen } from '../src/lib/permissions/bitfield.ts';

const rolle = (id: string, position: number, is_everyone = false) => ({
  id,
  position,
  is_everyone
});

test('@everyone kommt immer zuerst', () => {
  const sortiert = [rolle('20', 5), rolle('10', 0, true)].sort(vergleichRollen);
  assert.deepEqual(
    sortiert.map((r) => r.id),
    ['10', '20']
  );
});

test('sonst entscheidet die Position, aufsteigend', () => {
  const sortiert = [rolle('30', 9), rolle('20', 1), rolle('40', 5)].sort(vergleichRollen);
  assert.deepEqual(
    sortiert.map((r) => r.id),
    ['20', '40', '30']
  );
});

// Der Grund für den dritten Schlüssel: der Server sortiert mit
// `key=(not is_everyone, position, id)`. Ohne die Kennung hing die Reihenfolge
// hier an der Eingangsreihenfolge — bei gegenläufigen Kanal-Überschreibungen
// rechnete die Oberfläche dann etwas anderes aus als der Server.
test('bei gleicher Position entscheidet die Kennung, unabhaengig von der Eingangsreihenfolge', () => {
  const eineRichtung = [rolle('300', 3), rolle('100', 3), rolle('200', 3)].sort(vergleichRollen);
  const andereRichtung = [rolle('200', 3), rolle('300', 3), rolle('100', 3)].sort(vergleichRollen);
  assert.deepEqual(
    eineRichtung.map((r) => r.id),
    ['100', '200', '300']
  );
  assert.deepEqual(
    andereRichtung.map((r) => r.id),
    eineRichtung.map((r) => r.id)
  );
});

// Snowflakes sind nicht gleich lang. Alphabetisch stünde "9" hinter "10" —
// deshalb vergleicht der Komparator als Zahl.
test('die Kennung wird als Zahl verglichen, nicht als Zeichenkette', () => {
  const sortiert = [rolle('10', 1), rolle('9', 1)].sort(vergleichRollen);
  assert.deepEqual(
    sortiert.map((r) => r.id),
    ['9', '10']
  );
});

test('echte Snowflakes gleicher Position ordnen sich nach ihrem Alter', () => {
  const aelter = '7100000000000000000';
  const juenger = '7200000000000000000';
  const sortiert = [rolle(juenger, 2), rolle(aelter, 2)].sort(vergleichRollen);
  assert.deepEqual(
    sortiert.map((r) => r.id),
    [aelter, juenger]
  );
});
