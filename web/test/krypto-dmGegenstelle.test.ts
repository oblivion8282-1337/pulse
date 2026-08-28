import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dmGegenstelle } from '../src/lib/krypto/dmGegenstelle.ts';

test('Absender ist die Gegenstelle, wenn er nicht man selbst ist', () => {
  assert.equal(dmGegenstelle('andere-person', 'ich', undefined), 'andere-person');
});

test('eigenes anderes Geraet als Absender -> bekannter Kanal-Gegenpart', () => {
  // Vom eigenen Handy gesendet, hier auf dem Desktop empfangen: der Absender
  // (`author_id`) ist man selbst, die Gegenstelle bleibt der DM-Partner.
  assert.equal(dmGegenstelle('ich', 'ich', 'dm-partner'), 'dm-partner');
});

test('eigenes anderes Geraet, aber Kanal noch nicht lokal bekannt -> keine Gegenstelle', () => {
  // Druckfrische DM: der lokale Store kennt den Kanal noch nicht — der
  // Bump wird ausgelassen, der naechste hydrate/ready holt es nach.
  assert.equal(dmGegenstelle('ich', 'ich', undefined), null);
});
