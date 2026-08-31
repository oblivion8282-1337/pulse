import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anstossHuelle, leitungsHuelle } from '../src/lib/remote/ablageHuelle.ts';

test('ein Anstoss und ein Leitungsrahmen tragen verschiedene Schluessel', () => {
  // Das ist der ganze Schutz: der Player entscheidet an der Huelle, nicht an
  // der Form der Nutzlast (`app/ablage/lage.rs::deuten`).
  assert.deepEqual(anstossHuelle('ende'), { anstoss: 'ende' });
  assert.deepEqual(anstossHuelle('neu_bitte'), { anstoss: 'neu_bitte' });
  assert.deepEqual(leitungsHuelle({ t: 'neu', gen: 1, typ: 'text' }), {
    rahmen: { t: 'neu', gen: 1, typ: 'text' },
  });
});

test('fremde Nutzlast kann keinen Anstoss ausloesen', () => {
  // Die Gegenstelle schickt genau das, was frueher ein Anstoss WAR. Ein
  // fremdes `{"t":"ende"}` schaltete die Zwischenablage fuer den Rest der
  // Sitzung ab, ohne Log und ohne sichtbare Ursache.
  for (const boese of [{ t: 'ende' }, { t: 'neu_bitte' }, { anstoss: 'ende' }]) {
    const huelle = leitungsHuelle(boese) as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(huelle, 'anstoss'),
      false,
      `fremde Nutzlast darf nie unter "anstoss" landen: ${JSON.stringify(huelle)}`,
    );
    assert.deepEqual(huelle.rahmen, boese, 'sie liegt unveraendert unter "rahmen"');
  }
});

test('die Nutzlast wird nicht gedeutet und nicht kopiert', () => {
  // Dieses Modul parst den Rahmen NICHT — das Format lebt an genau einer
  // Stelle im Baum (`streaming/pulse-ablage`). Eine Kopie hier liefe
  // auseinander.
  const roh = { t: 'stueck', id: 1, i: 0, n: 1, d: 'aGFsbG8=' };
  const huelle = leitungsHuelle(roh) as { rahmen: unknown };
  assert.equal(huelle.rahmen, roh, 'dieselbe Referenz, kein Nachbau');
});
