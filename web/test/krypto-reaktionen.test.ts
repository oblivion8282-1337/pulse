/**
 * Reaktions-Umschlag fuer verschluesselte DMs (Uebergabe P1.5) — die beiden
 * importfreien Kerne: das Frame-Format (`nachrichtNutzlast.ts`) und die
 * Merge-/Anzeige-Rechnung (`reaktionen.ts`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  baueNachrichtNutzlast,
  baueReaktionsNutzlast,
  leseNachrichtNutzlast
} from '../src/lib/krypto/nachrichtNutzlast.ts';
import { reaktionAnwenden, reaktionenZuAggregat } from '../src/lib/krypto/reaktionen.ts';

describe('Reaktions-Umschlag: Nutzlast', () => {
  test('Hin- und Rueckweg traegt Ziel, Emoji und die Entfernen-Marke', () => {
    const hinzu = leseNachrichtNutzlast(baueReaktionsNutzlast('123', '👍', false));
    assert.deepEqual(hinzu.reaktion, { ziel: '123', emoji: '👍' });
    assert.equal(hinzu.text, '');
    assert.equal(hinzu.id, null);
    assert.equal(hinzu.geloescht, undefined);

    const weg = leseNachrichtNutzlast(baueReaktionsNutzlast('123', '👍', true));
    assert.deepEqual(weg.reaktion, { ziel: '123', emoji: '👍', entfernen: true });
  });

  test('eine gewoehnliche Nachricht traegt keine Reaktion', () => {
    const gelesen = leseNachrichtNutzlast(baueNachrichtNutzlast('hallo', '1', null));
    assert.equal(gelesen.reaktion, undefined);
  });

  test('fail-closed: ein Frame ohne Ziel oder Emoji ist keine Reaktion', () => {
    for (const reaktion of [{ emoji: '👍' }, { ziel: '1' }, { ziel: '', emoji: '👍' }, 'x', null]) {
      const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, text: '', reaktion }));
      assert.equal(leseNachrichtNutzlast(bytes).reaktion, undefined, JSON.stringify(reaktion));
    }
  });
});

describe('reaktionAnwenden', () => {
  test('erste Reaktion legt die Liste an', () => {
    assert.deepEqual(reaktionAnwenden(undefined, 'a', '👍', false), [
      { emoji: '👍', userId: 'a' }
    ]);
  });

  test('doppelter Umschlag (verlorene Quittung) aendert nichts — dieselbe Referenz', () => {
    const bestand = [{ emoji: '👍', userId: 'a' }];
    assert.equal(reaktionAnwenden(bestand, 'a', '👍', false), bestand);
  });

  test('zweiter Autor und zweites Emoji kommen dazu, Reihenfolge bleibt', () => {
    let zeilen = reaktionAnwenden(undefined, 'a', '👍', false);
    zeilen = reaktionAnwenden(zeilen, 'b', '👍', false);
    zeilen = reaktionAnwenden(zeilen, 'a', '🎉', false);
    assert.deepEqual(zeilen, [
      { emoji: '👍', userId: 'a' },
      { emoji: '👍', userId: 'b' },
      { emoji: '🎉', userId: 'a' }
    ]);
  });

  test('entfernen nimmt NUR den eigenen Eintrag — fremde bleiben stehen', () => {
    const bestand = [
      { emoji: '👍', userId: 'a' },
      { emoji: '👍', userId: 'b' }
    ];
    assert.deepEqual(reaktionAnwenden(bestand, 'a', '👍', true), [{ emoji: '👍', userId: 'b' }]);
  });

  test('entfernen ohne eigenen Eintrag aendert nichts — dieselbe Referenz, auch bei undefined', () => {
    const bestand = [{ emoji: '👍', userId: 'b' }];
    assert.equal(reaktionAnwenden(bestand, 'a', '👍', true), bestand);
    assert.equal(reaktionAnwenden(undefined, 'a', '👍', true), undefined);
  });
});

describe('reaktionenZuAggregat', () => {
  test('zaehlt je Emoji und markiert das eigene Konto', () => {
    const zeilen = [
      { emoji: '👍', userId: 'a' },
      { emoji: '👍', userId: 'b' },
      { emoji: '🎉', userId: 'b' }
    ];
    assert.deepEqual(reaktionenZuAggregat(zeilen, 'a'), [
      { emoji: '👍', count: 2, me: true },
      { emoji: '🎉', count: 1, me: false }
    ]);
    assert.deepEqual(reaktionenZuAggregat(zeilen, 'b'), [
      { emoji: '👍', count: 2, me: true },
      { emoji: '🎉', count: 1, me: true }
    ]);
  });

  test('leer oder fehlend ergibt eine leere Liste; ohne Konto ist nichts „meins"', () => {
    assert.deepEqual(reaktionenZuAggregat(undefined, 'a'), []);
    assert.deepEqual(reaktionenZuAggregat([], 'a'), []);
    assert.deepEqual(reaktionenZuAggregat([{ emoji: '👍', userId: 'a' }], null), [
      { emoji: '👍', count: 1, me: false }
    ]);
  });
});
