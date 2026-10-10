import { test } from 'node:test';
import assert from 'node:assert/strict';

import { audioSessionTyp, wegAntwort, zielModus } from '../src/lib/platform/tonModus.ts';

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

test('eigene Einrichtung loest keine weitere aus', () => {
	// Der Kern des Befunds vom 2026-10-10: `setCategory`/`setActive` melden
	// selbst einen Routenwechsel. Gleicher Tonweg = nichts zu tun.
	assert.equal(wegAntwort(true, 'eingebaut', 'eingebaut'), 'ignorieren');
});

test('echter Wechsel richtet neu ein', () => {
	assert.equal(wegAntwort(true, 'funk', 'eingebaut'), 'neu-einrichten');
	assert.equal(wegAntwort(true, 'eingebaut', 'kabel'), 'neu-einrichten');
});

test('unbekannter Ausgangszustand ist kein Wechsel', () => {
	// Sonst richtete der erste gemeldete Wechsel nach jedem Start grundlos neu
	// ein — und zwar mitten in den Beitritt hinein.
	assert.equal(wegAntwort(true, 'funk', null), 'uebernehmen');
});

test('ohne Mikrofon wird nur mitgeschrieben', () => {
	// Die Wiedergabe-Kategorie richtet sich nicht nach dem Weg. Mitschreiben
	// statt ignorieren, damit der naechste Beitritt den Stand kennt.
	assert.equal(wegAntwort(false, 'funk', 'eingebaut'), 'uebernehmen');
	assert.equal(wegAntwort(false, 'eingebaut', 'eingebaut'), 'uebernehmen');
});

// --- Bughunt 2026-10-11: K2 (nativer Raum) und G2 (Merken erst nach Gelingen)

import { NACH_NATIVEM_RAUM, tonSchritt } from '../src/lib/platform/tonModus.ts';

const schritt = (teil: Partial<Parameters<typeof tonSchritt>[0]> = {}) =>
  tonSchritt({ ziel: 'wiedergabe', angewandt: 'aus', nativerRaum: false, erzwingen: false, ...teil });

test('K2: steht der native Raum, wird die Session NICHT angefasst — weder Stream noch Abmelden', () => {
  // Stream an waehrend des nativen Sprachkanals: vorher `.playback` auf
  // LiveKits Session (kein Eingang mehr).
  assert.equal(schritt({ ziel: 'wiedergabe', angewandt: 'aus', nativerRaum: true }), 'nichts');
  // Stream wieder zu: vorher `setActive(false)` mitten im Gespraech.
  assert.equal(schritt({ ziel: 'aus', angewandt: 'wiedergabe', nativerRaum: true }), 'nichts');
  // Direktanruf neben dem nativen Kanal: vorher `.defaultToSpeaker` neu.
  assert.equal(schritt({ ziel: 'voice', angewandt: 'aus', nativerRaum: true }), 'nichts');
  // Auch ein erzwungenes Neueinrichten (AirPods rein) wartet.
  assert.equal(schritt({ ziel: 'voice', angewandt: 'voice', nativerRaum: true, erzwingen: true }), 'nichts');
});

test('K2: nach dem nativen Raum gilt die Session als aus — ein laufender Stream wird neu eingerichtet', () => {
  // LiveKit deaktiviert beim Verlassen selbst. Laeuft noch ein Stream, muss
  // er seine Session zurueckbekommen; laeuft nichts, bleibt es dabei.
  assert.equal(NACH_NATIVEM_RAUM, 'aus');
  assert.equal(schritt({ ziel: 'wiedergabe', angewandt: NACH_NATIVEM_RAUM }), 'anwenden');
  assert.equal(schritt({ ziel: 'aus', angewandt: NACH_NATIVEM_RAUM }), 'nichts');
});

test('G2: was nicht angewandt ist, wird beim naechsten Anlass erneut versucht', () => {
  // `angewandt` bleibt nach einem Fehlschlag auf dem alten Wert — gleiches
  // Ziel beim naechsten Anlass ergibt also wieder `anwenden`.
  assert.equal(schritt({ ziel: 'voice', angewandt: 'aus' }), 'anwenden');
  assert.equal(schritt({ ziel: 'voice', angewandt: 'voice' }), 'nichts');
  assert.equal(schritt({ ziel: 'voice', angewandt: 'voice', erzwingen: true }), 'anwenden');
});
