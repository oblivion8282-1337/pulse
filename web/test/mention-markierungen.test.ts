import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMentionMarkers,
  bestaetigteMentionHrefs,
} from '../src/lib/components/mentionMarkierungen.ts';

/**
 * Der verschluesselte DM-Weg (`krypto/senden.ts`/`empfangen.ts`, Bughunt
 * 2026-08-28, Befund 3) hat KEINE serverseitige Mention-Erkennung — diese
 * Rechnung ist dort die EINZIGE Quelle fuer `Message.mentions`. Ohne sie
 * bleibt die Draht-Markierung `<@id>` roh im Text stehen und `renderMessage`
 * (`messageRender.ts`) macht ohne `mentions` nichts damit (s. dessen
 * `mentions && mentions.length > 0`-Weiche) — der Betrachter sieht die
 * interne Snowflake im Klartext. Diese Tests halten die reine Rechnung fest,
 * die senden.ts/empfangen.ts selbst NICHT unit-testbar ist (importieren
 * `.svelte.ts`-Module mit Modulebene-`$state`, s. CLAUDE.md).
 */

test('kein Marker im Text -> leere Liste', () => {
  assert.deepEqual(parseMentionMarkers('hallo, wie gehts?'), []);
});

test('ein Nutzer-Marker wird erkannt', () => {
  assert.deepEqual(parseMentionMarkers('hallo <@123456789012345678>'), [
    { type: 0, id: '123456789012345678' }
  ]);
});

test('ein Rollen-Marker wird erkannt, nicht mit dem Nutzer-Marker verwechselt', () => {
  assert.deepEqual(parseMentionMarkers('<@&987>'), [{ type: 1, id: '987' }]);
});

test('@everyone/@here werden als Sentinel-ID "0" erkannt', () => {
  assert.deepEqual(parseMentionMarkers('achtung @everyone'), [{ type: 2, id: '0' }]);
  assert.deepEqual(parseMentionMarkers('@here bitte melden'), [{ type: 2, id: '0' }]);
});

test('Duplikate desselben Markers erscheinen nur einmal', () => {
  assert.deepEqual(parseMentionMarkers('<@1> und nochmal <@1>'), [{ type: 0, id: '1' }]);
});

test('bestaetigteMentionHrefs — nur die Hrefs der Parse-Ergebnisse (Spoof-Schutz)', () => {
  // Security-Scan 2026-09-18: der DOMPurify-Hook pill-ifiziert nur, was in
  // dieser Menge steht — manuell getipptes `[Admin](mention:user:123)` matcht
  // NICHT und wird zu Text entkleidet.
  const hrefs = bestaetigteMentionHrefs(parseMentionMarkers('hi <@42> <@&7> @everyone'));
  assert.equal(hrefs.has('mention:user:42'), true);
  assert.equal(hrefs.has('mention:role:7'), true);
  assert.equal(hrefs.has('mention:everyone:0'), true);
  // Ein NICHT erwähnter Nutzer (hier: 123) ist nicht zugelassen — genau das
  // ist der gefälschte `[Admin](mention:user:123 "self")`-Fall.
  assert.equal(hrefs.has('mention:user:123'), false);
  assert.equal(hrefs.size, 3);
});

test('bestaetigteMentionHrefs — leere Mention-Liste lässt keine Pille zu', () => {
  assert.equal(bestaetigteMentionHrefs([]).size, 0);
  assert.equal(bestaetigteMentionHrefs([{ type: 0, id: '1' }]).has('mention:role:1'), false);
});

test('mehrere verschiedene Marker in Reihenfolge Nutzer -> Rolle -> everyone', () => {
  assert.deepEqual(parseMentionMarkers('<@1> <@&2> @everyone'), [
    { type: 0, id: '1' },
    { type: 1, id: '2' },
    { type: 2, id: '0' }
  ]);
});
