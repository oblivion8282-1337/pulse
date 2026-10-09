import { test } from 'node:test';
import assert from 'node:assert/strict';

import { audioSessionTyp, zielModus } from '../src/lib/platform/tonModus.ts';

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

test('Voice meldet WebKit play-and-record — nur das traegt ein Mikrofon', () => {
	assert.equal(audioSessionTyp('voice'), 'play-and-record');
});

test('reine Wiedergabe meldet playback — geht am Klingelton-Schalter vorbei', () => {
	assert.equal(audioSessionTyp('wiedergabe'), 'playback');
});

test('ohne Ton KEINE Aussage: auto, nicht ambient', () => {
	// `ambient` waere eine Behauptung (mischbar, stummschaltbar). Ohne
	// Verbraucher wollen wir die Vorgabe zurueckgeben, nicht etwas Falsches.
	assert.equal(audioSessionTyp('aus'), 'auto');
});
