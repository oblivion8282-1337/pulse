import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freigabeHinweis } from '../src/lib/remote/freigabeText.ts';

test('erteilt heißt: nichts zu erklären', () => {
  assert.equal(freigabeHinweis(''), null);
});

test('die beiden Freigaben führen an verschiedene Stellen', () => {
  const a = freigabeHinweis('bedienungshilfen');
  const b = freigabeHinweis('eingabeueberwachung:denied');
  assert.ok(a && b);
  assert.match(a.pfad, /Bedienungshilfen$/);
  assert.match(b.pfad, /Eingabeüberwachung$/);
  // Der eigentliche Fehler wäre, beide auf dieselbe Einstellung zu schicken —
  // dann sucht der Nutzer den Haken, der schon gesetzt ist.
  assert.notEqual(a.pfad, b.pfad);
});

test('beim Mithören steht der Grund dabei, warum es abgeschaltet bleibt', () => {
  const h = freigabeHinweis('eingabeueberwachung:denied');
  assert.ok(h);
  // Ohne diese Begründung sieht die Verweigerung wie Schikane aus.
  assert.match(h.erklaerung, /zurück/);
});

test('"ungefragt" bekommt den Zusatz, "denied" nicht', () => {
  const u = freigabeHinweis('eingabeueberwachung:ungefragt');
  const d = freigabeHinweis('eingabeueberwachung:denied');
  assert.ok(u && d);
  assert.match(u.erklaerung, /erst, nachdem einmal eine Sitzung versucht wurde/);
  assert.doesNotMatch(d.erklaerung, /erst, nachdem einmal eine Sitzung versucht wurde/);
});

test('ein unbekannter Grund wird durchgereicht, nicht verschluckt', () => {
  const h = freigabeHinweis('irgendwas-neues:42');
  assert.ok(h);
  assert.match(h.erklaerung, /irgendwas-neues:42/);
});

test('jeder Hinweis nennt die Signatur-Falle', () => {
  for (const g of ['bedienungshilfen', 'eingabeueberwachung:denied']) {
    const h = freigabeHinweis(g);
    assert.ok(h, g);
    assert.match(h.erklaerung, /entfernt und neu gesetzt/, g);
  }
});
