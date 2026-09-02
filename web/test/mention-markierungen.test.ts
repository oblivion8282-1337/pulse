import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMentionMarkers } from '../src/lib/components/mentionMarkierungen.ts';

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

test('mehrere verschiedene Marker in Reihenfolge Nutzer -> Rolle -> everyone', () => {
  assert.deepEqual(parseMentionMarkers('<@1> <@&2> @everyone'), [
    { type: 0, id: '1' },
    { type: 1, id: '2' },
    { type: 2, id: '0' }
  ]);
});
