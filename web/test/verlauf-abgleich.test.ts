import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ermittleGeloeschteIds } from '../src/lib/verlauf/abgleich.ts';

test('eine ID, die lokal vorhanden ist und beim Server auftaucht, gilt nicht als geloescht', () => {
  const lokal = [{ id: '1' }, { id: '2' }];
  const vomServer = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer), []);
});

test('eine lokal vorhandene ID, die beim Server fehlt, gilt als geloescht', () => {
  // Kern von Bughunt Fund 3: eine aeltere, bereits lokal ausgelieferte Seite
  // wurde nie gegen den Server abgeglichen — eine zwischenzeitliche
  // Loeschung (anderes Geraet, oder waehrend dieses Geraet offline war)
  // blieb dadurch fuer immer sichtbar. Der Server liefert geloeschte
  // Nachrichten grundsaetzlich nicht aus — "fehlt in der Antwort" ist hier
  // also der Regelfall fuer eine Loeschung.
  const lokal = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const vomServer = [{ id: '1' }, { id: '3' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer), ['2']);
});

test('mehrere fehlende IDs werden alle gemeldet, in ihrer lokalen Reihenfolge', () => {
  const lokal = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
  const vomServer = [{ id: '1' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer), ['2', '3', '4']);
});

test('eine leere Serverantwort meldet jede lokale ID als geloescht', () => {
  const lokal = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, []), ['1', '2']);
});

test('eine leere lokale Seite meldet nichts', () => {
  assert.deepEqual(ermittleGeloeschteIds([], [{ id: '1' }]), []);
});
