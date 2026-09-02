import { test } from 'node:test';
import assert from 'node:assert/strict';

import { brauchtLokalenVerlauf } from '../src/lib/verlauf/ablageEntscheidung.ts';

// `verlauf/index.ts::istAblageKanal` selbst ist wegen der Rune-Speicher
// (`guilds.svelte`) in Nodes Testlaeufer nicht direkt ladbar (CLAUDE.md
// „Die Falle"). Geprueft wird deshalb die reine Weiche, die sowohl
// `hatServerVerlauf()` (Nachladen/Hochscrollen) als auch der erste
// Ladeschritt der Community-Kanalseite (`+page.svelte::switchTo`) darueber
// treffen — die eigentliche Fehlerklasse aus Aufgabe 5b: ein Ablage-Kanal
// muss "lokal", ein gewoehnlicher Kanal "vom Server" ergeben, sonst
// schickt entweder das Oeffnen keinen lokalen Verlauf oder das Hochscrollen
// eine vom Server abgewiesene Anfrage.

test('ein Ablage-Kanal braucht bei eingeschaltetem Merkmal den lokalen Verlauf', () => {
  assert.equal(brauchtLokalenVerlauf(true, { ablage: true }), true);
});

test('ein gewoehnlicher Kanal bleibt beim Server, Merkmal an oder aus', () => {
  assert.equal(brauchtLokalenVerlauf(true, { ablage: false }), false);
  assert.equal(brauchtLokalenVerlauf(false, { ablage: false }), false);
});

test('der Schalter ist ein Schalter, kein Versteck: aus bleibt auch ein Ablage-Kanal beim Server', () => {
  assert.equal(brauchtLokalenVerlauf(false, { ablage: true }), false);
});

test('ein unbekannter/fehlender Kanal (noch nicht geladen) faellt auf "Server" zurueck', () => {
  assert.equal(brauchtLokalenVerlauf(true, undefined), false);
  assert.equal(brauchtLokalenVerlauf(true, null), false);
});
