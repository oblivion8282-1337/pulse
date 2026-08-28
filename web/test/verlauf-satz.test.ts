import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zuSatz, sortierSchluessel } from '../src/lib/verlauf/satz.ts';

test('Sortierschluessel ordnet nach Nachrichten-ID, nicht als Zahl', () => {
  // Snowflakes sind Zeichenketten, weil sie als Zahl nicht exakt sind. Ein
  // Schluessel, der sie ungepolstert aneinanderhaengt, sortiert "9" hinter
  // "10" — und der Verlauf stuende in falscher Reihenfolge da.
  const a = sortierSchluessel('k1', '9');
  const b = sortierSchluessel('k1', '10');
  assert.ok(a < b, `${a} muesste vor ${b} stehen`);
});

test('Sortierschluessel trennt Kanaele', () => {
  assert.notEqual(sortierSchluessel('k1', '5'), sortierSchluessel('k2', '5'));
});

test('zuSatz weist Fremdmaterial ab statt es abzulegen', () => {
  // fail-closed: was nicht wie eine Nachricht aussieht, wird nicht
  // gespeichert. Sonst faellt der Fehler erst beim Lesen auf, Wochen spaeter.
  assert.equal(zuSatz('k1', null), null);
  assert.equal(zuSatz('k1', {}), null);
  assert.equal(zuSatz('k1', { id: 5, content: 'x' }), null); // id muss Zeichenkette sein
});

test('zuSatz uebernimmt genau die gebrauchten Felder', () => {
  const satz = zuSatz('k1', {
    id: '42', author_id: '7', content: 'hallo',
    created_at: '2026-08-28T00:00:00Z', edited_at: null,
    attachments: [], unerwartet: 'wird nicht uebernommen',
  });
  assert.ok(satz);
  assert.equal(satz.nachrichtId, '42');
  assert.equal(satz.inhalt, 'hallo');
  assert.equal(satz.geloescht, false);
  assert.ok(!('unerwartet' in satz));
});

test('eine geloeschte Nachricht bleibt als Grabstein', () => {
  // Sonst taucht sie beim naechsten Abgleich wieder auf.
  const satz = zuSatz('k1', {
    id: '43', author_id: '7', content: '',
    created_at: '2026-08-28T00:00:00Z', deleted_at: '2026-08-28T01:00:00Z',
    attachments: [],
  });
  assert.ok(satz);
  assert.equal(satz.geloescht, true);
});
