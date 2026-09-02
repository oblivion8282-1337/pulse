import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baueNachrichtNutzlast,
  leseNachrichtNutzlast
} from '../src/lib/krypto/nachrichtNutzlast.ts';

test('Autor-ID und Antwort-Kennung ueberstehen Hin- und Rueckweg', () => {
  const bytes = baueNachrichtNutzlast('hallo zurueck', 'msg-1', '123456789');
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.text, 'hallo zurueck');
  assert.equal(gelesen.id, 'msg-1');
  assert.equal(gelesen.replyToId, '123456789');
});

test('ohne Antwortbezug bleibt replyToId null, id bleibt gesetzt', () => {
  const bytes = baueNachrichtNutzlast('einfacher text', 'msg-2', null);
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.text, 'einfacher text');
  assert.equal(gelesen.id, 'msg-2');
  assert.equal(gelesen.replyToId, null);
});

test('eine Nutzlast OHNE die neuen Felder wird weiterhin gelesen (aeltere Fassung 1)', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, text: 'ohne felder' }));
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.text, 'ohne felder');
  assert.equal(gelesen.id, null);
  assert.equal(gelesen.replyToId, null);
});

test('Legacy: reiner Klartext ohne jede Huelle bleibt lesbar', () => {
  // Ein Sender von vor dieser Aenderung schickte den Klartext ohne JSON-
  // Huelle. Das darf beim Lesen nicht scheitern.
  const bytes = new TextEncoder().encode('ganz normaler text, kein json');
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.text, 'ganz normaler text, kein json');
  assert.equal(gelesen.id, null);
  assert.equal(gelesen.replyToId, null);
});

test('Legacy-Text, der zufaellig wie JSON aussieht, bleibt trotzdem Text', () => {
  const bytes = new TextEncoder().encode('{nicht wirklich json}');
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.text, '{nicht wirklich json}');
  assert.equal(gelesen.id, null);
  assert.equal(gelesen.replyToId, null);
});
