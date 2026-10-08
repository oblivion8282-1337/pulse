import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zielModus } from '../src/lib/platform/tonModus.ts';

test('nichts laeuft -> Session aus', () => {
	assert.equal(zielModus(false, 0), 'aus');
});

test('nur Sprachkanal -> voice', () => {
	assert.equal(zielModus(true, 0), 'voice');
});

test('nur Stream-Ton -> wiedergabe', () => {
	assert.equal(zielModus(false, 1), 'wiedergabe');
});

test('beides -> voice gewinnt', () => {
	// `playAndRecord`+`voiceChat` traegt Wiedergabe mit, `playback` traegt
	// kein Mikrofon. Die staerkere Betriebsart ist die, die beides kann.
	assert.equal(zielModus(true, 2), 'voice');
});

test('Sprachkanal verlassen waehrend ein Stream laeuft -> wiedergabe, nicht aus', () => {
	// Der Fehler aus dem Review 08.10.: hier stand vorher `setActive(false)`
	// und riss den laufenden Stream-Ton mit, weil die Session prozessweit gilt.
	assert.equal(zielModus(false, 1), 'wiedergabe');
});

test('letzter Stream endet ohne Sprachkanal -> aus', () => {
	assert.equal(zielModus(false, 0), 'aus');
});
